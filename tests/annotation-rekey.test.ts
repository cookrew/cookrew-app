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
 * LENGTH IS ASSERTED FIRST, because the numbering assertions are worthless
 * without it.
 *
 * T4 dropped the SECOND half of each assertion — "and what the store was
 * actually handed". There is no save: a reconciled record is derived from a
 * transcript the stream reads for itself, and turn-store.ts is a reader. The
 * merge is what still has to hold, and it holds in the tracker's history.
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
    // A reader, and nothing else: T4 left TurnStore with no write surface,
    // and a fake that cannot say where it lives gets no writer either (see
    // TurnTracker's constructor — a fake with no `dir` once meant the real
    // ~/.cookrew).
    const store = { load: () => disk }
    const tracker = new TurnTracker(async () => null, store as never)
    return {
      tracker,
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
 * CRITICAL-1, AGAINST A REAL LEDGER ON DISK — the incident, replayed.
 *
 * The unit tests above hand the tracker a fake `load`. The incident had a real
 * file behind it, and the failure hid in exactly the seam a fake cannot show:
 * a load served from memory answering with the pre-restore ledger.
 *
 * WHAT T4 CHANGED HERE, stated rather than quietly dropped. The original three
 * tests asserted the LEDGER after the reconcile, "because it was the save that
 * destroyed the records". There is no save: nothing writes ~/.cookrew/turns
 * for a file-backed card any more (turn-store.ts is a reader), so the disk
 * cannot be the assertion. What still has to hold — and does — is that the
 * tracker MERGES the incoming run onto the durable ledger it reads rather than
 * replacing it, across a reconcile and across a compact. That is asserted on
 * the tracker's history, which is the thing the rest of the app reads.
 *
 * The restore is written with ScrapeHistoryStore, the one writer left, because
 * a real file is still the point.
 */
describe('CRITICAL-1: the incident, replayed against a real ledger', () => {
  const rec = (index: number, uuid: string): TurnRecord =>
    ({ index, uuid, prompt: `p${index}`, reply: 'r', startedAt: index, endedAt: index + 1 })

  const restored = (): TurnRecord[] =>
    Array.from({ length: 613 }, (_, at) => rec(at + 1, `u-${at + 1}`))
  const liveRun = (): TurnRecord[] =>
    Array.from({ length: 16 }, (_, at) => rec(at + 1, `u-${598 + at}`))

  const onDisk = async (): Promise<{
    store: InstanceType<typeof import('../src/main/turn-store').TurnStore>
    write: (records: TurnRecord[]) => void
  }> => {
    const { TurnStore } = await import('../src/main/turn-store')
    const { ScrapeHistoryStore } = await import('../src/main/scrape-history')
    const turns = path.join(dir, 'turns')
    const store = new TurnStore(turns)
    const writer = new ScrapeHistoryStore(turns, store.annotationsDir, new TurnStore(turns))
    return { store, write: (records) => void writer.save('t1', records) }
  }

  it('a 613-record ledger on disk survives a reconcile of the newest 16', async () => {
    const { TurnTracker } = await import('../src/main/turn-tracker')
    const { store, write } = await onDisk()
    const tracker = new TurnTracker(undefined, store)

    // THE RESTORE, as a repair tool does it: 613 in the ledger, and this
    // tracker has never read them.
    write(restored())
    expect(store.load('t1')).toHaveLength(613)

    // The very next turn: the bound transcript holds only the last 16,
    // numbered 1..16.
    tracker.replaceHistory('t1', liveRun())

    const history = tracker.history('t1')
    expect(history).toHaveLength(613)
    expect(history[0].index).toBe(1)
    expect(history[history.length - 1].index).toBe(613)
    // The live run kept its identity and landed on its true indices.
    expect(history.slice(597).map((r) => r.uuid)).toEqual(liveRun().map((r) => r.uuid))
  })

  /**
   * THE RESTORE WRITTEN FROM OUTSIDE THIS PROCESS.
   *
   * Nothing here observes the write, so a load served from memory would answer
   * with the pre-restore ledger and be believed. That is the failure a cache
   * in front of load() introduces, and T4 made every cache in TurnStore
   * stat-validated precisely because this process is no longer the only writer.
   */
  it('sees a restore written by ANOTHER process, not just one made through it', async () => {
    const { TurnTracker } = await import('../src/main/turn-tracker')
    const { store, write } = await onDisk()
    const tracker = new TurnTracker(undefined, store)

    write(liveRun())
    expect(store.load('t1')).toHaveLength(16) // and now cached in this store

    // The repair tool, running elsewhere, rewrites the ledger file.
    write(restored())

    tracker.replaceHistory('t1', liveRun())
    expect(tracker.history('t1')).toHaveLength(613)
  })

  /**
   * THE WHOLE SCENARIO, in order: restore 613, keep taking turns (the merge),
   * then compact (the rotation licence). Either half alone still ends with the
   * history gone — the merge survives reconciles and dies at the next compact,
   * the licence survives a compact but not the reconcile before it.
   */
  it('survives a restore, then live turns, then a COMPACT', async () => {
    const { TurnTracker } = await import('../src/main/turn-tracker')
    const { store, write } = await onDisk()
    const tracker = new TurnTracker(undefined, store)

    write(restored())

    // 1. A live turn reconciles the bound transcript — the merge holds it.
    tracker.replaceHistory('t1', liveRun(), { sessionFile: '/before.jsonl' })
    expect(tracker.history('t1')).toHaveLength(613)

    // 2. THE COMPACT. A fresh transcript, sharing no turn with anything before
    //    it, reached through the proven rotation.
    tracker.declareRotation('t1', '/after.jsonl')
    tracker.replaceHistory('t1', [rec(1, 'u-post-compact')], { sessionFile: '/after.jsonl' })

    const history = tracker.history('t1')
    expect(history).toHaveLength(614)
    expect(history[history.length - 1]).toMatchObject({ index: 614, uuid: 'u-post-compact' })
    expect(history.slice(0, 613).map((r) => r.uuid)).toEqual(
      Array.from({ length: 613 }, (_, at) => `u-${at + 1}`)
    )
  })
})
