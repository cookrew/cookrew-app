// THE H.264 SENDER AGAINST A PHONE THAT BEHAVES LIKE THE REAL ONE (tests/support/cast-line-sim.ts):
// acknowledgements newest-only, one POST per 120 ms, BRIDGE_UP_IN_FLIGHT out at once, jitter and stalls on the way up;
// a person who scrolls, rests and lets a caret blink. Owner 2026-11-25: "帧率也很低" — the phone showed
// 0-2 fps on a sealed relay with the window at its floor. A review of a first fix found it locked at the
// floor after a pause and flooded the line under jittered acknowledgements; these are those cases.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { runLine, type Phase } from './support/cast-line-sim'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const scroll = (seconds: number, frameKB = 20): Phase => ({ kind: 'scroll', seconds, frameKB })
const rest = (seconds: number): Phase => ({ kind: 'rest', seconds })
const blink = (seconds: number): Phase => ({ kind: 'blink', seconds, frameKB: 2 })

/** The cases, with what each must reach. Exported so a script can print them for any sender. */
export const LINE_CASES = [
  // Measured once startup is over: what a scroll feels like then. Under half the round trip of queue
  // (the 0.6.41 sender: 0.93 fps, with the line idle most of the time).
  { name: 'a 2 s round trip, 100 KB/s, once started', sim: { kbps: 100, rttMs: 2000, phases: [scroll(15), scroll(30)] }, fps: 3.5, queueMs: 900 },
  { name: 'the relay, 650 ms, 250 KB/s', sim: { kbps: 250, rttMs: 650, phases: [scroll(40)] }, fps: 9, queueMs: 450 },
  { name: 'the relay with 0-300 ms jitter up', sim: { kbps: 250, rttMs: 650, jitterMs: 300, phases: [scroll(40)] }, fps: 8, queueMs: 500 },
  {
    // On a 2 s line a startup that has not finished before the rest overshoots when scrolling starts again:
    // ~1.2 s of queue averaged over the next 20 s, the price of reaching the line in a few rounds rather
    // than ~40 s (the 0.6.41 sender: 0.55 fps, window at its floor).
    name: 'scroll, rest 15 s, a caret, scroll again (2 s line)',
    sim: { kbps: 100, rttMs: 2000, phases: [scroll(10), rest(15), blink(10), scroll(20)] },
    fps: 3,
    queueMs: 1500
  },
  {
    name: 'scroll, rest, a caret, scroll again (the relay)',
    sim: { kbps: 250, rttMs: 650, jitterMs: 150, phases: [scroll(10), rest(15), blink(10), scroll(20)] },
    fps: 8,
    queueMs: 500
  },
  {
    // A line that cannot answer for 3 s in 10 wastes them: 2.35 fps measured (0.6.41: 1.45).
    name: 'the uplink stalls 3 s in every 10 (2 s line)',
    sim: { kbps: 100, rttMs: 2000, stallEveryMs: 10_000, stallMs: 3000, phases: [scroll(40)] },
    fps: 2.2,
    queueMs: 1200
  },
  {
    name: 'the line gets slower, 250 then 80 KB/s',
    sim: { kbps: 250, rttMs: 650, slowerAt: 20, slowerKbps: 80, phases: [scroll(20), scroll(30)] },
    fps: 2.5,
    queueMs: 800
  },
  {
    // Open a page, read it with only the caret blinking, then scroll (review 2026-11-25): rounds that only a
    // caret filled must not end startup at the caret's speed.
    name: 'read with a caret 15 s, then scroll (2 s line)',
    sim: { kbps: 100, rttMs: 2000, phases: [blink(15), scroll(10), scroll(30)] },
    fps: 3.5,
    queueMs: 900
  },
  {
    // A quiet spell on the relay, then the phone is on a slow, far network: a fast line's speed must not
    // outlive it and pour a full window onto the new one.
    name: 'rest on the relay, then scroll on a slow far network',
    sim: { kbps: 250, rttMs: 650, slowerAt: 12, slowerKbps: 50, slowerRttMs: 2000, phases: [scroll(10), blink(12), scroll(25)] },
    // KNOWN LIMIT: a line ~5x slower and ~3x farther, met while startup still reads the old speed, carries
    // ~2.5 s of queue averaged over its first 25 s before it drains (0.6.41: no queue, locked at 0.52 fps).
    fps: 1.5,
    queueMs: 2800
  },
  // Review 2026-11-25, round 3: a key frame asked for must not freeze the estimate, poison the round trip, or
  // let chunks still crossing stop counting.
  {
    name: 'the relay, key frames asked at 20 s and 21.5 s',
    sim: { kbps: 250, rttMs: 650, keyAsksAt: [20, 21.5], phases: [scroll(20), scroll(40)] },
    fps: 8,
    queueMs: 600
  },
  {
    name: 'another network (60 KB/s, 2 s) and a key frame asked at 20 s',
    sim: { kbps: 250, rttMs: 650, slowerAt: 20, slowerKbps: 60, slowerRttMs: 2000, keyAsksAt: [20], phases: [scroll(20), scroll(35)] },
    fps: 1.5,
    queueMs: 2500
  },
  {
    name: 'another network while scrolling, no key frame, no pause',
    sim: { kbps: 250, rttMs: 650, slowerAt: 20, slowerKbps: 60, slowerRttMs: 2000, phases: [scroll(20), scroll(40)] },
    fps: 2,
    queueMs: 2500
  },
  {
    name: 'a 2 s line slows to 30 KB/s during startup, 4 KB chunks',
    sim: { kbps: 100, rttMs: 2000, slowerAt: 20, slowerKbps: 30, phases: [scroll(10, 4), blink(10), scroll(30, 4)] },
    // KNOWN LIMIT: the same, ~2.2 s averaged over 30 s (the round-3 review measured 4 s before the startup cap).
    fps: 4,
    queueMs: 2500
  },
  {
    name: 'the relay, a 3 s stall at 2 s (the first round trips)',
    sim: { kbps: 250, rttMs: 650, stallEveryMs: 1_000_000, stallMs: 3000, phases: [scroll(2), scroll(40)] },
    fps: 8,
    queueMs: 600
  },
  {
    // Review round 4: with no chunk ever sent alone, a round trip read from acknowledgements grew with the
    // sender's own queue, and over minutes settled ~3.4 s behind. Measured over the last minute of three.
    name: 'three minutes of scrolling without a pause, relay at 60 KB/s',
    sim: { kbps: 60, rttMs: 650, jitterMs: 100, phases: [scroll(120), scroll(60)] },
    fps: 2.5,
    queueMs: 1000
  },
  {
    name: 'three minutes of scrolling without a pause, a 2 s line at 60 KB/s',
    sim: { kbps: 60, rttMs: 2000, phases: [scroll(120), scroll(60)] },
    fps: 2.5,
    queueMs: 1500
  },
  {
    name: 'the line gets faster, 60 then 200 KB/s',
    sim: { kbps: 60, rttMs: 650, slowerAt: 20, slowerKbps: 200, phases: [scroll(20), scroll(30)] },
    fps: 6,
    queueMs: 500
  }
] as const

describe('the H.264 sender, against a phone that acknowledges as the real one does', () => {
  for (const c of LINE_CASES) {
    it(`${c.name}: at least ${c.fps} fps, under ${c.queueMs} ms of queue`, async () => {
      const result = await runLine(c.sim)
      expect(result.fps).toBeGreaterThan(c.fps)
      expect(result.queueMs).toBeLessThan(c.queueMs)
    }, 120_000)
  }
})
