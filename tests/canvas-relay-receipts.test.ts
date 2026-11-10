import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { loopbackDialer, createCanvasBridge } from '../src/main/canvas-bridge'
import { createCanvasLink, httpTransport, type CanvasLink, type LinkReceipt, type LinkTransport } from '../src/main/canvas-link'
import { createCanvasRelay, type CanvasRelay } from '../src/main/canvas-relay'
import { createRelayUplink, RELAY_CHUNK } from '../src/main/relay-uplink'
import { decodeFrame } from '../src/shared/relay-frame'
import { bodyServer, canvasWorld, drain, listenOn, until, type CanvasWorld, type Listening } from './support/canvas-world'

/**
 * RECEIPTS ON THE MAC'S OWN LINE, against the real registry: the registry
 * counts what arrives of an uplink that asked, and says so on its downlink;
 * the Mac's count of what it wrote agrees with it to the byte. An uplink that
 * did not ask (every Mac before this change) is never sent one, and a Mac
 * whose registry predates receipts runs exactly as it did before.
 */

const BIG = randomBytes(300_000)

let world: CanvasWorld
let mac: Listening
let stops: (() => void)[] = []

beforeAll(async () => {
  world = await canvasWorld()
  mac = await listenOn(bodyServer(BIG))
}, 30_000)

afterAll(async () => {
  await mac?.close()
  await world?.close()
})

afterEach(() => {
  stops.forEach((stop) => stop())
  stops = []
})

const credential = (): { token: string; deviceId: string } => ({ token: world.desktopToken, deviceId: world.deviceId })
const dial = (): ReturnType<typeof loopbackDialer> => loopbackDialer(Number(new URL(mac.origin).port))

/** The real transport, with the uplink's question taken off: a Mac of before this change. */
const askingNothing = (): LinkTransport => {
  const real = httpTransport()
  return { down: real.down, up: (url, token) => real.up(url.replace('?acks=1', ''), token) }
}

/** And with `ready`'s promise taken off too: a registry of before this change, as the Mac sees it. */
const oldRegistry = (): LinkTransport => {
  const asking = askingNothing()
  return {
    up: asking.up,
    down: (url, token) => {
      const down = asking.down(url, token)
      return {
        ...down,
        onLine: (listener) => down.onLine((line) => listener(line.replace(',"receipts":true', '')))
      }
    }
  }
}

describe('receipts on the line', () => {
  it('begin with a greeting, before the uplink has sent a byte', async () => {
    // The raw wire: a downlink, then an uplink that asks and writes nothing.
    const url = `${world.site.origin}/v2/canvas/link/${world.deviceId}`
    const auth = { authorization: `Bearer ${world.desktopToken}` }
    const lines: string[] = []
    const down = httpRequest(url, { headers: { ...auth, accept: 'application/x-ndjson' } }, (response) => {
      response.setEncoding('utf8')
      response.on('data', (text: string) => lines.push(...text.split('\n').filter(Boolean)))
    })
    down.end()
    await until(() => lines.some((line) => decodeFrame(line)?.t === 'ready'), 'ready')
    // The promise comes first, before there is an uplink to keep it to.
    expect(lines.map((line) => decodeFrame(line)).find((frame) => frame?.t === 'ready')).toMatchObject({ receipts: true })
    const up = httpRequest(`${url}?acks=1`, { method: 'POST', headers: { ...auth, 'content-type': 'application/x-ndjson' } })
    up.on('error', () => undefined)
    up.flushHeaders()
    try {
      await until(() => lines.some((line) => decodeFrame(line)?.t === 'got'), 'the greeting')
      expect(lines.map((line) => decodeFrame(line)).find((frame) => frame?.t === 'got')).toEqual({ t: 'got', n: 0 })
    } finally {
      up.destroy()
      down.destroy()
    }
    // The registry takes a moment to notice the line is gone.
    await new Promise((resolve) => setTimeout(resolve, 100))
  })

  it('confirm every byte the Mac wrote, counted the way the Mac counts it', async () => {
    const relay: CanvasRelay = createCanvasRelay({ origin: () => world.site.origin, credential, dial: dial() })
    stops.push(relay.stop)
    const receipts: LinkReceipt[] = []
    relay.link.onReceipt((receipt) => receipts.push(receipt))
    relay.start()
    await until(() => relay.link.held(), 'the line')
    expect(await drain(await world.asPhone('/big'))).toBe(BIG.byteLength)
    await until(() => relay.link.backlog() === 0 && receipts.length > 0, 'every byte written to be confirmed')
    expect(relay.link.paced()).toBe(true)
    // backlog() is written minus confirmed: zero is the two counts agreeing.
    // Every receipt that confirmed a whole write measured its delay.
    expect(receipts.some((receipt) => receipt.rttMs !== null && receipt.rttMs >= 0)).toBe(true)
    expect(receipts.reduce((sum, receipt) => sum + receipt.acked, 0)).toBeGreaterThan(BIG.byteLength)
  }, 20_000)

  it('are never handed to the bridge as a frame', async () => {
    const link = createCanvasLink({ origin: () => world.site.origin, credential })
    stops.push(link.stop)
    const bridge = createCanvasBridge({ send: (line) => link.send(line), dial: dial() })
    const seen: string[] = []
    link.onFrame((line) => {
      seen.push(decodeFrame(line)?.t ?? 'junk')
      bridge.frame(line)
    })
    link.start()
    await until(() => link.held(), 'the line')
    await drain(await world.asPhone('/big'))
    await until(() => link.paced(), 'a receipt')
    expect(seen).not.toContain('got')
  }, 20_000)

  it('are not sent to an uplink that did not ask', async () => {
    const link: CanvasLink = createCanvasLink({
      origin: () => world.site.origin,
      credential,
      transport: askingNothing(),
      receiptGraceMs: 50
    })
    stops.push(link.stop)
    const bridge = createCanvasBridge({ send: (line) => link.send(line), dial: dial() })
    const seen: string[] = []
    link.onFrame((line) => {
      seen.push(decodeFrame(line)?.t ?? 'junk')
      bridge.frame(line)
    })
    let receipts = 0
    link.onReceipt(() => void (receipts += 1))
    link.start()
    await until(() => link.held(), 'the line')
    expect(await drain(await world.asPhone('/big'))).toBe(BIG.byteLength)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(receipts).toBe(0)
    expect(link.paced()).toBe(false)
  }, 20_000)

  it('against a registry from before receipts, holds nothing back and carries everything', async () => {
    // The same wiring as canvas-relay.ts, on a line whose registry never
    // promised receipts.
    const link = createCanvasLink({ origin: () => world.site.origin, credential, transport: oldRegistry() })
    stops.push(link.stop)
    const uplink = createRelayUplink(link)
    const bridge = createCanvasBridge({ send: uplink.send, dial: dial(), chunk: RELAY_CHUNK, room: uplink.room })
    link.onFrame((line) => {
      uplink.heard(line)
      bridge.frame(line)
    })
    link.onDrop(() => {
      uplink.reset()
      bridge.reset()
    })
    link.start()
    await until(() => link.held(), 'the line')
    // Not paced from the first byte: no promise, so no hold, as before.
    expect(link.paced()).toBe(false)
    const answers = await Promise.all([world.asPhone('/big'), world.asPhone('/big'), world.asPhone('/small')])
    const sizes = await Promise.all(answers.map((answer) => drain(answer)))
    expect(sizes).toEqual([BIG.byteLength, BIG.byteLength, 11])
    expect(link.paced()).toBe(false)
  }, 20_000)
})
