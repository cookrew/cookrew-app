// A PHONE CARD OVER ADB, THE WHOLE CHAIN, WITH THE CABLE PULLED.
//
// A fake `adb` (a real executable — the real process boundary adbRunner
// crosses), the real AdbDevice and PixelInstance, the real cast handshake a
// remote viewer makes. The device starts unplugged: the viewer is told why,
// gets no frames, and is NOT dropped. Plugged in, frames flow and a tap on
// the frame lands on the device in pixels. Pulled mid-stream and plugged
// back, the same socket is live again. That is the stability the owner
// debugs against: a wiggled cable is a status line, never a dead card.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdbDevice, adbRunner, pngSize } from '../src/main/adb-device'
import { createBrowserCast } from '../src/main/browser-cast'
import { PixelInstance } from '../src/main/pixel-instance'
import { parseUseUrl } from '../src/shared/use-url'

const FAKE_ADB = `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const dir = process.env.FAKE_ADB_DIR
const args = process.argv.slice(2)
const attached = fs.existsSync(path.join(dir, 'attached'))
if (args[0] === 'devices') { process.stdout.write('List of devices attached\\n' + (attached ? 'FAKE01\\tdevice\\n' : '') + '\\n'); process.exit(0) }
if (args[0] !== '-s' || args[1] !== 'FAKE01') { process.stderr.write('error: bad serial'); process.exit(1) }
if (!attached) { process.stderr.write("error: device 'FAKE01' not found"); process.exit(1) }
const rest = args.slice(2).join(' ')
if (rest === 'shell wm size') { process.stdout.write('Physical size: 1080x2400\\n'); process.exit(0) }
if (rest === 'shell wm density') { process.stdout.write('Physical density: 420\\n'); process.exit(0) }
if (rest === 'exec-out screencap -p') {
  const b = Buffer.alloc(24); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(1080, 16); b.writeUInt32BE(2400, 20)
  process.stdout.write(b); process.exit(0)
}
if (rest.startsWith('shell input ')) { fs.appendFileSync(path.join(dir, 'inputs.log'), rest + '\\n'); process.exit(0) }
process.stderr.write('error: unknown ' + rest); process.exit(1)
`

const maskedTextFrame = (payload: string): Buffer => {
  const key = Buffer.from([0x12, 0x34, 0x56, 0x78])
  const data = Buffer.from(payload, 'utf8')
  const masked = Buffer.from(data.map((byte, index) => byte ^ key[index % key.length]))
  const header = data.length < 126 ? Buffer.from([0x81, 0x80 | data.length]) : Buffer.from([0x81, 0x80 | 126, data.length >> 8, data.length & 0xff])
  return Buffer.concat([header, key, masked])
}

/** A JPEG header carrying a real SOF0 size, which is all the cast reads. */
const jpegOfSize = (width: number, height: number): Buffer => {
  const sof = Buffer.alloc(10)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(8, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof])
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
      writes.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
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

const messages = (socket: TestSocket, type: string): Array<Record<string, unknown>> =>
  socket.writes
    .map((write) => /\{"t":"[a-z-]+".*\}/s.exec(write)?.[0])
    .filter((json): json is string => json !== undefined)
    .map((json) => JSON.parse(json) as Record<string, unknown>)
    .filter((message) => message.t === type)

const dirs: string[] = []
const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const run of cleanups.splice(0)) await run()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  delete process.env.FAKE_ADB_DIR
})

describe.skipIf(process.platform === 'win32')('a viewer on an adb phone card', () => {
  it('is told why while unplugged, goes live when plugged, taps in pixels, and survives a pulled cable', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adb-e2e-'))
    dirs.push(dir)
    const adb = path.join(dir, 'adb')
    writeFileSync(adb, FAKE_ADB)
    chmodSync(adb, 0o755)
    process.env.FAKE_ADB_DIR = dir
    const plug = (on: boolean): void => {
      const file = path.join(dir, 'attached')
      if (on) writeFileSync(file, '')
      else if (existsSync(file)) unlinkSync(file)
    }
    const inputs = (): string[] => (existsSync(path.join(dir, 'inputs.log')) ? readFileSync(path.join(dir, 'inputs.log'), 'utf8').trim().split('\n') : [])

    const device = new AdbDevice(parseUseUrl('adb://default')!, {
      run: adbRunner(adb),
      // Half size, as the real encoder's long-side fit would do for a big phone.
      toJpeg: (png) => {
        const size = pngSize(png)!
        return jpegOfSize(size.width / 2, size.height / 2)
      }
    })
    const instance = new PixelInstance({ url: 'adb://default', device })
    let exited = false
    instance.onExit = () => {
      exited = true
    }
    cleanups.push(() => instance.stop())
    await instance.start()

    const cast = createBrowserCast({ enabled: () => true, desktopToken: () => 'd', paired: () => true, getInstance: async () => instance })
    cleanups.push(() => cast.shutdown())
    const socket = socketStub()
    cast.upgrade(req('/api/browser/phone-1/stream?w=390&h=844'), socket)

    await vi.waitFor(() => expect(messages(socket, 'status').at(-1)).toMatchObject({ state: 'offline', use: 'phone' }), { timeout: 3000 })
    expect(String(messages(socket, 'status').at(-1)?.message)).toMatch(/No Android device is attached/)
    expect(messages(socket, 'frame')).toHaveLength(0)

    plug(true)
    await vi.waitFor(() => expect(messages(socket, 'status').at(-1)).toMatchObject({ state: 'live', input: true }), { timeout: 4000 })
    await vi.waitFor(() => expect(messages(socket, 'frame').length).toBeGreaterThan(0), { timeout: 3000 })
    const frame = messages(socket, 'frame').at(-1)!
    const meta = frame.meta as { revision: number; deviceWidth: number; deviceHeight: number }
    expect([meta.deviceWidth, meta.deviceHeight]).toEqual([411, 914])

    // The middle of a 540-wide frame is the middle of the 1080-pixel phone.
    socket.emitEvent('data', maskedTextFrame(JSON.stringify({ t: 'tap', x: 270, y: 600, revision: meta.revision, frameSeq: frame.seq })))
    await vi.waitFor(() => expect(inputs().length).toBe(1), { timeout: 3000 })
    const [, , , x, y] = inputs()[0].split(' ')
    expect(Math.abs(Number(x) - 540)).toBeLessThanOrEqual(3)
    expect(Math.abs(Number(y) - 1200)).toBeLessThanOrEqual(3)

    plug(false)
    await vi.waitFor(() => expect(messages(socket, 'status').at(-1)).toMatchObject({ state: 'offline' }), { timeout: 4000 })
    const framesWhileAway = messages(socket, 'frame').length
    plug(true)
    await vi.waitFor(() => expect(messages(socket, 'status').at(-1)).toMatchObject({ state: 'live' }), { timeout: 5000 })
    await vi.waitFor(() => expect(messages(socket, 'frame').length).toBeGreaterThan(framesWhileAway), { timeout: 3000 })
    expect(socket.destroyed).toBe(false)
    expect(exited).toBe(false)
  }, 30_000)
})

describe('cast.drop', () => {
  it('closes only that card’s viewers, so they redial onto its new instance', async () => {
    const device = {
      target: parseUseUrl('adb://default')!,
      open: async () => ({ width: 10, height: 10 }),
      capture: async () => ({ jpeg: jpegOfSize(10, 10).toString('base64') })
    }
    const a = new PixelInstance({ url: 'adb://default', device })
    const b = new PixelInstance({ url: 'adb://default', device })
    cleanups.push(() => a.stop(), () => b.stop())
    const cast = createBrowserCast({
      enabled: () => true,
      desktopToken: () => 'd',
      paired: () => true,
      getInstance: async (id) => (id === 'card-a' ? a : b)
    })
    cleanups.push(() => cast.shutdown())
    const sa = socketStub()
    const sb = socketStub()
    cast.upgrade(req('/api/browser/card-a/stream'), sa)
    cast.upgrade(req('/api/browser/card-b/stream'), sb)
    await vi.waitFor(() => expect(cast.activeCount()).toBe(2))
    cast.drop('card-a')
    expect(sa.destroyed).toBe(true)
    expect(sb.destroyed).toBe(false)
    expect(cast.activeCount()).toBe(1)
  })
})
