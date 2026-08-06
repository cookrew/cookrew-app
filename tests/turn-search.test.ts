import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { TurnStore } from '../src/main/turn-store'
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

/**
 * REFACTOR GUARD (checkpoint-as-identity) — search against the REAL ledger.
 *
 * Every other test here runs on a hand-built ledger, so it only proves the
 * matcher is self-consistent. It cannot catch the failure we actually shipped:
 * search silently missing most of its subject because the corpus says
 * "home assistant" and the reader normalized differently. That bug looked like
 * a working search — it returned hits, just 78% too few — so only a corpus with
 * known content can fail it.
 *
 * Thresholds are floors, measured well under today's real numbers (26 hits /
 * 7 agents over 129 agents at the time of writing) so ordinary ledger churn
 * cannot flake them, while a regression of that magnitude cannot hide.
 *
 * Skips loudly (never silently passes) when the machine has no ledger — CI and
 * fresh clones have none, and a red test there would say nothing about search.
 */
describe('searchTurns — real ledger eval (~/.cookrew/turns)', () => {
  const dir = path.join(homedir(), '.cookrew', 'turns')
  const ledger = existsSync(dir) ? new TurnStore().loadAll() : new Map()
  const CORPUS_MIN_AGENTS = 20
  const usable = ledger.size >= CORPUS_MIN_AGENTS

  if (!usable) {
    it.skip(`no local ledger (${ledger.size} agents at ${dir}) — corpus eval not run`, () => {})
  }

  it.runIf(usable)('finds "homeassistant" across the crew, not just one agent', () => {
    const hits = searchTurns({ ledger, query: 'homeassistant' })
    const agents = new Set(hits.map((h) => h.terminalId))
    // The regression shape: plenty of hits, but collapsed onto one or two
    // agents because most of the corpus stopped matching.
    expect(hits.length).toBeGreaterThanOrEqual(20)
    expect(agents.size).toBeGreaterThanOrEqual(5)
  })

  it.runIf(usable)('still matches when the corpus writes it as two words', () => {
    // "home assistant" is how most of the ledger actually spells it; a reader
    // that only matched the closed-up form lost the majority of the subject.
    const spaced = searchTurns({ ledger, query: 'home assistant' })
    expect(spaced.length).toBeGreaterThanOrEqual(20)
    expect(new Set(spaced.map((h) => h.terminalId)).size).toBeGreaterThanOrEqual(5)
  })

  it.runIf(usable)('every hit can be opened: it names an agent and a checkpoint', () => {
    // A match the rail cannot jump to is worse than no match. terminalId must
    // be a real ledger key and the ordinal must exist in that agent's history.
    for (const hit of searchTurns({ ledger, query: 'cookrew' }).slice(0, 25)) {
      const history = ledger.get(hit.terminalId) as TurnRecord[] | undefined
      expect(history, `hit names unknown agent ${hit.terminalId}`).toBeDefined()
      expect(
        history!.some((r: TurnRecord) => r.index === hit.turnIndex),
        `checkpoint ${hit.turnIndex} not in ${hit.terminalId}'s history`
      ).toBe(true)
    }
  })

  it.runIf(usable)('returns nothing for a term the corpus does not contain', () => {
    expect(searchTurns({ ledger, query: 'zzzz-not-in-any-checkpoint-zzzz' })).toEqual([])
  })
})
