// THE BOARD'S RESULTS BY KIND: agents, browsers and notes each a section, a
// few of each under ALL so a matching note is on screen next to the agents —
// it used to come after every matching agent — and one kind whole on a chip.
import { describe, expect, it } from 'vitest'
import { foundWords, kindCounts, searchEntries } from '../src/renderer/src/board-sections'
import type { ItemHit } from '../src/renderer/src/item-search'

const item = (id: string, kind: 'note' | 'browser'): ItemHit => ({ node: { kind, id } as ItemHit['node'], score: 1, snippet: null })
const agents = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']
const items = [item('n1', 'note'), item('b1', 'browser'), item('n2', 'note')]
const shape = (entries: ReturnType<typeof searchEntries<string>>): string[] =>
  entries.map((e) => (e.kind === 'head' ? `#${e.of}` : e.kind === 'more' ? `+${e.hidden}` : e.kind === 'agent' ? e.row : e.hit.node.id))

describe('ALL', () => {
  it('puts each kind under its head, agents then browsers then notes, a few of each', () => {
    expect(shape(searchEntries(agents, items, 'all', 5))).toEqual([
      '#agent', 'a1', 'a2', 'a3', 'a4', 'a5', '+2',
      '#browser', 'b1',
      '#note', 'n1', 'n2',
    ])
  })

  it('leaves out a kind that found nothing', () => {
    expect(shape(searchEntries([], items, 'all'))).toEqual(['#browser', 'b1', '#note', 'n1', 'n2'])
  })
})

describe('one kind', () => {
  it('is all of that kind, in rank order, with no head', () => {
    expect(shape(searchEntries(agents, items, 'note'))).toEqual(['n1', 'n2'])
    expect(shape(searchEntries(agents, items, 'agent'))).toEqual(agents)
  })
})

describe('the count on the head', () => {
  it('names only the kinds that found something', () => {
    expect(foundWords(kindCounts(agents, items))).toBe('7 agents · 1 browser · 2 notes')
    expect(foundWords(kindCounts([], [item('n1', 'note')]))).toBe('1 note')
    expect(foundWords(kindCounts([], []))).toBe('nothing found')
  })
})
