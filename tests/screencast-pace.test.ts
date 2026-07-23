import { describe, expect, it } from 'vitest'
import { DEFAULT_DRAIN_THRESHOLD, decideAck } from '../src/main/screencast-pace'

// Backpressure = the latency knob. CDP won't send the next screencast frame
// until we ack the current one. Acking IMMEDIATELY lets CDP outrun the LAN and
// bloat the socket buffer (growing latency); acking only once the socket has
// DRAINED bounds in-flight to ~one frame — lowest latency. `drainThreshold` is
// the knob: bytes of socket buffer we tolerate before deferring the ack.

describe('decideAck', () => {
  it('acks now when the socket is drained (buffer under threshold)', () => {
    expect(decideAck({ bufferedAmount: 0, drainThreshold: 64_000 })).toEqual({
      ackNow: true,
      deferUntilDrain: false
    })
    expect(decideAck({ bufferedAmount: 64_000, drainThreshold: 64_000 })).toMatchObject({ ackNow: true })
  })
  it('defers the ack while the socket is backed up (over threshold)', () => {
    expect(decideAck({ bufferedAmount: 64_001, drainThreshold: 64_000 })).toEqual({
      ackNow: false,
      deferUntilDrain: true
    })
  })
  it('a tighter threshold holds acks sooner (lower latency, lower fps)', () => {
    const buffered = 20_000
    expect(decideAck({ bufferedAmount: buffered, drainThreshold: 8_000 }).ackNow).toBe(false)
    expect(decideAck({ bufferedAmount: buffered, drainThreshold: 64_000 }).ackNow).toBe(true)
  })
  it('exposes a sane default threshold', () => {
    expect(DEFAULT_DRAIN_THRESHOLD).toBeGreaterThan(0)
    expect(decideAck({ bufferedAmount: 0, drainThreshold: DEFAULT_DRAIN_THRESHOLD }).ackNow).toBe(true)
  })
})
