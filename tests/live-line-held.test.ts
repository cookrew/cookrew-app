import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../src/renderer/src/api'
import { forgetTyped, holdLines, resetLinesForTests, submitLine, typeLine } from '../src/renderer/src/prompt/live-line'

// Review of bug 2: keys typed at a card that cannot start went nowhere, yet the
// line remembered them as typed. Fix the cause, press Enter, and only Enter went:
// the agent woke to an empty prompt and the words were gone.
describe('a line whose card cannot start', () => {
  const sent: string[] = []

  beforeEach(() => {
    sent.length = 0
    resetLinesForTests()
    holdLines([])
    vi.spyOn(api, 'cookrew').mockReturnValue({ ptyInput: (_id: string, data: string) => void sent.push(data) } as unknown as ReturnType<typeof api.cookrew>)
  })

  afterEach(() => vi.restoreAllMocks())

  it('types nothing while held', () => {
    holdLines(['a'])
    typeLine('a', 'fix it')
    expect(sent).toEqual([])
  })

  it('a send carries all the words, once the cause is fixed', () => {
    holdLines(['a'])
    typeLine('a', 'fix it')
    holdLines([])
    submitLine('a', 'fix it')
    expect(sent).toEqual(['fix it', '\r'])
  })

  it('keys that went to a wake that failed are not counted as typed', () => {
    typeLine('a', 'fix')
    expect(sent).toEqual(['fix'])
    holdLines(['a'])
    holdLines([])
    sent.length = 0
    submitLine('a', 'fix it')
    expect(sent).toEqual(['fix it', '\r'])
  })

  it('a held line still sends on an explicit send', () => {
    holdLines(['a'])
    submitLine('a', 'try again')
    expect(sent).toEqual(['try again', '\r'])
  })

  it('other lines type as ever', () => {
    holdLines(['a'])
    typeLine('b', 'hi')
    expect(sent).toEqual(['hi'])
  })
})

describe('keys a failed wake lost', () => {
  const sent: string[] = []

  beforeEach(() => {
    sent.length = 0
    resetLinesForTests()
    holdLines([])
    vi.spyOn(api, 'cookrew').mockReturnValue({ ptyInput: (_id: string, data: string) => void sent.push(data) } as unknown as ReturnType<typeof api.cookrew>)
  })

  afterEach(() => vi.restoreAllMocks())

  it('are not counted as typed, so a send carries the words whole', () => {
    typeLine('a', 'fix it')
    forgetTyped('a')
    sent.length = 0
    submitLine('a', 'fix it')
    expect(sent).toEqual(['fix it', '\r'])
  })
})
