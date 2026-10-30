// THE WHOLE CHAIN, MINUS THE PIXELS: a fake vphoned on a real Unix socket,
// the real VphoneInstance, the real cast handshake. A viewer gets `ready`
// and a frame sized by the phone, taps the frame, and the phone receives
// `input.tap` in points. Nothing here knows about Chrome.
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserCast } from '../src/main/browser-cast'
import { VphoneInstance } from '../src/main/vphone-instance'
import { createSocketGuest } from '../src/main/vphone-socket'

const maskedTextFrame = (payload: string): Buffer => {
  const key = Buffer.from([0x12, 0x34, 0x56, 0x78])
  const data = Buffer.from(payload, 'utf8')
  const masked = Buffer.from(data.map((byte, index) => byte ^ key[index % key.length]))
  return Buffer.concat([Buffer.from([0x81, 0x80 | data.length]), key, masked])
}

/** A JPEG header carrying a real SOF0 size, which is all the cast reads. */
const jpegFrame = (width: number, height: number): string => {
  const sof = Buffer.alloc(10)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(8, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof]).toString('base64')
}

interface TestSocket extends Duplex {
  writes: string[]
  emitEvent: (name: string, value?: unknown) => void
}

const socketStub = (): TestSocket => {
  const writes: string[] = []
  const listeners = new Map<string, Set<(value?: unknown) => void>>()
  let destroyed = false
  const emitEvent = (name: string, value?: unknown): void => {
    for (const listener of [...(listeners.get(name) ?? [])]) listener(value)
  }
  const on = (name: string, listener: (value?: unknown) => void): unknown => {
    const set = listeners.get(name) ?? new Set()
    set.add(listener)
    listeners.set(name, set)
    return socket
  }
  const socket = {
    writes,
    get destroyed() {
      return destroyed
    },
    writableLength: 0,
    emitEvent,
    write: (chunk: unknown) => {
      writes.push(String(chunk))
      return true
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      emitEvent('close')
    },
    on,
    once: on
  }
  return socket as unknown as TestSocket
}

const req = (url: string): IncomingMessage =>
  ({ url, headers: { 'sec-websocket-key': 'k', host: 'localhost' } }) as unknown as IncomingMessage

const dirs: string[] = []
const servers: net.Server[] = []
const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const run of cleanups.splice(0)) await run()
  for (const s of servers.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** vphoned as the socket shows it: ping, a 3x screen, one still frame, and a memory of every input. */
const fakeVphoned = async (): Promise<{ file: string; inputs: Array<[string, unknown]> }> => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vphone-e2e-'))
  dirs.push(dir)
  const file = path.join(dir, 'vphone.sock')
  const inputs: Array<[string, unknown]> = []
  const server = net.createServer((socket) => {
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk
      if (!data.includes('\n')) return
      const request = JSON.parse(data.trim()) as { t: string; method?: string; params?: unknown }
      if (request.t === 'ping') return void socket.end('{"ok":true}\n')
      if (request.method === 'device.screen') {
        return void socket.end(`${JSON.stringify({ ok: true, result: { width: 430, height: 932, scale: 3 } })}\n`)
      }
      if (request.method === 'screen.screenshot') {
        return void socket.end(
          `${JSON.stringify({ ok: true, result: { data: jpegFrame(1290, 2796), mime_type: 'image/jpeg', width: 1290, height: 2796 } })}\n`
        )
      }
      if (request.method?.startsWith('input.')) inputs.push([request.method, request.params])
      socket.end('{"ok":true,"result":{}}\n')
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(file, resolve))
  return { file, inputs }
}

const messages = (socket: TestSocket, type: string): Array<Record<string, unknown>> =>
  socket.writes
    .map((write) => /\{"t":"[a-z-]+".*\}/.exec(write)?.[0])
    .filter((json): json is string => json !== undefined)
    .map((json) => JSON.parse(json) as Record<string, unknown>)
    .filter((message) => message.t === type)

describe('a viewer on a vphone card', () => {
  it('is told the phone’s size, gets a frame, and its tap lands on the phone in points', async () => {
    const { file, inputs } = await fakeVphoned()
    const instance = new VphoneInstance({ machine: 'myphone', guest: createSocketGuest(file, { machine: 'myphone' }) })
    await instance.start()
    cleanups.push(() => instance.stop())
    const cast = createBrowserCast({
      enabled: () => true,
      desktopToken: () => 'desktop-secret',
      paired: () => true,
      getInstance: async () => instance
    })
    cleanups.push(() => cast.shutdown())
    const socket = socketStub()
    cast.upgrade(req('/api/browser/phone-1/stream?w=390&h=844'), socket)

    await vi.waitFor(() => expect(messages(socket, 'ready')).toHaveLength(1))
    expect(messages(socket, 'ready')[0]).toMatchObject({ w: 430, h: 932, mobile: true })

    // The first screenshot arrives on the idle cadence.
    await vi.waitFor(() => expect(messages(socket, 'frame').length).toBeGreaterThan(0), { timeout: 4000 })
    const frame = messages(socket, 'frame')[0]
    const seq = frame.seq as number
    const revision = (frame.meta as { revision: number }).revision

    // A tap at frame pixels (300, 600) on a 1290-wide frame of a 430-point
    // screen is the point (100, 200) on the phone.
    socket.emitEvent('data', maskedTextFrame(JSON.stringify({ t: 'tap', x: 300, y: 600, revision, frameSeq: seq })))
    await vi.waitFor(() => expect(inputs).toContainEqual(['input.tap', { x: 100, y: 200 }]), { timeout: 2000 })

    // A navigation never comes from the viewer; the vocabulary drops it.
    socket.emitEvent('data', maskedTextFrame(JSON.stringify({ t: 'navigate', url: 'https://evil.test', revision, frameSeq: seq })))
    socket.emitEvent('data', maskedTextFrame(JSON.stringify({ method: 'files.read', params: { path: '/etc/passwd' } })))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(inputs.map(([method]) => method)).toEqual(['input.tap'])
  })
})
