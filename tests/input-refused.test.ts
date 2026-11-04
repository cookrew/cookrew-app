// A phone's words refused by the Mac (a dispatch in flight answers /raw with a
// 409) used to vanish: the box had cleared as if they went, and the keys were
// fire and forget. The refusal comes back, and the words with it.
import { describe, expect, it } from 'vitest'
import { inputRefused, noteSent, REFUSED_WINDOW_MS, takeRefused, wordsToRestore, type SentWords } from '../src/renderer/src/prompt/input-refused'

const sent: SentWords = { id: 'a', box: 'a', words: 'hello', at: 1000 }

describe('the words a refusal gives back', () => {
  it('are the last sent to that agent', () => {
    expect(wordsToRestore(sent, 'a', '\r', 1500)).toBe(sent)
  })
  it('never another agent\'s', () => {
    expect(wordsToRestore(sent, 'b', '\r', 1500)).toBe(null)
  })
  it('nor words long gone: a late refusal of stray keys is not about them', () => {
    expect(wordsToRestore(sent, 'a', '\r', 1000 + REFUSED_WINDOW_MS + 1)).toBe(null)
  })
  it('only a refused Enter speaks for them: not their keystrokes, not a later arrow', () => {
    expect(wordsToRestore(sent, 'a', 'hello', 1500)).toBe(null)
    expect(wordsToRestore(sent, 'a', '\x1b[A', 1500)).toBe(null)
  })
  it('come back once', () => {
    noteSent(sent)
    expect(takeRefused('a', '\r', 1500)).toBe(sent)
    expect(takeRefused('a', '\r', 1600)).toBe(null)
  })
  it('nothing sent, nothing back', () => {
    expect(wordsToRestore(null, 'a', '\r', 1500)).toBe(null)
  })
})

describe('the refusal itself', () => {
  it('reaches whoever listens, until they stop', () => {
    const heard: string[] = []
    const stop = inputRefused.subscribe((id) => heard.push(id))
    inputRefused.emit('a', '\r')
    stop()
    inputRefused.emit('b', '\r')
    expect(heard).toEqual(['a'])
  })
})
