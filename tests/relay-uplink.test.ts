import { describe, expect, it } from 'vitest'
import { encodeFrame, type RelayFrame } from '../src/shared/relay-frame'
import type { LinkReceipt } from '../src/main/canvas-link'
import { createRelayPace } from '../src/main/relay-pace'
import { createRelayUplink, RELAY_LANE_HIGH, RELAY_LANE_LOW, RELAY_UNPACED_BUDGET } from '../src/main/relay-uplink'

/**
 * A line the test holds by hand: what was written, what is still out there,
 * and receipts sent when the test says so.
 */
const fakeLine = (options: { paced?: boolean; drains?: boolean } = {}) => {
  const sent: string[] = []
  const listeners = new Set<(receipt: LinkReceipt) => void>()
  let written = 0
  let acked = 0
  let paced = options.paced ?? true
  return {
    sent,
    line: {
      send: (text: string) => {
        sent.push(text)
        written += text.length + 1
      },
      // `drains`: Node hands everything on at once, as on a fast line.
      backlog: () => (options.drains ? 0 : written - acked),
      paced: () => paced,
      onReceipt: (listener: (receipt: LinkReceipt) => void) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      }
    },
    /** The relay confirms everything written so far. */
    confirm: (rttMs = 100) => {
      const fresh = written - acked
      acked = written
      listeners.forEach((listener) => listener({ acked: fresh, inFlight: 0, rttMs }))
    },
    unpace: () => void (paced = false),
    /** Nothing out there any more, as Node would say once its buffer drained. */
    drained: () => void (acked = written)
  }
}

const chunk = (id: string, bytes: number): [string, RelayFrame] => {
  const frame: RelayFrame = { t: 'chunk', id, data: 'a'.repeat(bytes) }
  return [encodeFrame(frame), frame]
}
const head = (id: string): [string, RelayFrame] => {
  const frame: RelayFrame = { t: 'head', id, status: 200, headers: {} }
  return [encodeFrame(frame), frame]
}
const idsOf = (sent: readonly string[]): string[] => sent.map((text) => (JSON.parse(text) as { id: string }).id)

/** A pace held at a fixed window, so the test decides what fits. */
const fixed = (bytes: number) => ({ ...createRelayPace(), window: () => bytes })

describe('the relay uplink', () => {
  it('lets out only a window of answers, and the rest as receipts come back', () => {
    const { sent, line, confirm } = fakeLine()
    const uplink = createRelayUplink(line, { pace: fixed(50_000), retryMs: 1_000_000 })
    for (let i = 0; i < 4; i += 1) uplink.send(...chunk('big', 30_000))
    // 30 KB is out; a second would not have fitted under 50 KB... it is let
    // out once what is out drops below the window, so two go before the line is full.
    expect(sent.length).toBe(2)
    expect(uplink.queued()).toBeGreaterThan(50_000)
    confirm()
    expect(sent.length).toBe(4)
    expect(uplink.queued()).toBe(0)
  })

  it('sends a small answer ahead of a big one already waiting', () => {
    const { sent, line, confirm } = fakeLine()
    const uplink = createRelayUplink(line, { pace: fixed(40_000), retryMs: 1_000_000 })
    for (let i = 0; i < 6; i += 1) uplink.send(...chunk('big', 30_000))
    uplink.send(...head('small'))
    uplink.send(...chunk('small', 200))
    confirm()
    // The first thing let out after the receipt is the small answer, whole.
    const after = idsOf(sent).slice(2)
    expect(after.slice(0, 2)).toEqual(['small', 'small'])
  })

  it('throws away what a caller who hung up was going to get', () => {
    const { sent, line, confirm } = fakeLine()
    const uplink = createRelayUplink(line, { pace: fixed(40_000), retryMs: 1_000_000 })
    for (let i = 0; i < 6; i += 1) uplink.send(...chunk('gone', 30_000))
    expect(uplink.queued()).toBeGreaterThan(0)
    uplink.heard(encodeFrame({ t: 'end', id: 'gone' }))
    expect(uplink.queued()).toBe(0)
    confirm()
    expect(idsOf(sent).filter((id) => id === 'gone').length).toBe(2)
    // An abort lets a lane go the same way; anything else heard does not.
    uplink.send(...chunk('also', 30_000))
    uplink.send(...chunk('also', 30_000))
    uplink.send(...chunk('also', 30_000))
    uplink.heard(encodeFrame({ t: 'body', id: 'also', data: '' }))
    expect(uplink.queued()).toBeGreaterThan(0)
    uplink.heard(encodeFrame({ t: 'abort', id: 'also', reason: 'caller-left' }))
    expect(uplink.queued()).toBe(0)
  })

  it('asks the bridge to stop reading an answer whose lane is full, and to go on when it drains', () => {
    const { line, confirm } = fakeLine()
    const uplink = createRelayUplink(line, { pace: fixed(64 * 1024), retryMs: 1_000_000 })
    let resumed = 0
    expect(uplink.room('a', () => void (resumed += 1))).toBe(true)
    while (uplink.queued() <= RELAY_LANE_HIGH) uplink.send(...chunk('a', 30_000))
    expect(uplink.room('a', () => void (resumed += 1))).toBe(false)
    // Receipts drain it a window at a time; past LANE_LOW it is told once.
    while (uplink.queued() > RELAY_LANE_LOW) confirm()
    expect(resumed).toBe(1)
  })

  it('without receipts, holds back only what Node has not sent, as the line did before', () => {
    const { sent, line, unpace, drained } = fakeLine({ paced: false })
    unpace()
    const uplink = createRelayUplink(line, { retryMs: 1_000_000 })
    for (let i = 0; i < 5; i += 1) uplink.send(...chunk('x', 30_000))
    const out = sent.length
    expect(out * 30_000).toBeGreaterThanOrEqual(RELAY_UNPACED_BUDGET)
    drained()
    uplink.send(...head('y'))
    expect(sent.length).toBeGreaterThan(out)
  })

  it('does not remember every exchange it ever carried', () => {
    const { line, sent } = fakeLine({ paced: false, drains: true })
    const uplink = createRelayUplink(line, { retryMs: 1_000_000 })
    // Ten thousand short answers, each gone the moment it is sent, no receipts.
    for (let i = 0; i < 10_000; i += 1) uplink.send(...head(`s${i}`))
    expect(sent.length).toBe(10_000)
    // Before anything else asks queued(), which sweeps too.
    expect(uplink.lanes()).toBeLessThanOrEqual(257)
    expect(uplink.queued()).toBe(0)
  })

  it('throws away the rest of an answer the bridge aborted, and sends the abort', () => {
    const { sent, line } = fakeLine()
    const uplink = createRelayUplink(line, { pace: fixed(40_000), retryMs: 1_000_000 })
    for (let i = 0; i < 6; i += 1) uplink.send(...chunk('a', 30_000))
    const frame: RelayFrame = { t: 'abort', id: 'a', reason: 'line-too-slow' }
    uplink.send(encodeFrame(frame), frame)
    expect(uplink.queued()).toBeLessThan(200)
  })

  it('gives up an answer whose lane never drains, and only once', () => {
    const { line } = fakeLine()
    const timers: (() => void)[] = []
    const uplink = createRelayUplink(line, {
      pace: fixed(64 * 1024),
      retryMs: 1_000_000,
      schedule: (run) => {
        timers.push(run)
        return () => undefined
      }
    })
    while (uplink.queued() <= RELAY_LANE_HIGH) uplink.send(...chunk('a', 30_000))
    let gaveUp = 0
    let resumed = 0
    expect(uplink.room('a', () => void (resumed += 1), () => void (gaveUp += 1))).toBe(false)
    timers.forEach((run) => run())
    expect(gaveUp).toBe(1)
    // The lane draining afterwards resumes nothing: the exchange is over.
    uplink.heard(encodeFrame({ t: 'end', id: 'a' }))
    expect(resumed).toBe(0)
  })

  it('resumes a paused answer when its caller hangs up or the line ends, so nothing waits on a lane that is gone', () => {
    const { line } = fakeLine()
    const uplink = createRelayUplink(line, { pace: fixed(64 * 1024), retryMs: 1_000_000 })
    let resumed = 0
    for (const id of ['a', 'b']) {
      while (uplink.queued() <= RELAY_LANE_HIGH * (id === 'a' ? 1 : 2)) uplink.send(...chunk(id, 30_000))
      expect(uplink.room(id, () => void (resumed += 1))).toBe(false)
    }
    uplink.heard(encodeFrame({ t: 'end', id: 'a' }))
    expect(resumed).toBe(1)
    uplink.reset()
    expect(resumed).toBe(2)
  })

  it('forgets everything when the line ends', () => {
    const { line } = fakeLine()
    const uplink = createRelayUplink(line, { pace: fixed(10_000), retryMs: 1_000_000 })
    for (let i = 0; i < 5; i += 1) uplink.send(...chunk('x', 30_000))
    expect(uplink.queued()).toBeGreaterThan(0)
    uplink.reset()
    expect(uplink.queued()).toBe(0)
  })
})
