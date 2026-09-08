/**
 * A minimal Chrome DevTools Protocol client over a hand-rolled WebSocket.
 *
 * No dependency: this repo ships neither ws nor puppeteer, and the perf eval
 * runs from ~/.cookrew/bin with the same rule. Client frames are masked per
 * RFC 6455; server frames are reassembled across fragments and 16/64-bit
 * lengths, because a screenshot or a response body runs to megabytes.
 *
 * Lifted from scratchpad/qa-cdp-driver.mjs (gitignored) with one addition:
 * `on(method, listener)`, because a network waterfall is a stream of events
 * and not a sequence of awaited replies.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Where Chrome lives on this platform, or the override. */
export function chromeBinary() {
  const override = process.env.COOKREW_CHROME
  if (override) return override
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Launch a headless Chrome on an ephemeral debugging port and return the
 * process plus the DevTools endpoint. The port is read from the profile's
 * DevToolsActivePort file, which Chrome writes once it is listening.
 *
 * The profile directory is THE credential when it is signed in somewhere;
 * nothing here copies, prints or lists it.
 */
export async function launchChrome({ userDataDir, headless = true, extraArgs = [] }) {
  const binary = chromeBinary()
  if (!binary) throw new Error('no Chrome found — set COOKREW_CHROME')
  const portFile = path.join(userDataDir, 'DevToolsActivePort')
  rmSync(portFile, { force: true })
  const args = [
    ...(headless ? ['--headless=new'] : []),
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--window-size=500,900',
    ...extraArgs,
    'about:blank'
  ]
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'ignore'] })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const [port, wsPath] = readFileSync(portFile, 'utf8').split('\n')
      if (port && wsPath) {
        return { child, port: Number(port), browserWs: `ws://127.0.0.1:${port}${wsPath.trim()}` }
      }
    }
    if (child.exitCode !== null) throw new Error(`Chrome exited with ${child.exitCode} before listening`)
    await sleep(100)
  }
  child.kill('SIGKILL')
  throw new Error('Chrome did not open its debugging port in 15 s')
}

/** The first page target's socket, or a new one when the browser has none. */
export async function pageTarget(port) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  const page = list.find((target) => target.type === 'page')
  if (page) return page.webSocketDebuggerUrl
  const made = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json())
  return made.webSocketDebuggerUrl
}

export function connectCdp(wsUrl, options = {}) {
  const connectTimeoutMs = options.connectTimeoutMs ?? 10_000
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000
  const { hostname, port, pathname } = new URL(wsUrl)
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64')
    const socket = createConnection({ host: hostname, port: Number(port) })
    socket.setNoDelay(true)
    let upgraded = false
    let buffer = Buffer.alloc(0)
    let fragments = []
    let nextId = 1
    const pending = new Map()
    const listeners = new Map()
    let connectionSettled = false

    const rejectPending = (error) => {
      for (const { rej, timer } of pending.values()) {
        clearTimeout(timer)
        rej(error)
      }
      pending.clear()
    }
    const rejectConnection = (error) => {
      if (connectionSettled) return
      connectionSettled = true
      clearTimeout(connectTimer)
      reject(error)
    }
    const connectTimer = setTimeout(() => {
      rejectConnection(new Error(`CDP connect timeout after ${connectTimeoutMs}ms`))
      socket.destroy()
    }, connectTimeoutMs)

    const api = {
      send(method, params = {}, timeoutMs = commandTimeoutMs) {
        const id = nextId++
        return new Promise((res, rej) => {
          if (socket.destroyed) {
            rej(new Error(`CDP connection closed: ${method}`))
            return
          }
          const timer = setTimeout(() => {
            if (pending.delete(id)) rej(new Error(`CDP timeout: ${method}`))
          }, timeoutMs)
          pending.set(id, { res, rej, timer })
          socket.write(encodeFrame(JSON.stringify({ id, method, params })))
        })
      },
      /** Subscribe to an event. Returns the unsubscribe. */
      on(method, listener) {
        const set = listeners.get(method) ?? new Set()
        set.add(listener)
        listeners.set(method, set)
        return () => set.delete(listener)
      },
      close() {
        rejectPending(new Error('CDP connection closed'))
        socket.destroy()
      }
    }

    socket.on('connect', () => {
      socket.write(
        `GET ${pathname} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n` +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      )
    })
    socket.on('error', (error) => {
      rejectConnection(error)
      rejectPending(error)
    })
    socket.on('close', () => {
      rejectConnection(new Error('CDP socket closed before upgrade'))
      rejectPending(new Error('CDP socket closed'))
    })
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!upgraded) {
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) return
        const header = buffer.subarray(0, headerEnd).toString()
        if (!/101/.test(header.split('\r\n')[0])) {
          rejectConnection(new Error(`upgrade refused: ${header.split('\r\n')[0]}`))
          socket.destroy()
          return
        }
        const expected = createHash('sha1').update(key + WS_GUID).digest('base64')
        if (!header.includes(expected)) {
          rejectConnection(new Error('bad Sec-WebSocket-Accept'))
          socket.destroy()
          return
        }
        upgraded = true
        connectionSettled = true
        clearTimeout(connectTimer)
        buffer = buffer.subarray(headerEnd + 4)
        resolve(api)
      }
      for (;;) {
        const frame = decodeFrame(buffer)
        if (!frame) return
        buffer = buffer.subarray(frame.consumed)
        if (frame.opcode === 0x8) {
          socket.destroy()
          return
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(frame.payload, 0xa))
          continue
        }
        fragments.push(frame.payload)
        if (!frame.fin) continue
        const text = Buffer.concat(fragments).toString()
        fragments = []
        let message
        try {
          message = JSON.parse(text)
        } catch {
          continue
        }
        if (message.id !== undefined && pending.has(message.id)) {
          const { res, rej, timer } = pending.get(message.id)
          pending.delete(message.id)
          clearTimeout(timer)
          if (message.error) rej(new Error(message.error.message))
          else res(message.result)
        } else if (message.method) {
          for (const listener of listeners.get(message.method) ?? []) listener(message.params)
        }
      }
    })
  })
}

function encodeFrame(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const mask = randomBytes(4)
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4]
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, mask, masked])
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null
  const fin = (buffer[0] & 0x80) !== 0
  const opcode = buffer[0] & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  if (masked) offset += 4
  if (buffer.length < offset + length) return null
  const payload = buffer.subarray(offset, offset + length)
  return { fin, opcode, payload, consumed: offset + length }
}
