import { describe, expect, it } from 'vitest'
import { matchTurn, searchTurns } from '../src/shared/turn-search'
import type { TurnRecord } from '../src/shared/turn'

const NOW = 1_800_000_000_000

function turn(over: Partial<TurnRecord> = {}): TurnRecord {
  return {
    index: 1,
    prompt: 'wire the sidebar to the agent selector',
    reply: 'done, three tests red',
    title: 'Wire the sidebar',
    startedAt: NOW - 60_000,
    endedAt: NOW - 30_000,
    ...over,
  } as TurnRecord
}

const ledger = (records: TurnRecord[]): Map<string, TurnRecord[]> => new Map([['t1', records]])

describe('matchTurn', () => {
  it('finds a term in the recap, the ask or the reply', () => {
    expect(matchTurn('t1', turn(), ['sidebar'])?.field).toBe('title')
    expect(matchTurn('t1', turn({ title: undefined }), ['selector'])?.field).toBe('prompt')
    expect(matchTurn('t1', turn({ title: undefined, prompt: '' }), ['red'])?.field).toBe('reply')
  })

  it('is case-insensitive', () => {
    expect(matchTurn('t1', turn(), ['SIDEBAR'])).not.toBeNull()
  })

  it('requires EVERY term, though they may land in different fields', () => {
    expect(matchTurn('t1', turn(), ['sidebar', 'selector'])).not.toBeNull()
    expect(matchTurn('t1', turn(), ['sidebar', 'banana'])).toBeNull()
  })

  it('reports the checkpoint ordinal, which is what the rail jumps to', () => {
    expect(matchTurn('t1', turn({ index: 47 }), ['sidebar'])?.turnIndex).toBe(47)
  })

  it('survives a turn with no recap and no reply', () => {
    const bare = turn({ title: undefined, reply: undefined })
    expect(matchTurn('t1', bare, ['sidebar'])).not.toBeNull()
    expect(matchTurn('t1', bare, ['nothing'])).toBeNull()
  })
})

/** A match must carry a readable line, never the turn body. */
describe('snippets', () => {
  it('returns context around the hit rather than the whole field', () => {
    const long = 'x'.repeat(4000) + ' HOMEASSISTANT ' + 'y'.repeat(4000)
    const match = matchTurn('t1', turn({ title: undefined, prompt: long, reply: undefined }), [
      'homeassistant',
    ])
    expect(match).not.toBeNull()
    expect(match!.snippet.length).toBeLessThan(200)
    expect(match!.snippet.toLowerCase()).toContain('homeassistant')
  })

  it('collapses newlines so a snippet is one line', () => {
    const match = matchTurn('t1', turn({ title: undefined, prompt: 'a\n\n\nb sidebar c' }), [
      'sidebar',
    ])
    expect(match!.snippet).not.toContain('\n')
  })

  it('marks that it elided the head', () => {
    const long = 'lead '.repeat(60) + 'needle'
    const match = matchTurn('t1', turn({ title: undefined, prompt: long, reply: undefined }), [
      'needle',
    ])
    expect(match!.snippet.startsWith('…')).toBe(true)
  })

  it('falls back to the ask when there is no recap to label with', () => {
    const match = matchTurn('t1', turn({ title: undefined }), ['sidebar'])
    expect(match!.title).toContain('wire the sidebar')
  })
})

describe('searchTurns', () => {
  it('returns nothing for an empty query rather than everything', () => {
    expect(searchTurns({ ledger: ledger([turn()]), query: '' })).toEqual([])
    expect(searchTurns({ ledger: ledger([turn()]), query: '   ' })).toEqual([])
  })

  it('searches every agent in the ledger', () => {
    const many = new Map([
      ['a', [turn({ title: 'alpha sidebar' })]],
      ['b', [turn({ title: 'beta sidebar' })]],
    ])
    expect(searchTurns({ ledger: many, query: 'sidebar' })).toHaveLength(2)
  })

  it('ranks a recap hit above a passing mention in a reply', () => {
    const mixed = new Map([
      [
        'reply',
        [turn({ index: 1, title: 'unrelated', prompt: '', reply: 'mentions homeassistant' })],
      ],
      ['recap', [turn({ index: 2, title: 'HomeAssistant routing', prompt: '', reply: '' })]],
    ])
    expect(searchTurns({ ledger: mixed, query: 'homeassistant' })[0].terminalId).toBe('recap')
  })

  it('breaks ties by recency, so the newest of equal hits leads', () => {
    const same = new Map([
      ['old', [turn({ title: 'sidebar', endedAt: NOW - 900_000 })]],
      ['new', [turn({ title: 'sidebar', endedAt: NOW })]],
    ])
    expect(searchTurns({ ledger: same, query: 'sidebar' })[0].terminalId).toBe('new')
  })

  it('caps the response so one query cannot return the whole ledger', () => {
    const lots = ledger(Array.from({ length: 200 }, (_, i) => turn({ index: i })))
    expect(searchTurns({ ledger: lots, query: 'sidebar', limit: 25 })).toHaveLength(25)
  })

  it('never returns a turn body — only a capped snippet', () => {
    const huge = ledger([turn({ reply: 'sidebar ' + 'z'.repeat(50_000) })])
    for (const match of searchTurns({ ledger: huge, query: 'sidebar' })) {
      expect(match.snippet.length).toBeLessThan(200)
    }
  })
})

/**
 * Measured against the real ledger: "homeassistant" found 6 turns while
 * "home assistant" found 27 — the same subject, written both ways across a
 * project's history, and the one-word spelling missed 78% of it. Whitespace
 * inside a term must not decide whether you find your own work.
 */
describe('spacing must not change what you find', () => {
  const written = new Map([
    ['a', [turn({ title: 'Home Assistant LLM framework', prompt: '', reply: undefined })]],
    ['b', [turn({ title: 'HomeAssistant routing', prompt: '', reply: undefined })]],
    ['c', [turn({ title: 'home  assistant  notes', prompt: '', reply: undefined })]],
  ])

  it('finds every spelling from the closed-up query', () => {
    expect(searchTurns({ ledger: written, query: 'homeassistant' })).toHaveLength(3)
  })

  it('finds every spelling from the spaced query', () => {
    expect(searchTurns({ ledger: written, query: 'home assistant' })).toHaveLength(3)
  })

  it('still snippets around the hit when it matched across a space', () => {
    const match = searchTurns({ ledger: written, query: 'homeassistant' }).find(
      (m) => m.terminalId === 'a',
    )
    expect(match!.snippet.toLowerCase()).toContain('home assistant')
  })

  it('does not let squashing invent a match across unrelated words', () => {
    const apart = new Map([
      ['x', [turn({ title: 'chrome assistant', prompt: '', reply: undefined })]],
    ])
    expect(searchTurns({ ledger: apart, query: 'homeassistant' })).toEqual([])
  })
})
