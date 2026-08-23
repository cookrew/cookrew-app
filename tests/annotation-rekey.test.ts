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
import { alignToLedger, mergeOntoLedger } from '../src/main/turn-tracker'
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

/**
 * THE SEAM ITSELF — which records the run replaces, and which it may not touch.
 *
 * alignToLedger above only ever answers "what numbers do these turns carry".
 * This answers the question that actually decides whether history survives:
 * where does the run's authority begin. Asserted at all three anchor positions,
 * because the two degenerate ones are where a wrong rule hides — a fixture
 * anchored at 0 makes a merge and a replace produce identical output, which is
 * precisely how the round-1 test passed with the bug live.
 */
describe('mergeOntoLedger — the run rules from its anchor, and not before it', () => {
  const rec = (index: number, uuid: string): TurnRecord =>
    ({ index, uuid, prompt: `p${index}`, reply: 'r', startedAt: index, endedAt: index + 1 })
  const ledger = [rec(1, 'u-a'), rec(2, 'u-b'), rec(3, 'u-c')]

  it('anchored MID-ledger: keeps everything ahead of the run, verbatim', () => {
    const { kept, aligned } = mergeOntoLedger(ledger, [rec(1, 'u-b'), rec(2, 'u-c')])
    expect(kept).toEqual([rec(1, 'u-a')])
    expect(aligned.map((r) => r.index)).toEqual([2, 3])
  })

  it('anchored at 0: nothing is ahead of the run, so nothing is kept', () => {
    const { kept, aligned } = mergeOntoLedger(ledger, [rec(1, 'u-a')])
    expect(kept).toEqual([])
    expect(aligned.map((r) => r.index)).toEqual([1])
  })

  it('NOT anchored: keeps nothing — an unplaceable run is never appended', () => {
    // The dangerous temptation is to concat onto the ledger so nothing is lost.
    // That splices a history this run may have no relationship to, and the
    // numbering would look perfect afterwards. No evidence, no join.
    const { kept, aligned } = mergeOntoLedger(ledger, [rec(1, 'u-stranger')])
    expect(kept).toEqual([])
    expect(aligned.map((r) => r.index)).toEqual([1])
  })

  it('keeps nothing against an empty ledger, or a run with no uuid to place', () => {
    expect(mergeOntoLedger([], [rec(1, 'u-a')]).kept).toEqual([])
    const noUuid = [{ index: 1, prompt: 'p', reply: 'r', startedAt: 0, endedAt: 1 } as TurnRecord]
    expect(mergeOntoLedger(ledger, noUuid).kept).toEqual([])
  })
})

/**
 * CRITICAL-1 — the reconcile must align against the DURABLE record, not the
 * tracker's in-memory copy of it.
 *
 * The restore wrote 613 records to disk. The running tracker still held the
 * pre-restore 16 in `histories`, and alignToLedger was handed THAT. The
 * incoming parse's head matched at index 1, so no shift was applied, 16 records
 * were written — and because a full save treats its argument as the whole
 * truth, the other 597 were destroyed in the ledger AND the annotation sidecar.
 *
 * It is the same defect the whole lane is about, one layer deeper: the durable
 * record is the truth and a cache of it can silently disagree. Fixing the
 * counter is not enough if the thing it derives from is itself a cache.
 */
describe('CRITICAL-1: the reconcile aligns against the durable ledger', () => {
  const rec = (index: number, uuid: string): TurnRecord =>
    ({ index, uuid, prompt: `p${uuid}`, reply: 'r', startedAt: index, endedAt: index + 1 })

  it('shifts by what is ON DISK even when memory holds a stale, shorter history', () => {
    // Disk: a recovered 613-record history. Memory: the pre-restore 16.
    const durable = [rec(611, 'u-a'), rec(612, 'u-b'), rec(613, 'u-c')]
    const staleMemory = [rec(1, 'u-a'), rec(2, 'u-b'), rec(3, 'u-c')]
    const parsed = [rec(1, 'u-a'), rec(2, 'u-b'), rec(3, 'u-c')]

    // Against stale memory the head already "matches" at 1, so nothing shifts —
    // which is precisely how 613 became 16 again twenty minutes later.
    expect(alignToLedger(staleMemory, parsed).map((r) => r.index)).toEqual([1, 2, 3])
    // Against the durable record it lands where the record says it belongs.
    expect(alignToLedger(durable, parsed).map((r) => r.index)).toEqual([611, 612, 613])
  })
})

/**
 * CRITICAL-1, ROUND 2 — THE ASSERTION THAT WAS MISSING.
 *
 * The first version of this test was named "does not shrink a restored
 * 613-record ledger back to the parsed 16" and asserted three indices,
 * 611/612/613. It checked the NUMBERING and never the LENGTH, so it passed
 * green while the bug in its own name was live: the reconcile numbered the
 * incoming run correctly and then saved that run AS THE WHOLE HISTORY, and a
 * full save means "these records are the entire truth" — 597 records died on
 * disk and in the annotation sidecar. Atlas measured it against a real store:
 * 613 after the restore, 16 after the next reconcile.
 *
 * Its fixture could not have caught it either. A three-record disk ledger whose
 * head is the incoming head anchors at position 0, where a merge and a replace
 * produce the same array — the degenerate case. So the fixture here is the real
 * shape: 613 on disk, the newest transcript's 16 arriving, anchored at 597.
 *
 * LENGTH IS ASSERTED FIRST AND ON BOTH SIDES OF THE SEAM — the tracker's
 * history and what the store was actually handed — because the ledger is only
 * as durable as the save, and it was the save that destroyed the records.
 */
describe('CRITICAL-1: the reconcile MERGES with the ledger, it does not replace it', () => {
  const rec = (index: number, uuid: string): TurnRecord =>
    ({ index, uuid, prompt: `p${uuid}`, reply: 'r', startedAt: index, endedAt: index + 1 })

  /** A recovered ledger: 613 records spanning the whole lineage. */
  const restored = Array.from({ length: 613 }, (_, at) => rec(at + 1, `u${at + 1}`))
  /** What parsing the NEWEST transcript alone yields: its 16 turns, from 1. */
  const parsedRun = Array.from({ length: 16 }, (_, at) => rec(at + 1, `u${598 + at}`))

  const trackerOver = async (disk: TurnRecord[]) => {
    const { TurnTracker } = await import('../src/main/turn-tracker')
    const saved: TurnRecord[][] = []
    const store = {
      load: () => disk,
      scheduleSave: (_id: string, records: TurnRecord[]) => saved.push(records),
      scheduleDelta: () => undefined,
      flushAll: () => undefined
    }
    const tracker = new TurnTracker(async () => null, store as never)
    return {
      tracker,
      saved,
      history: () =>
        (tracker as unknown as { histories: Map<string, TurnRecord[]> }).histories.get('t1'),
      primeMemory: (records: TurnRecord[]) =>
        (tracker as unknown as { histories: Map<string, TurnRecord[]> }).histories.set('t1', records)
    }
  }

  it('does not shrink a restored 613-record ledger back to the parsed 16', async () => {
    const t = await trackerOver(restored)
    // Memory is deliberately primed with the stale, pre-restore numbering — the
    // exact state the running tracker was in when the owner's history collapsed.
    t.primeMemory(parsedRun)

    t.tracker.replaceHistory('t1', parsedRun)

    // THE LENGTH, FIRST. Everything below is worthless if this is 16.
    expect(t.history()).toHaveLength(613)
    expect(t.saved.at(-1)).toHaveLength(613)
  })

  it('keeps the 597 records the incoming run cannot speak for, unrenumbered', async () => {
    const t = await trackerOver(restored)
    t.primeMemory(parsedRun)

    t.tracker.replaceHistory('t1', parsedRun)

    const history = t.history() ?? []
    // The prefix is preserved verbatim: the reconcile read one transcript and
    // has no evidence about the other 597 turns, so it must not touch them.
    expect(history.slice(0, 597)).toEqual(restored.slice(0, 597))
    // And the incoming run lands where the record says it belongs.
    expect(history.slice(597).map((r) => r.index)).toEqual(
      Array.from({ length: 16 }, (_, at) => 598 + at)
    )
    expect(history.map((r) => r.uuid)).toEqual(restored.map((r) => r.uuid))
  })

  it('still shrinks on a rewind — the incoming run DOES speak for its own tail', async () => {
    // A /rewind inside one transcript: the run is anchored at the very start of
    // the ledger, so there is no prefix to keep and the drop is real history.
    const ledger = Array.from({ length: 16 }, (_, at) => rec(at + 1, `u${at + 1}`))
    const rewound = ledger.slice(0, 12)
    const t = await trackerOver(ledger)
    t.primeMemory(ledger)

    t.tracker.replaceHistory('t1', rewound)

    expect(t.history()).toHaveLength(12)
    expect(t.saved.at(-1)).toHaveLength(12)
  })

  it('replaces wholesale when the ledger has never seen the incoming head', async () => {
    // No anchor means no evidence of where this run belongs. Merging on a guess
    // would splice a foreign history in front of it, which is the silent-wrong
    // failure the whole lane exists to stop — so this stays today's behaviour.
    const t = await trackerOver(restored)
    t.primeMemory(restored)
    const stranger = [rec(1, 'x-1'), rec(2, 'x-2')]

    t.tracker.replaceHistory('t1', stranger)

    expect(t.history()?.map((r) => r.uuid)).toEqual(['x-1', 'x-2'])
  })
})

/**
 * THE INCIDENT, END TO END, THROUGH A REAL TurnStore — Atlas's round-2 probe,
 * adopted verbatim as the regression test C1 never had.
 *
 * The describes above use a hand-rolled store, and that is exactly how this bug
 * survived a round: a fake answers whatever its author expected to be asked. The
 * first attempt at the perf half passed all of them and still lost 597 records
 * here, because the real store was asked "did anyone write behind your back?"
 * about a restore that had been written THROUGH it — a question that is sound,
 * and the wrong one. Only a real file, written the way the recovery tool writes
 * it, could say so.
 *
 * So this replays the incident with nothing faked: a running tracker holding 16
 * live turns, a 613-record restore saved to the ledger behind it, and then the
 * next reconcile of the bound session file, which holds only the newest 16
 * numbered from 1. The assertion is on the DISK, after a flush, because it was
 * the save that destroyed the records.
 */
describe('CRITICAL-1: the incident, replayed against a real store', () => {
  const rec = (index: number, uuid: string): TurnRecord =>
    ({ index, uuid, prompt: `p${index}`, reply: 'r', startedAt: index, endedAt: index + 1 })

  it('restore 613 to disk while the app holds 16, then the live reconcile', async () => {
    const { TurnTracker } = await import('../src/main/turn-tracker')
    const { TurnStore } = await import('../src/main/turn-store')
    const store = new TurnStore(path.join(dir, 'turns'))
    const tracker = new TurnTracker(undefined, store)

    // The running app: 16 live turns, in memory and on disk.
    const live = Array.from({ length: 16 }, (_, at) => rec(at + 1, `u-${598 + at}`))
    tracker.replaceHistory('t1', live)
    store.flushAll()

    // THE RESTORE, as the recovery tool does it: 613 written to the ledger
    // behind the running tracker's back.
    const restored = Array.from({ length: 613 }, (_, at) => rec(at + 1, `u-${at + 1}`))
    store.scheduleSave('t1', restored)
    store.flushAll()
    expect(store.load('t1')).toHaveLength(613)

    // The very next turn: the tracker reconciles the BOUND session file, which
    // holds only the last 16 turns, numbered 1..16.
    tracker.replaceHistory('t1', live)
    store.flushAll()

    const disk = store.load('t1')
    expect(disk).toHaveLength(613)
    expect(disk[0].index).toBe(1)
    expect(disk[disk.length - 1].index).toBe(613)
    // The live run kept its identity and landed on its true indices.
    expect(disk.slice(597).map((r) => r.uuid)).toEqual(live.map((r) => r.uuid))
  })

  /**
   * THE SAME INCIDENT, RESTORED FROM OUTSIDE THIS PROCESS.
   *
   * The test above restores THROUGH the store the tracker is using, which is
   * the in-process shape. A repair script run from a terminal is the other
   * shape, and it is the one that hides: nothing in this process observes the
   * write, so a load served from memory would answer with the pre-restore
   * ledger and be believed. That is the failure mode a cache in front of
   * load() can introduce, so it is pinned rather than argued — the second
   * store here stands in for the other process.
   */
  it('sees a restore written by ANOTHER process, not just one made through it', async () => {
    const { TurnTracker } = await import('../src/main/turn-tracker')
    const { TurnStore } = await import('../src/main/turn-store')
    const turns = path.join(dir, 'turns')
    const store = new TurnStore(turns)
    const tracker = new TurnTracker(undefined, store)

    const live = Array.from({ length: 16 }, (_, at) => rec(at + 1, `u-${598 + at}`))
    tracker.replaceHistory('t1', live)
    store.flushAll()
    expect(store.load('t1')).toHaveLength(16) // and now cached in this store

    // The repair tool, running elsewhere, rewrites the ledger file.
    const elsewhere = new TurnStore(turns)
    elsewhere.scheduleSave('t1', Array.from({ length: 613 }, (_, at) => rec(at + 1, `u-${at + 1}`)))
    elsewhere.flushAll()

    tracker.replaceHistory('t1', live)
    store.flushAll()

    expect(store.load('t1')).toHaveLength(613)
  })
})
