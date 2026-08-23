// The annotation sidecar is keyed by checkpoint INDEX, and a checkpoint index
// is not an identity — it is a position in a lineage.
//
// That is fine for as long as nothing renumbers. Three things do: a fold, a
// rewind, and (the reason this file exists) recovering the checkpoints a
// compact orphaned, which renumbers 1..N to their true continuous positions.
//
// When a renumber happens, an index-keyed annotation does NOT become orphaned.
// It stays attached to a number that now names a DIFFERENT turn — so a Sous
// title, an acknowledge marker or a scrollback anchor silently describes the
// wrong conversation. Nothing errors, nothing is missing, and the UI cannot
// falsify it: the only person who could notice is the owner, who has no reason
// to suspect the title beside a checkpoint was written about another one.
//
// The architecture already claims this cannot happen. ledger-rebuild.ts says
// the ledger is a DERIVED INDEX, disposable and regenerable from the
// transcript. turn-annotations.ts:10 says mixing annotations into that index
// means it "cannot actually be treated as disposable". Both cannot be true.
// Today the second one is, which makes the first one false.
//
// THE FIRST TEST BELOW IS THE JUSTIFICATION FOR RE-KEYING and must be RED
// against current dev: it renumbers with the existing index keying and shows an
// annotation landing on the wrong turn. The rest hold the fix.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnnotationStore } from '../src/main/turn-annotations'
import { alignToLedger } from '../src/main/turn-tracker'
import type { TurnRecord } from '../src/shared/turn'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'annotation-rekey-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const AGENT = 'agent-1'

/** Two checkpoints with stable transcript uuids, as every real record has. */
const before: TurnRecord[] = [
  {
    index: 1,
    uuid: 'aaaaaaaa-1111-4111-8111-111111111111',
    prompt: 'the compact summary',
    reply: 'ok',
    startedAt: 10,
    endedAt: 20
  },
  {
    index: 2,
    uuid: 'bbbbbbbb-2222-4222-8222-222222222222',
    prompt: 'fix the rail',
    reply: 'done',
    startedAt: 30,
    endedAt: 40
  }
]

/**
 * The same two checkpoints after lineage recovery: identical conversation,
 * identical uuids, renumbered to their true positions behind 398 recovered
 * predecessors. This is exactly what part A does to Commander's ledger.
 */
const after: TurnRecord[] = before.map((r) => ({ ...r, index: r.index + 398 }))

describe('an annotation must follow its checkpoint through a renumber', () => {
  /** Save the pre-recovery ledger: checkpoint 2 carries the owner's title. */
  function seed(store: AnnotationStore): void {
    store.save(AGENT, [before[0], { ...before[1], title: 'fix the rail' }])
  }

  it('a renumber WITHOUT the re-key destroys the annotations (why this exists)', () => {
    // RED against dev before rekeyByUuid existed. Measured, not assumed: a
    // rebuild carries no annotations — derivedFields excludes them on purpose
    // — so saving rebuilt records replaces the whole map and the owner's
    // titles are GONE, not merely misfiled. The misfiling variant is the other
    // half: keep the annotations, move the indices, and every one of them then
    // describes a different turn. Both are unacceptable and both are why a
    // renumber must go through the re-key rather than through a bare save.
    const store = new AnnotationStore(dir)
    seed(store)
    expect(store.load(AGENT).get(2)?.title).toBe('fix the rail')

    store.save(AGENT, after) // the naive recovery: rebuild, then save
    expect([...store.load(AGENT)]).toEqual([])
  })

  it('the title follows its checkpoint by uuid', () => {
    const store = new AnnotationStore(dir)
    seed(store)
    const report = store.rekeyByUuid(AGENT, before, after)
    expect(report.moved).toBe(1)
    expect(store.load(AGENT).get(400)?.title).toBe('fix the rail')
  })

  it('does not leave the title on the number it used to occupy', () => {
    const store = new AnnotationStore(dir)
    seed(store)
    store.rekeyByUuid(AGENT, before, after)
    expect(store.load(AGENT).get(2)).toBeUndefined()
  })

  it('REFUSES rather than guesses when a checkpoint cannot be matched', () => {
    // Condition 3: an annotation whose index maps to no checkpoint is reported
    // and LEFT ALONE. Losing one loudly beats moving it quietly.
    const store = new AnnotationStore(dir)
    store.save(AGENT, [{ ...before[0], index: 99, title: 'orphan' }])
    const report = store.rekeyByUuid(AGENT, before, after)
    expect(report.unmatched).toContain(99)
    expect(store.load(AGENT).get(99)?.title).toBe('orphan')
  })

  it('is idempotent — running it twice changes nothing', () => {
    const store = new AnnotationStore(dir)
    seed(store)
    store.rekeyByUuid(AGENT, before, after)
    const once = store.load(AGENT).get(400)?.title
    const second = store.rekeyByUuid(AGENT, before, after)
    expect(store.load(AGENT).get(400)?.title).toBe(once)
    expect(second.moved).toBe(0)
  })
})

/**
 * THE COUNTER DERIVES FROM THE RECORD.
 *
 * parseSessionTurns numbers a transcript from 1 — all one file can know. After
 * a compact or a lineage recovery the ledger holds a history spanning several
 * transcripts, so the parse calls a turn "1" that the record calls 598, and the
 * next reconcile overwrites recovered history with live turns. Same defect as
 * the original bug, one layer up: the durable record is the truth and the
 * parse is a cache of it that can disagree.
 */
describe('alignToLedger', () => {
  const rec = (index: number, uuid: string): TurnRecord =>
    ({ index, uuid, prompt: `p${index}`, reply: 'r', startedAt: index, endedAt: index + 1 })

  it('continues from where the ledger says this run sits', () => {
    const ledger = [rec(597, 'u-a'), rec(598, 'u-b'), rec(599, 'u-c')]
    const parsed = [rec(1, 'u-b'), rec(2, 'u-c')] // the transcript numbers from 1
    expect(alignToLedger(ledger, parsed).map((r) => r.index)).toEqual([598, 599])
  })

  it('leaves an ordinary single-transcript agent untouched', () => {
    const ledger = [rec(1, 'u-a'), rec(2, 'u-b')]
    expect(alignToLedger(ledger, [rec(1, 'u-a'), rec(2, 'u-b')]).map((r) => r.index)).toEqual([1, 2])
  })

  it('does not invent an alignment for a conversation the ledger has never seen', () => {
    // A wrong offset is the same silent overwrite in the other direction.
    const ledger = [rec(597, 'u-a')]
    expect(alignToLedger(ledger, [rec(1, 'u-new')]).map((r) => r.index)).toEqual([1])
  })

  it('is a no-op against an empty ledger, and on records without uuids', () => {
    expect(alignToLedger([], [rec(1, 'u-a')]).map((r) => r.index)).toEqual([1])
    const noUuid = [{ index: 1, prompt: 'p', reply: 'r', startedAt: 0, endedAt: 1 } as TurnRecord]
    expect(alignToLedger([rec(9, 'u-a')], noUuid).map((r) => r.index)).toEqual([1])
  })
})
