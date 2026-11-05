// F10 (Menu QA, 2026-11-04): a box send left the words in the agent's line and
// nothing submitted, both /raw answering 200. Measured on a real agent: 300
// characters and Enter back to back stuck 4 times in 6, with 150 ms between
// them 0 in 5. An Enter inside the burst is taken for part of a paste.
import { describe, expect, it } from 'vitest'
import { submitDelayMs } from '../src/main/ask'
import { blockAsPaste, createEnterPacing, createPacedInput } from '../src/main/enter-pacing'

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
  it('a person typing is no burst: one key at a time, in a shell, in vim, at a menu', async () => {
    const { pace, waits } = clock()
    for (const key of ['l', 's', '\x1b[A', '\x7f']) await pace('t', key)
    await pace('t', '\r')
    expect(waits).toEqual([])
  })
  it('a pasted block is one, bracketed or not', async () => {
    const { pace, waits } = clock()
    await pace('t', '\x1b[200~some words\x1b[201~')
    await pace('t', '\r')
    expect(waits.length).toBe(1)
  })
  it('a typist long past the burst does not wait', async () => {
    const { pace, waits, tick } = clock()
    await pace('t', 'xx')
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

// The desktop: IPC has no queue behind it, so an Enter that waits must not let
// the keys after it pass. Measured the same way: 300 characters and Enter in
// one tick stuck 2 times in 6, and 1500 stuck 2 in 6.
describe('input with nothing to keep it in order', () => {
  const lane = (): { input: (id: string, data: string) => void; wrote: string[]; release: () => Promise<void>; tick: (ms: number) => void; waits: number[] } => {
    let now = 1000
    const wrote: string[] = []
    const waits: number[] = []
    const pending: Array<() => void> = []
    const input = createPacedInput((id, data) => wrote.push(`${id}:${data}`), {
      now: () => now,
      sleep: (ms) => {
        waits.push(ms)
        return new Promise((resolve) => pending.push(resolve))
      }
    })
    return {
      input,
      wrote,
      waits,
      tick: (ms) => void (now += ms),
      release: async () => {
        now += waits.at(-1) ?? 0
        pending.shift()?.()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
  }
  it('keys go at once: typing never waits', () => {
    const { input, wrote, waits } = lane()
    input('t', 'a')
    input('t', 'b')
    expect(wrote).toEqual(['t:a', 't:b'])
    expect(waits).toEqual([])
  })
  it('an Enter right behind words waits, and goes', async () => {
    const { input, wrote, waits, release } = lane()
    input('t', 'x'.repeat(300))
    input('t', '\r')
    expect(wrote).toEqual([`t:${'x'.repeat(300)}`])
    expect(waits).toEqual([submitDelayMs(300)])
    await release()
    expect(wrote.at(-1)).toBe('t:\r')
  })
  it('keys behind that Enter stay behind it, in order', async () => {
    const { input, wrote, release } = lane()
    input('t', 'words')
    input('t', '\r')
    input('t', 'n')
    input('t', 'e')
    await release()
    expect(wrote).toEqual(['t:words', 't:\r', 't:n', 't:e'])
  })
  it('another terminal does not wait on it', () => {
    const { input, wrote } = lane()
    input('t', 'words')
    input('t', '\r')
    input('u', 'k')
    expect(wrote).toEqual(['t:words', 'u:k'])
  })
  it('an Enter after a pause goes at once', () => {
    const { input, wrote, tick } = lane()
    input('t', 'words')
    tick(5000)
    input('t', '\r')
    expect(wrote).toEqual(['t:words', 't:\r'])
  })
  it('a write that throws does not take the keys behind it', async () => {
    const wrote: string[] = []
    let open: () => void = () => undefined
    const input = createPacedInput(
      (_id, data) => {
        if (data === '\r') throw new Error('gone')
        wrote.push(data)
      },
      { now: () => 1000, sleep: () => new Promise((resolve) => (open = resolve)) }
    )
    input('t', 'words')
    input('t', '\r')
    input('t', '\x03')
    open()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(wrote).toEqual(['words', '\x03'])
    input('t', 'k')
    expect(wrote.at(-1)).toBe('k')
  })
  it('a second send queued behind the wait is paced in its turn', async () => {
    const { input, wrote, waits, release } = lane()
    input('t', 'one')
    input('t', '\r')
    input('t', 'two')
    input('t', '\r')
    await release()
    expect(wrote).toEqual(['t:one', 't:\r', 't:two'])
    expect(waits.length).toBe(2)
    await release()
    expect(wrote).toEqual(['t:one', 't:\r', 't:two', 't:\r'])
  })
})

// Measured on a real agent, read back from its transcript (2026-11-05): raw
// blocks of 900 characters arrived whole 4 of 4, of 1000 1 of 4, of 1500 2 of 4,
// with the words cut and the attach dropped. Bracketed: 15 of 15, up to 6000.
describe('a block of words for an agent', () => {
  const OPEN = '\x1b[200~'
  const CLOSE = '\x1b[201~'
  it('goes as a paste once it is long', () => {
    const words = 'x'.repeat(1500)
    expect(blockAsPaste(words)).toBe(`${OPEN}${words}${CLOSE}`)
  })
  it('short words and a person\'s keys go as they are', () => {
    for (const data of ['a', 'hello', 'x'.repeat(511), '\x7f', '\r', '\x1b[A']) expect(blockAsPaste(data)).toBe(data)
  })
  it('backspaces ahead of the words stay keys, and only the words are pasted', () => {
    const words = 'x'.repeat(600)
    expect(blockAsPaste(`\x7f\x7f${words}`)).toBe(`\x7f\x7f${OPEN}${words}${CLOSE}`)
  })
  it('lines and tabs are words too', () => {
    const words = `one\ttwo\n${'x'.repeat(600)}`
    expect(blockAsPaste(words)).toBe(`${OPEN}${words}${CLOSE}`)
  })
  it('counts bytes: 200 Chinese characters are 600 of them', () => {
    const words = '中'.repeat(200)
    expect(blockAsPaste(words)).toBe(`${OPEN}${words}${CLOSE}`)
  })
  it('a phone batch with a Backspace in it: the words after the last key are pasted', () => {
    const words = 'x'.repeat(600)
    expect(blockAsPaste(`ab\x7f${words}`)).toBe(`ab\x7f${OPEN}${words}${CLOSE}`)
  })
  it('never wraps what carries an Enter or a sequence of its own', () => {
    for (const data of [`${'x'.repeat(600)}\r`, `\x1b[200~${'x'.repeat(600)}\x1b[201~`, `${'x'.repeat(600)}\x03`, `\r\x7f${'x'.repeat(600)}`]) expect(blockAsPaste(data)).toBe(data)
  })
})
