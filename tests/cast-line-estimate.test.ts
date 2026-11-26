// THE LINE ESTIMATE (cast-line-estimate.ts) AGAINST A STALL. Owner's phone on 0.6.43, 2026-11-26: one
// acknowledgement took 5.9 s on the relay (the line stalled), the chunk had gone alone, and the estimate read
// it as a new network: speed 122 -> 6 KB/s, round trip 955 -> 3504 ms, window to the floor
// (cast-stats.jsonl 03:20:16-03:20:27, `reset 1` with `vkey 0`). A stall is one slow acknowledgement; another
// network makes every one slow.
import { describe, expect, it } from 'vitest'
import { LineEstimate } from '../src/main/cast-line-estimate'

const LIMIT = { chunks: 0, maxChunks: 24 }

/** Sends one 20 KB chunk alone at `at` and has it acknowledged `took` ms later. */
function lone(line: LineEstimate, at: number, took: number): number {
  const sent = line.sent(at, 20 * 1024, 0, 512 * 1024, LIMIT)
  line.acked(at + took, sent, 20 * 1024)
  return at + took
}

/** A run of back-to-back chunks, acknowledged as a line of `kbps` and `rttMs` would. */
function busy(line: LineEstimate, from: number, rttMs: number, kbps: number, chunks: number): number {
  let now = from
  const bytes = 20 * 1024
  const crossMs = (bytes / 1024 / kbps) * 1000
  const sent = Array.from({ length: chunks }, (_, i) => line.sent(from + i * crossMs, bytes, i * bytes, 512 * 1024, { chunks: i, maxChunks: 24 }))
  sent.forEach((chunk, i) => {
    now = from + (i + 1) * crossMs + rttMs
    line.acked(now, chunk, bytes)
  })
  return now
}

function learned(): { line: LineEstimate; now: number } {
  const line = new LineEstimate()
  let now = 1_000_000
  for (let round = 0; round < 6; round += 1) {
    now = lone(line, now + 2000, 950)
    now = busy(line, now + 50, 950, 120, 10)
  }
  return { line, now }
}

describe('a stall is not a new network', () => {
  it('a slow lone chunk long ago is not the first of two', () => {
    const { line, now } = learned()
    let at = lone(line, now + 1000, 5900)
    // Busy for over half a minute with no lone chunk, then one slow one: one, not two in a row.
    at = busy(line, at + 40_000, 950, 120, 10)
    lone(line, at + 100, 4200)
    expect(line.forgets).toBe(0)
  })

  it('one acknowledgement 5.9 s late keeps the line: its speed, its round trip, no reset', () => {
    const { line, now } = learned()
    const speed = line.bytesPerSecond
    const rtt = line.roundTripMs
    expect(rtt).toBeGreaterThan(0)
    expect(rtt).toBeLessThan(1500)
    const forgetsBefore = line.forgets
    lone(line, now + 1000, 5900)
    expect(line.forgets).toBe(forgetsBefore)
    expect(line.roundTripMs).toBe(rtt)
    expect(line.bytesPerSecond).toBeGreaterThanOrEqual(speed * 0.5)
  })

  it('a stall, then the line as before: nothing forgotten', () => {
    const { line, now } = learned()
    let at = lone(line, now + 1000, 5900)
    at = lone(line, at + 500, 950)
    lone(line, at + 500, 940)
    expect(line.forgets).toBe(0)
    expect(line.roundTripMs).toBeLessThan(1500)
  })

  it('another network, every lone chunk slow: forgotten on the second', () => {
    const { line, now } = learned()
    let at = lone(line, now + 1000, 4200)
    expect(line.forgets).toBe(0)
    // The confirming probe is due within two round trips, not at the next regular one.
    expect(line.probeDue(at + 2 * line.roundTripMs + 1)).toBe(true)
    at = lone(line, at + 500, 4100)
    expect(line.forgets).toBe(1)
    // Learned from the new line at once: the old line's fast acknowledgements are gone with it.
    expect(line.roundTripMs).toBeGreaterThan(3000)
  })
})
