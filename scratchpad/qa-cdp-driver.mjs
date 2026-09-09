/**
 * Minimal CDP driver over a hand-rolled WebSocket client — no deps, because
 * this repo ships neither ws nor puppeteer and QA must not add runtime deps.
 * Client frames are masked per RFC 6455; server frames (screenshot payloads
 * run to megabytes) are reassembled across fragments and 16/64-bit lengths.
 */
import { createConnection } from 'node:net'
import { randomBytes, createHash } from 'node:crypto'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function connectCdp(wsUrl, options = {}) {
  const connectTimeoutMs = options.connectTimeoutMs ?? 10000
  const commandTimeoutMs = options.commandTimeoutMs ?? 30000
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
    const events = []
    const eventWaiters = []
    let connectionSettled = false

    const rejectPending = (error) => {
      for (const { rej, timer } of pending.values()) {
        clearTimeout(timer)
        rej(error)
      }
      pending.clear()
      for (const waiter of eventWaiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.rej(error)
      }
    }

    const rejectConnection = (error) => {
      if (connectionSettled) return
      connectionSettled = true
      clearTimeout(connectTimer)
      reject(error)
    }

    const connectTimer = setTimeout(() => {
      const error = new Error(`CDP connect timeout after ${connectTimeoutMs}ms`)
      rejectConnection(error)
      socket.destroy()
    }, connectTimeoutMs)

    const api = {
      send(method, params = {}, sessionId, timeoutMs = commandTimeoutMs) {
        const id = nextId++
        const message = { id, method, params }
        if (sessionId) message.sessionId = sessionId
        return new Promise((res, rej) => {
          if (socket.destroyed) {
            rej(new Error(`CDP connection closed: ${method}`))
            return
          }
          const timer = setTimeout(() => {
            if (pending.delete(id)) rej(new Error(`CDP timeout: ${method}`))
          }, timeoutMs)
          pending.set(id, { res, rej, timer })
          socket.write(encodeFrame(JSON.stringify(message)))
        })
      },
      waitForEvent(method, timeoutMs = 20000) {
        const hit = events.find((e) => e.method === method)
        if (hit) return Promise.resolve(hit.params)
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`event timeout: ${method}`)), timeoutMs)
          eventWaiters.push({ method, res, rej, timer })
        })
      },
      close() {
        rejectPending(new Error('CDP connection closed'))
        socket.destroy()
      }
    }

    socket.on('connect', () => {
      socket.write(
        `GET ${pathname} HTTP/1.1\r\n` +
          `Host: ${hostname}:${port}\r\n` +
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
      // Drain complete frames; keep the remainder for the next chunk.
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
          message.error ? rej(new Error(message.error.message)) : res(message.result)
        } else if (message.method) {
          events.push(message)
          for (let i = eventWaiters.length - 1; i >= 0; i--) {
            if (eventWaiters[i].method === message.method) {
              clearTimeout(eventWaiters[i].timer)
              eventWaiters[i].res(message.params)
              eventWaiters.splice(i, 1)
            }
          }
        }
      }
    })
  })
}

function encodeFrame(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const mask = randomBytes(4)
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
  } else if (payload.length < 65536) {
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
  if (buffer.length < offset + length) return null
  return { fin, opcode, payload: buffer.subarray(offset, offset + length), consumed: offset + length }
}
