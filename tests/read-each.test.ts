// The board's tail reads on the companion go through a bounded pump, so a
// keystroke typed in LIVE never queues behind forty previews (2026-11-01).
import { describe, expect, it } from 'vitest'
import { readEach } from '../src/renderer/src/stream/read-each'
import { readFileSync } from 'node:fs'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('readEach', () => {
  it('never has more than atOnce reads in flight, and reads every id once', async () => {
    let inFlight = 0
    let peak = 0
    const seen: string[] = []
    await readEach(['a', 'b', 'c', 'd', 'e'], async (id) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      seen.push(id)
      await tick()
      inFlight -= 1
    }, 2)
    expect(peak).toBe(2)
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('one at a time when asked', async () => {
    let peak = 0
    let inFlight = 0
    await readEach(['a', 'b', 'c'], async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await tick()
      inFlight -= 1
    }, 1)
    expect(peak).toBe(1)
  })

  it('a failed read does not stop the rest', async () => {
    const seen: string[] = []
    await readEach(['a', 'b', 'c'], async (id) => {
      seen.push(id)
      if (id === 'a') throw new Error('miss')
    }, 1)
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('nothing to read resolves at once', async () => {
    await expect(readEach([], async () => undefined, 3)).resolves.toBeUndefined()
  })
})

describe('the board sweep', () => {
  const src = readFileSync('src/renderer/src/stream/use-stream-tails.ts', 'utf8')
  it('reads one tail at a time on the companion, and never starts a sweep over a running one', () => {
    expect(src).toMatch(/REMOTE_READS_AT_ONCE = 1\b/)
    expect(src).toMatch(/if \(sweeping \|\| document\.hidden\) return/)
    // Only what is due is read (tail-schedule.ts, bytes 0.6.2), still one at a time on the companion.
    expect(src).toMatch(/isRemoteMode\(\) \? REMOTE_READS_AT_ONCE : due\.length/)
  })
})
