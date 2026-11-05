// A FULL RELAY IS WAITED OUT, NEVER SHOWN RAW (relay-full.ts). The phone put
// `too_many_exchanges` on screen while the Mac was stalled (2026-11-05).
import { describe, expect, it, vi } from 'vitest'
import { RELAY_FULL, RELAY_FULL_WAITS_MS, isRelayFull, waitOutRelayFull } from '../src/renderer/src/relay-full'

const noSleep = (): Promise<void> => Promise.resolve()
const full = (): Error & { status: number } => Object.assign(new Error(RELAY_FULL), { status: 503 })

describe('isRelayFull', () => {
  it('knows the relay’s refusal', () => {
    expect(isRelayFull(full())).toBe(true)
  })

  it('leaves every other failure alone', () => {
    expect(isRelayFull(Object.assign(new Error('no_link'), { status: 503 }))).toBe(false)
    expect(isRelayFull(Object.assign(new Error(RELAY_FULL), { status: 500 }))).toBe(false)
    expect(isRelayFull(new Error('Failed to fetch'))).toBe(false)
    expect(isRelayFull(null)).toBe(false)
  })
})

describe('waitOutRelayFull', () => {
  it('answers with the attempt that got through', async () => {
    let calls = 0
    const attempt = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw full()
      return 'opened'
    })
    await expect(waitOutRelayFull(attempt, noSleep)).resolves.toBe('opened')
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('gives up after its waits and hands back the refusal', async () => {
    const attempt = vi.fn(async () => {
      throw full()
    })
    await expect(waitOutRelayFull(attempt, noSleep)).rejects.toMatchObject({ status: 503, message: RELAY_FULL })
    expect(attempt).toHaveBeenCalledTimes(RELAY_FULL_WAITS_MS.length + 1)
  })

  it('never repeats a request the Mac may have seen', async () => {
    const lost = Object.assign(new Error('timed_out'), { status: 504 })
    const attempt = vi.fn(async () => {
      throw lost
    })
    await expect(waitOutRelayFull(attempt, noSleep)).rejects.toBe(lost)
    expect(attempt).toHaveBeenCalledTimes(1)
  })
})
