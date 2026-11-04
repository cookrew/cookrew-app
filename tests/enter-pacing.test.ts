// F10 (Menu QA, 2026-11-04): a box send left the words in the agent's line and
// nothing submitted, both /raw answering 200. Measured on a real agent: 300
// characters and Enter back to back stuck 4 times in 6, with 150 ms between
// them 0 in 5. An Enter inside the burst is taken for part of a paste.
import { describe, expect, it } from 'vitest'
import { submitDelayMs } from '../src/main/ask'
import { createEnterPacing } from '../src/main/enter-pacing'

const clock = (): { pace: ReturnType<typeof createEnterPacing>; waits: number[]; tick: (ms: number) => void } => {
  let now = 1000
  const waits: number[] = []
  const pace = createEnterPacing({
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms)
      now += ms
    }
  })
  return { pace, waits, tick: (ms) => void (now += ms) }
}

describe('an Enter after words', () => {
  it('waits out what the TUI needs to take them', async () => {
    const { pace, waits } = clock()
    await pace('t', 'x'.repeat(300))
    await pace('t', '\r')
    expect(waits).toEqual([submitDelayMs(300)])
  })
  it('only the rest of it, when time has passed', async () => {
    const { pace, waits, tick } = clock()
    await pace('t', 'x'.repeat(300))
    tick(100)
    await pace('t', '\r')
    expect(waits).toEqual([submitDelayMs(300) - 100])
  })
  it('counts every batch of the burst', async () => {
    const { pace, waits } = clock()
    await pace('t', 'x'.repeat(1024))
    await pace('t', 'x'.repeat(1024))
    await pace('t', '\r')
    expect(waits).toEqual([submitDelayMs(2048)])
  })
  it('a typist long past the burst does not wait', async () => {
    const { pace, waits, tick } = clock()
    await pace('t', 'x')
    tick(5000)
    await pace('t', '\r')
    expect(waits).toEqual([])
  })
  it('a second Enter, another terminal, and words with their own Enter do not wait', async () => {
    const { pace, waits } = clock()
    await pace('t', 'words')
    await pace('other', '\r')
    await pace('t', '\r')
    await pace('t', '\r')
    await pace('t', 'words and\r')
    expect(waits).toEqual([submitDelayMs(5)])
  })
})
