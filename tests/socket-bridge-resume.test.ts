import http from 'node:http'
import { Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  SOCKET_BRIDGE_CREDIT,
  SOCKET_BRIDGE_RELEASE_MS,
  SOCKET_BRIDGE_RESUME_MS,
  createSocketBridge
} from '../src/main/socket-bridge'
import type { LoopbackSocket, LoopbackSocketDeps } from '../src/main/ws-client'

/** A response whose writes are read back as server-sent events. */
function fakeResponse(): { response: http.ServerResponse; events: () => { event: string; data: string }[]; close: () => void } {
  const request = new http.IncomingMessage(new Socket())
  request.headers['accept-encoding'] = 'identity'
  const response = new http.ServerResponse(request)
  let text = ''
  response.write = ((chunk: string) => {
    text += String(chunk)
    return true
  }) as typeof response.write
  response.writeHead = (() => response) as unknown as typeof response.writeHead
  response.end = (() => response) as unknown as typeof response.end
  return {
    response,
    events: () =>
      [...text.matchAll(/event: (\S+)\ndata: (.*)\n\n/g)].map((m) => ({ event: m[1], data: m[2] })),
    close: () => void response.emit('close')
  }
}

function harness(over: { now?: () => number } = {}) {
  let deps!: LoopbackSocketDeps
  const sent: string[] = []
  const state = { closed: false }
  const upstream: LoopbackSocket = {
    send: (t) => void sent.push(t),
    close: () => void (state.closed = true),
    pause: () => undefined,
    resume: () => undefined
  } as LoopbackSocket
  const bridge = createSocketBridge({
    dial: (d) => {
      deps = d
      return upstream
    },
    ...over
  })
  const first = fakeResponse()
  expect(bridge.open('/api/browser/b1/stream', first.response, 'tok', { v: 2 })).toBe(true)
  deps.onOpen()
  const id = (JSON.parse(first.events().find((e) => e.event === 'id')?.data ?? '{}') as { id: string; v?: number }).id
  return { bridge, first, id, sent, state, up: () => deps }
}

const frame = (seq: number, data = `pic${seq}`): string => JSON.stringify({ t: 'frame', seq, data, meta: { revision: 1 } })
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('a bridged socket outlives the line it came down', () => {
  it('says it can resume, and keeps the Chrome viewer through a dropped stream', () => {
    const { first, state } = harness()
    expect(first.events()[0].data).toContain('"v":2')
    first.close()
    expect(state.closed).toBe(false)
  })

  it('replays the control messages missed, in order, then the newest picture', async () => {
    const { bridge, first, id, up } = harness()
    up().onMessage('{"t":"control","a":1}')
    first.close()
    up().onMessage('{"t":"copy","text":"x"}')
    up().onMessage(frame(1))
    up().onMessage(frame(2))
    const next = fakeResponse()
    expect(bridge.resume(id, 1, next.response, 'tok')).toBe(true)
    await tick()
    const events = next.events()
    expect(events[0].event).toBe('id')
    expect(events[1]).toEqual({ event: 'c', data: JSON.stringify([2, '{"t":"copy","text":"x"}']) })
    expect(events[2].event).toBe('f')
    expect(events[2].data).toContain('pic2')
    expect(events.filter((e) => e.event === 'f')).toHaveLength(1)
  })

  it('refuses another credential, and a session it no longer holds', () => {
    const { bridge, id } = harness()
    expect(bridge.resume(id, 0, fakeResponse().response, 'other')).toBe(false)
    expect(bridge.resume('00000000-0000-4000-8000-000000000000', 0, fakeResponse().response, 'tok')).toBe(false)
  })

  it('a second listener takes over from one the phone gave up on', () => {
    const { bridge, id, up } = harness()
    const next = fakeResponse()
    expect(bridge.resume(id, 0, next.response, 'tok')).toBe(true)
    up().onMessage('{"t":"control"}')
    expect(next.events().some((e) => e.event === 'c')).toBe(true)
  })

  it('gives the viewport up soon after the phone goes, and offers again on return is the phone\'s to do', async () => {
    const { first, sent } = harness()
    first.close()
    await tick(SOCKET_BRIDGE_RELEASE_MS + 50)
    expect(sent).toEqual(['{"t":"viewport-release"}'])
  })

  it('a phone back in time keeps it', async () => {
    const { bridge, id, first, sent } = harness()
    first.close()
    bridge.resume(id, 0, fakeResponse().response, 'tok')
    await tick(SOCKET_BRIDGE_RELEASE_MS + 50)
    expect(sent).toEqual([])
  })

  it('ends the viewer once the phone has been gone too long', async () => {
    let now = 0
    const { first, state, bridge } = harness({ now: () => now })
    first.close()
    now = SOCKET_BRIDGE_RESUME_MS + 1
    bridge.sweep()
    expect(state.closed).toBe(true)
    expect(bridge.size()).toBe(0)
  })

  it('a phone that says it is leaving ends at once', () => {
    const { bridge, id, state } = harness()
    bridge.post(id, { end: true }, 'tok')
    expect(state.closed).toBe(true)
  })

  it('a phone from before this keeps the old behaviour: no resume, the viewer ends with the stream', () => {
    let deps!: LoopbackSocketDeps
    const state = { closed: false }
    const bridge = createSocketBridge({
      dial: (d) => {
        deps = d
        return { send: () => undefined, close: () => void (state.closed = true), pause: () => undefined, resume: () => undefined } as LoopbackSocket
      }
    })
    const old = fakeResponse()
    bridge.open('/api/browser/b1/stream', old.response, 'tok')
    deps.onOpen()
    expect(old.events()[0].data).not.toContain('"v"')
    old.close()
    expect(state.closed).toBe(true)
  })
})

describe('a session answers only to the phone that opened it', () => {
  it('refuses input from another paired device that learned the id', () => {
    const { bridge, id, sent, state } = harness()
    expect(bridge.post(id, { s: 1, m: ['a'] }, 'other')).toBe(false)
    expect(bridge.post(id, { end: true }, 'other')).toBe(false)
    expect(sent).toEqual([])
    expect(state.closed).toBe(false)
  })
})

describe('input arrives once, in order, whatever the line did', () => {
  it('holds a later POST until the earlier one lands', () => {
    const { bridge, id, sent } = harness()
    bridge.post(id, { s: 3, m: ['c'] }, 'tok')
    expect(sent).toEqual([])
    bridge.post(id, { s: 1, m: ['a', 'b'] }, 'tok')
    expect(sent).toEqual(['a', 'b', 'c'])
  })

  it('takes a retry whose first try got through without saying the words twice', () => {
    const { bridge, id, sent } = harness()
    bridge.post(id, { s: 1, m: ['a', 'b'] }, 'tok')
    bridge.post(id, { s: 1, m: ['a', 'b'] }, 'tok')
    bridge.post(id, { s: 2, m: ['b', 'c'] }, 'tok')
    expect(sent).toEqual(['a', 'b', 'c'])
  })

  it('skips a blanked stale item', () => {
    const { bridge, id, sent } = harness()
    bridge.post(id, { s: 1, m: ['', 'b'] }, 'tok')
    expect(sent).toEqual(['b'])
  })

  it('still takes a POST while the stream is down', () => {
    const { bridge, id, first, sent } = harness()
    first.close()
    expect(bridge.post(id, { s: 1, m: ['a'] }, 'tok')).toBe(true)
    expect(sent).toEqual(['a'])
  })
})

describe('frames go at the speed the phone paints them', () => {
  const frames = (events: { event: string }[]): number => events.filter((e) => e.event === 'f').length

  it('stops at the credit and goes on when the phone says it painted', async () => {
    const { bridge, id, first, up } = harness()
    for (let i = 1; i <= 20; i += 1) {
      up().onMessage(frame(i))
      await tick(80)
      if (frames(first.events()) >= SOCKET_BRIDGE_CREDIT) break
    }
    up().onMessage(frame(50))
    await tick(120)
    expect(frames(first.events())).toBe(SOCKET_BRIDGE_CREDIT)
    bridge.post(id, { a: 50 }, 'tok')
    await tick(120)
    expect(frames(first.events())).toBe(SOCKET_BRIDGE_CREDIT + 1)
    expect(first.events().at(-1)?.data).toContain('pic50')
  })

  it('sends one tiny beat instead of a picture that has not changed, and it costs no credit', async () => {
    const { first, up } = harness()
    up().onMessage(frame(1, 'same-picture'))
    await tick(120)
    up().onMessage(frame(2, 'same-picture'))
    up().onMessage(frame(3, 'same-picture'))
    await tick(20)
    const events = first.events()
    expect(frames(events)).toBe(1)
    const beats = events.filter((e) => e.event === 'b').map((e) => JSON.parse(e.data) as { seq: number })
    expect(beats.map((b) => b.seq)).toEqual([2, 3])
    expect(events.at(-1)?.data.length).toBeLessThan(80)
  })

  it('sends more while receipts come back fast, and backs off when they slow down', async () => {
    let now = 1000
    const { bridge, id, first, up } = harness({ now: () => now })
    let seq = 0
    const oneFrame = async (took: number): Promise<void> => {
      seq += 1
      now += 70
      up().onMessage(frame(seq))
      await tick(0)
      now += took
      bridge.post(id, { a: seq }, 'tok')
      await tick(0)
    }
    /** How many go before the first receipt, then clear them. */
    const burst = async (): Promise<number> => {
      const before = frames(first.events())
      for (let i = 0; i < 10; i += 1) {
        seq += 1
        now += 70
        up().onMessage(frame(seq))
        await tick(0)
      }
      const sent = frames(first.events()) - before
      now += 3000
      await tick(0)
      return sent
    }
    for (let i = 0; i < 12; i += 1) await oneFrame(100)
    expect(await burst()).toBeGreaterThan(SOCKET_BRIDGE_CREDIT)
    for (let i = 0; i < 8; i += 1) await oneFrame(900)
    expect(await burst()).toBeLessThanOrEqual(SOCKET_BRIDGE_CREDIT + 1)
  })

  it('a viewport that changed gets a whole picture, even of the same bytes', async () => {
    const { first, up } = harness()
    up().onMessage(JSON.stringify({ t: 'frame', seq: 1, data: 'p', meta: { revision: 1 } }))
    await tick(100)
    up().onMessage(JSON.stringify({ t: 'frame', seq: 2, data: 'p', meta: { revision: 3 } }))
    await tick(100)
    expect(frames(first.events())).toBe(2)
  })

  it('a lost receipt does not stop the picture for good', async () => {
    let now = 0
    const { first, up } = harness({ now: () => now })
    for (let i = 1; i <= SOCKET_BRIDGE_CREDIT; i += 1) {
      now += 100
      up().onMessage(frame(i))
      await tick(5)
    }
    expect(frames(first.events())).toBe(SOCKET_BRIDGE_CREDIT)
    now += 60_000
    up().onMessage(frame(99))
    await tick(5)
    expect(first.events().at(-1)?.data).toContain('pic99')
  })
})
