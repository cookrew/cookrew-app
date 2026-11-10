import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer as createTcp, connect, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { loopbackDialer } from '../src/main/canvas-bridge'
import { createCanvasRelay, type CanvasRelay } from '../src/main/canvas-relay'
import { bodyServer, canvasWorld, drain, listenOn, until, type CanvasWorld, type Listening } from './support/canvas-world'

/**
 * THE MAC'S UPLINK, BEHIND A DEEP BUFFER — measured on the owner's line 2026-11-10.
 *
 * The Mac reaches cookrew.dev through Clash's TUN (gvisor stack) and a proxy:
 * whatever Node writes leaves the process at once and waits in buffers outside
 * it, so `writableLength` reads zero while seconds of answers queue. The
 * registry's own log for that day: p50 198 ms, p99 33 s, one 336 KB answer
 * taking 114 s behind 4.5 MB of others, at an effective 35-40 KB/s.
 *
 * The bottleneck below is that line in miniature: it takes every byte the Mac
 * writes the moment it is written and lets it out at a fixed rate. The phone
 * talks to the registry directly. Everything else is the code that ships: the
 * real registry, and the canvas relay exactly as index.ts wires it.
 *
 * Measured when written, before -> after the paced uplink:
 *
 *                                   300 KB/s, 120 ms RTT   40 KB/s, 440 ms RTT
 *   small answer behind a big one     4680 -> 206-511 ms     7737 -> 1126-1396 ms
 *   after an answer nobody reads      4890 -> 283-561 ms     7738 -> 846-1111 ms
 *   one big answer, x the line floor  1.03 -> 1.03-1.08      1.04 -> 1.08
 *
 * The second column is the owner's line. Re-run it with
 * RELAY_BLOAT_RATE=40 RELAY_BLOAT_ONE_WAY_MS=220 RELAY_BLOAT_BYTES=330000 (~50 s).
 */

/** Bytes per ms out of the bottleneck. */
const RATE = Number(process.env.RELAY_BLOAT_RATE ?? 300)
const ONE_WAY_MS = Number(process.env.RELAY_BLOAT_ONE_WAY_MS ?? 60)
const BIG = randomBytes(Number(process.env.RELAY_BLOAT_BYTES ?? 1_200_000))
/** How long the big answer takes to cross alone, at best: base64 frames at the line's rate. */
const FLOOR_MS = (BIG.byteLength * 4) / 3 / RATE
const SLOW = FLOOR_MS * 3 + 30_000

/** What a real link carries at a time: a write crosses as packets, not as one piece. */
const PACKET = 1400

/**
 * One direction of a link: bytes leave in the order they came, each packet no
 * sooner than its time. ONE timer for the head of a FIFO: a timer per chunk can
 * fire out of order (fractional delays against libuv's cached clock), which
 * scrambles the byte stream and reads as a malformed chunked body. Packets,
 * because a whole write let out at once would arrive first byte with last, and
 * a slow line does not do that.
 */
const pipe = (to: Socket, rate: number | null): ((chunk: Buffer) => void) => {
  const queue: { at: number; chunk: Buffer }[] = []
  let freeAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const release = (): void => {
    timer = null
    const now = Date.now()
    while (queue.length > 0 && queue[0].at <= now) {
      const { chunk } = queue.shift()!
      if (!to.destroyed) to.write(chunk)
    }
    if (queue.length > 0) timer = setTimeout(release, Math.max(1, queue[0].at - now))
  }
  return (chunk) => {
    const now = Date.now()
    for (let at = 0; at < chunk.length; at += PACKET) {
      const packet = chunk.subarray(at, at + PACKET)
      freeAt = rate === null ? now : Math.max(freeAt, now) + packet.length / rate
      queue.push({ at: freeAt + ONE_WAY_MS, chunk: packet })
    }
    if (timer === null) timer = setTimeout(release, Math.max(1, queue[0].at - now))
  }
}

/** Eager in, fixed rate out, delay both ways: Clash's TUN plus a proxy, as the Mac sees it. */
const bottleneck = async (target: number): Promise<{ origin: string; close: () => void }> => {
  const sockets = new Set<Socket>()
  const server = createTcp((mac) => {
    const site = connect(target, '127.0.0.1')
    sockets.add(mac)
    sockets.add(site)
    const closeBoth = (): void => {
      mac.destroy()
      site.destroy()
    }
    // Read eagerly from the Mac (no backpressure): that is the deep buffer.
    mac.on('data', pipe(site, RATE))
    site.on('data', pipe(mac, null))
    for (const end of [mac, site]) {
      end.on('close', closeBoth)
      end.on('error', closeBoth)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => {
      for (const socket of sockets) socket.destroy()
      server.close()
    }
  }
}

let world: CanvasWorld
let mac: Listening
let line: { origin: string; close: () => void }
let relay: CanvasRelay | null = null
/** Lines dropped while the tests ran: pacing must never cost the line itself. */
let drops = 0

beforeAll(async () => {
  world = await canvasWorld({ note: (m) => console.error('REG', m) })
  mac = await listenOn(bodyServer(BIG))
  line = await bottleneck(Number(new URL(world.site.origin).port))
  relay = createCanvasRelay({
    origin: () => line.origin,
    credential: () => ({ token: world.desktopToken, deviceId: world.deviceId }),
    dial: loopbackDialer(Number(new URL(mac.origin).port)),
    log: (m) => console.error('APP', m)
  })
  relay.link.onDrop(() => void (drops += 1))
  relay.start()
  await until(() => relay!.link.held(), 'the desktop to hold its line')
}, 30_000)

afterAll(async () => {
  relay?.stop()
  line?.close()
  await mac?.close()
  await world?.close()
})

const timeSmall = async (): Promise<number> => {
  const started = Date.now()
  const answer = await world.asPhone(`/small?at=${started}`)
  expect(answer.status).toBe(200)
  await answer.text()
  return Date.now() - started
}

/** The line's own floor: a small answer on an idle line, for scale. */
let idleMs = 0

describe('a Mac whose uplink is a deep buffer', () => {
  it('answers a small request on an idle line in about a round trip', async () => {
    await timeSmall()
    idleMs = await timeSmall()
    expect(idleMs).toBeLessThan(ONE_WAY_MS * 4 + 600)
  })

  it('answers a small request while a big answer is going up', async () => {
    let seen = 0
    const big = world.asPhone('/big').then((answer) => drain(answer, (total) => void (seen = total)))
    await until(() => seen > BIG.byteLength / 12, 'the big answer to be flowing', SLOW)
    const small = await timeSmall()
    expect(small).toBeLessThan(idleMs + 1200)
    expect(await big).toBe(BIG.byteLength)
    // The line was paced by the relay's receipts, not by Node's own count.
    expect(relay!.link.paced()).toBe(true)
  }, SLOW)

  it('stops spending the line on an answer nobody is reading', async () => {
    const quit = new AbortController()
    let seen = 0
    const big = world
      .asPhone('/big', { signal: quit.signal })
      .then((answer) => drain(answer, (total) => void (seen = total)))
      .catch(() => -1)
    await until(() => seen > BIG.byteLength / 24, 'the big answer to be flowing', SLOW)
    quit.abort()
    await big
    const small = await timeSmall()
    expect(small).toBeLessThan(idleMs + 1200)
    // And nothing of it is still waiting here for a reader who left.
    await until(() => relay!.uplink.queued() === 0, 'the abandoned lane to be let go', 2000)
  }, SLOW)

  it('still fills the line when one answer has it to itself', async () => {
    const started = Date.now()
    const total = await drain(await world.asPhone('/big?alone=1'))
    const elapsed = Date.now() - started
    expect(total).toBe(BIG.byteLength)
    // The line's own time for these bytes as base64 frames, plus a little:
    // pacing must not cost the throughput it is protecting.
    expect(elapsed).toBeLessThan(FLOOR_MS * 1.25 + 1000)
  }, SLOW)

  it('never dropped the line doing any of it', () => {
    expect(drops).toBe(0)
    expect(relay!.link.held()).toBe(true)
  })
})
