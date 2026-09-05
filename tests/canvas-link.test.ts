import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  backoffFor,
  createCanvasLink,
  linkUrl,
  type CanvasLink
} from '../src/main/canvas-link'
import { encodeFrame } from '../src/shared/relay-frame'

/**
 * IDENTITY v2, PHASE 3 — THE DESKTOP DIALLING ITS OWN LINE.
 *
 * The relay here is a REAL server on loopback speaking the real frames, not a
 * mocked transport: what has to be right is the wire, and a fake transport
 * would only prove the frames match the fake. It answers the two halves the
 * registry answers — a GET that streams down and a chunked POST that streams
 * up — and refuses an uplink for a line it is not holding, exactly as
 * v2-canvas-relay does.
 */

interface FakeRelay {
  readonly origin: string
  /** How many downlinks have been opened, ever. */
  readonly opens: () => number
  /** Bearer tokens presented on the downlink, in order. */
  readonly tokens: () => readonly string[]
  /** Is a downlink held for this device right now? */
  readonly holding: (deviceId: string) => boolean
  /** Lines the desktop wrote on its uplink. */
  readonly up: () => readonly string[]
  readonly push: (deviceId: string, line: string) => void
  readonly endDown: (deviceId: string) => void
  /** Refuse the next downlink with abort{name-taken}. */
  readonly refuseNext: (on: boolean) => void
  readonly close: () => Promise<void>
}

const fakeRelay = async (): Promise<FakeRelay> => {
  const downs = new Map<string, ServerResponse>()
  const uplines: string[] = []
  const tokens: string[] = []
  let opens = 0
  let refuse = false

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://relay.local')
    const deviceId = url.pathname.split('/').pop() ?? ''
    const bearer = (request.headers.authorization ?? '').replace(/^Bearer /, '')
    if (request.method === 'GET') {
      opens += 1
      tokens.push(bearer)
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      if (refuse) {
        response.write(`${encodeFrame({ t: 'abort', id: 'x', reason: 'name-taken' })}\n`)
        response.end()
        return
      }
      downs.set(deviceId, response)
      response.write(`${encodeFrame({ t: 'ready', name: `@owner/desktop/${deviceId}` })}\n`)
      response.on('close', () => {
        if (downs.get(deviceId) === response) downs.delete(deviceId)
      })
      return
    }
    if (!downs.has(deviceId)) {
      response.writeHead(409, { 'content-type': 'application/json' })
      response.end('{"error":"no_link"}')
      return
    }
    let buffer = ''
    request.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let at = buffer.indexOf('\n')
      while (at >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        at = buffer.indexOf('\n')
        if (line.length > 0) uplines.push(line)
      }
    })
    request.on('end', () => {
      if (!response.writableEnded) response.end('{"ok":true}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    opens: () => opens,
    tokens: () => tokens,
    holding: (deviceId) => downs.has(deviceId),
    up: () => uplines,
    push: (deviceId, line) => void downs.get(deviceId)?.write(`${line}\n`),
    endDown: (deviceId) => {
      downs.get(deviceId)?.end()
      downs.delete(deviceId)
    },
    refuseNext: (on) => void (refuse = on),
    close: () =>
      new Promise((resolve) => {
        for (const held of downs.values()) held.end()
        downs.clear()
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

/** A clock the test drives. Every scheduled callback is fireable by hand. */
const fakeSchedule = (): {
  readonly schedule: (fn: () => void, ms: number) => () => void
  readonly pending: () => readonly number[]
  readonly fireAll: () => void
} => {
  let waiting: { fn: () => void; ms: number; live: boolean }[] = []
  return {
    schedule: (fn, ms) => {
      const entry = { fn, ms, live: true }
      waiting = [...waiting, entry]
      return () => void (entry.live = false)
    },
    pending: () => waiting.filter((entry) => entry.live).map((entry) => entry.ms),
    fireAll: () => {
      const due = waiting.filter((entry) => entry.live)
      waiting = []
      for (const entry of due) entry.fn()
    }
  }
}

const until = async (what: () => boolean, why: string, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!what()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${why}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const DEVICE = '11111111-2222-3333-4444-555555555555'

let relay: FakeRelay | null = null
let link: CanvasLink | null = null

afterEach(async () => {
  link?.stop()
  link = null
  await relay?.close()
  relay = null
})

describe('the backoff', () => {
  it('starts at a second, doubles, and stops at a minute', () => {
    // random() = 1 is the top of the jitter window, which is the plain value.
    expect(backoffFor(1, () => 1)).toBe(BACKOFF_MIN_MS)
    expect(backoffFor(2, () => 1)).toBe(2000)
    expect(backoffFor(5, () => 1)).toBe(16_000)
    expect(backoffFor(20, () => 1)).toBe(BACKOFF_MAX_MS)
  })

  it('jitters over the top half, so a fleet does not redial in one wave', () => {
    expect(backoffFor(3, () => 0)).toBe(2000)
    expect(backoffFor(3, () => 1)).toBe(4000)
    expect(backoffFor(3, () => 0.5)).toBe(3000)
  })
})

describe('the link url', () => {
  it('is the device id under the canvas namespace, with no trailing slash', () => {
    expect(linkUrl('https://cookrew.dev/', DEVICE)).toBe(`https://cookrew.dev/v2/canvas/link/${DEVICE}`)
  })
})

describe('dialling the line', () => {
  it('opens the downlink, waits for ready, and holds', async () => {
    relay = await fakeRelay()
    const held: boolean[] = []
    link = createCanvasLink({
      origin: () => relay!.origin,
      credential: () => ({ token: 'session-token', deviceId: DEVICE }),
      schedule: fakeSchedule().schedule
    })
    link.onChange((next) => held.push(next))
    link.start()
    await until(() => link!.held(), 'the line to be held')
    expect(link.name()).toBe(`@owner/desktop/${DEVICE}`)
    expect(held).toEqual([true])
    expect(relay.tokens()).toEqual(['session-token'])
    // The uplink follows the ready, never races it: the registry answers an
    // uplink for a line it is not holding with 409.
    await until(() => relay!.holding(DEVICE), 'the relay to hold the line')
  })

  it('answers every ping with a pong, on the uplink', async () => {
    relay = await fakeRelay()
    link = createCanvasLink({
      origin: () => relay!.origin,
      credential: () => ({ token: 't', deviceId: DEVICE }),
      schedule: fakeSchedule().schedule
    })
    link.start()
    await until(() => link!.held(), 'held')
    relay.push(DEVICE, encodeFrame({ t: 'ping', at: 1234 }))
    await until(() => relay!.up().some((line) => line.includes('"pong"')), 'a pong')
    expect(relay.up().some((line) => line === encodeFrame({ t: 'pong', at: 1234 }))).toBe(true)
  })

  it('hands every other frame to the bridge, and keeps the housekeeping', async () => {
    relay = await fakeRelay()
    const seen: string[] = []
    link = createCanvasLink({
      origin: () => relay!.origin,
      credential: () => ({ token: 't', deviceId: DEVICE }),
      schedule: fakeSchedule().schedule
    })
    link.onFrame((line) => seen.push(line))
    link.start()
    await until(() => link!.held(), 'held')
    const open = encodeFrame({ t: 'open', id: 's1', method: 'GET', path: '/', headers: {} })
    relay.push(DEVICE, encodeFrame({ t: 'ping', at: 1 }))
    relay.push(DEVICE, open)
    await until(() => seen.length === 1, 'the open frame')
    // The ready and the ping are the link's own business and never reach the
    // bridge; the open is all the bridge ever sees.
    expect(seen).toEqual([open])
  })

  it('does not fight a name another link holds — it backs off', async () => {
    relay = await fakeRelay()
    relay.refuseNext(true)
    const clock = fakeSchedule()
    link = createCanvasLink({
      origin: () => relay!.origin,
      credential: () => ({ token: 't', deviceId: DEVICE }),
      schedule: clock.schedule,
      random: () => 1
    })
    link.start()
    await until(() => relay!.opens() === 1, 'the first dial')
    await until(() => clock.pending().includes(BACKOFF_MIN_MS), 'a backoff to be scheduled')
    expect(link.held()).toBe(false)
    // The line comes free; the scheduled retry takes it.
    relay.refuseNext(false)
    clock.fireAll()
    await until(() => link!.held(), 'the redial to hold')
    expect(relay.opens()).toBe(2)
  })

  it('redials when the registry closes the line, and says so once', async () => {
    relay = await fakeRelay()
    const clock = fakeSchedule()
    const held: boolean[] = []
    let drops = 0
    link = createCanvasLink({
      origin: () => relay!.origin,
      credential: () => ({ token: 't', deviceId: DEVICE }),
      schedule: clock.schedule,
      random: () => 1
    })
    link.onChange((next) => held.push(next))
    link.onDrop(() => void (drops += 1))
    link.start()
    await until(() => link!.held(), 'held')
    relay.endDown(DEVICE)
    await until(() => !link!.held(), 'the line to drop')
    expect(drops).toBe(1)
    // A successful line resets the backoff, so the redial is a second and not
    // wherever the last failure had climbed to.
    await until(() => clock.pending().includes(BACKOFF_MIN_MS), 'a one-second retry')
    clock.fireAll()
    await until(() => link!.held(), 'the redial')
    expect(held).toEqual([true, false, true])
  })

  it('drops the line when it goes quiet, whatever the socket says', async () => {
    relay = await fakeRelay()
    const clock = fakeSchedule()
    link = createCanvasLink({
      origin: () => relay!.origin,
      credential: () => ({ token: 't', deviceId: DEVICE }),
      schedule: clock.schedule,
      quietMs: 1
    })
    link.start()
    await until(() => link!.held(), 'held')
    // The quiet watchdog is the only pending timer; firing it is three missed
    // pings, which is a line that carries nothing while every socket looks open.
    clock.fireAll()
    expect(link.held()).toBe(false)
  })

  it('dials nothing at all without an account', async () => {
    relay = await fakeRelay()
    const clock = fakeSchedule()
    link = createCanvasLink({
      origin: () => relay!.origin,
      credential: () => null,
      schedule: clock.schedule,
      idleMs: 42
    })
    link.start()
    expect(relay.opens()).toBe(0)
    expect(link.held()).toBe(false)
    // Not a backoff: the owner has no account or has turned reachability off,
    // and that is re-asked on a slow clock rather than retried faster and faster.
    expect(clock.pending()).toEqual([42])
  })

  it('takes the line the moment an account appears', async () => {
    relay = await fakeRelay()
    const clock = fakeSchedule()
    let credential: { token: string; deviceId: string } | null = null
    link = createCanvasLink({
      origin: () => relay!.origin,
      credential: () => credential,
      schedule: clock.schedule
    })
    link.start()
    expect(relay.opens()).toBe(0)
    credential = { token: 't', deviceId: DEVICE }
    link.refresh()
    await until(() => link!.held(), 'the line after the claim')
  })

  it('drops the line when reachability is switched off', async () => {
    relay = await fakeRelay()
    let reachable = true
    link = createCanvasLink({
      origin: () => relay!.origin,
      credential: () => (reachable ? { token: 't', deviceId: DEVICE } : null),
      schedule: fakeSchedule().schedule
    })
    link.start()
    await until(() => link!.held(), 'held')
    // The owner said no. Merely not republishing would leave a line that goes
    // on answering, and a reach card offering a path that was just refused.
    reachable = false
    link.refresh()
    expect(link.held()).toBe(false)
    await until(() => !relay!.holding(DEVICE), 'the relay to let the name go')
  })

  it('stops holding when the desktop withdraws', async () => {
    relay = await fakeRelay()
    link = createCanvasLink({
      origin: () => relay!.origin,
      credential: () => ({ token: 't', deviceId: DEVICE }),
      schedule: fakeSchedule().schedule
    })
    link.start()
    await until(() => link!.held(), 'held')
    link.stop()
    expect(link.held()).toBe(false)
    await until(() => !relay!.holding(DEVICE), 'the relay to let the name go')
  })
})
