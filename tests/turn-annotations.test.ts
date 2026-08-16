// The annotation split (step 2 of checkpoint-as-identity).
//
// The whole point of this refactor is that it is INVISIBLE: every existing
// TurnStore test passes untouched. So the assertions here are the ones those
// tests cannot make — that the split actually happened on disk, that the two
// halves have the right owners, and that files written before the split still
// read back whole.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TurnStore } from '../src/main/turn-store'
import { ANNOTATION_LOG_COMPACT_MIN_OPS, AnnotationStore } from '../src/main/turn-annotations'
import {
  hasAnnotation,
  mergeAnnotation,
  splitAnnotation,
  type TurnRecord,
} from '../src/shared/turn'

let dir: string
let annDir: string
let store: TurnStore

beforeEach(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'cookrew-ann-'))
  // Both directories are passed EXPLICITLY. The sibling default is asserted on
  // its own below; every other test states where each half lives, so none of
  // them depends on that default staying what it is.
  dir = path.join(root, 'turns')
  annDir = path.join(root, 'checkpoint-annotations')
  mkdirSync(dir, { recursive: true })
  mkdirSync(annDir, { recursive: true })
  store = new TurnStore(dir, annDir)
})
afterEach(() => {
  try {
    chmodSync(annDir, 0o700)
  } catch {
    // already gone
  }
  rmSync(path.dirname(dir), { recursive: true, force: true })
})

const rec = (index: number, over: Partial<TurnRecord> = {}): TurnRecord => ({
  index,
  prompt: `ask ${index}`,
  reply: `reply ${index}`,
  startedAt: index * 10,
  endedAt: index * 10 + 5,
  ...over,
})

const save = (records: TurnRecord[], id = 't1'): void => {
  store.scheduleSave(id, records)
  store.flushAll()
}

const conversationText = (id = 't1'): string =>
  readFileSync(path.join(dir, `${id}.jsonl`), 'utf8')

const annotationFile = (id = 't1'): string => path.join(annDir, `${id}.json`)

/** The map inside the snapshot envelope (Sol r7 P1: {epoch, annotations}). */
const snapshotAnnotations = (id = 't1'): unknown =>
  (JSON.parse(readFileSync(annotationFile(id), 'utf8')) as { annotations: unknown }).annotations

const snapshotEpoch = (id = 't1'): number =>
  (JSON.parse(readFileSync(annotationFile(id), 'utf8')) as { epoch: number }).epoch

/**
 * THE invariant. Step 3 documents the ledger as derived and safe to delete, so
 * `rm -rf ~/.cookrew/turns` is a thing someone will eventually run. Nothing in
 * the annotations directory can be rebuilt from a transcript, so it must not be
 * reachable by that command — and a comment saying so is not a mechanism.
 */
describe('annotations live OUTSIDE the ledger, structurally', () => {
  const isInside = (child: string, parent: string): boolean => {
    const rel = path.relative(parent, child)
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
  }

  it('never puts the annotations directory inside the turns directory', () => {
    for (const turns of [
      path.join(homedir(), '.cookrew', 'turns'),
      '/var/data/cookrew/turns',
      dir,
    ]) {
      const store = new TurnStore(turns)
      expect(isInside(store.annotationsDir, turns)).toBe(false)
    }
  })

  it('defaults to the sibling of the turns directory it was given', () => {
    // path.resolve() inside TurnStore absolutises against the cwd, which on
    // Windows prepends a drive letter. Compare the resolved forms so the
    // assertion is about the SIBLING relationship, not about how the platform
    // spells an absolute path.
    expect(new TurnStore(path.join('/var/data/cookrew/turns')).annotationsDir).toBe(
      path.resolve('/var/data/cookrew', 'checkpoint-annotations'),
    )
  })

  it('puts the real ledger’s annotations at ~/.cookrew/checkpoint-annotations', () => {
    expect(new TurnStore().annotationsDir).toBe(
      path.join(homedir(), '.cookrew', 'checkpoint-annotations'),
    )
  })

  it('survives deleting the whole turns directory', () => {
    save([rec(1, { title: 'recap', seenAt: 999, scrollLine: 42 }), rec(2)])
    // Exactly what step 3 tells people they may do.
    rmSync(dir, { recursive: true, force: true })

    expect(existsSync(annotationFile())).toBe(true)
    // The conversation is gone — a transcript can regenerate that. What no
    // transcript ever knew is still on disk, keyed by checkpoint index and
    // ready for the rebuild to re-attach.
    expect(new TurnStore(dir, annDir).load('t1')).toEqual([])
    expect(snapshotAnnotations()).toEqual({
      '1': { title: 'recap', seenAt: 999, scrollLine: 42 },
    })
  })
})

describe('splitAnnotation / mergeAnnotation — the field partition', () => {
  it('sends title, seenAt and scrollLine to the annotation half', () => {
    const { annotation } = splitAnnotation(rec(1, { title: 'recap', seenAt: 9, scrollLine: 42 }))
    expect(annotation).toEqual({ title: 'recap', seenAt: 9, scrollLine: 42 })
  })

  it('keeps the conversation — including the session uuid, which binds it', () => {
    const { conversation } = splitAnnotation(
      rec(1, { uuid: 'u-1', title: 'recap', seenAt: 9, scrollLine: 42 }),
    )
    expect(conversation).toEqual({
      index: 1,
      prompt: 'ask 1',
      reply: 'reply 1',
      uuid: 'u-1',
      startedAt: 10,
      endedAt: 15,
    })
  })

  it('leaves absent fields absent, so an un-annotated record serializes identically', () => {
    const { conversation, annotation } = splitAnnotation(rec(1))
    expect(JSON.stringify(conversation)).toBe(JSON.stringify(rec(1)))
    expect(hasAnnotation(annotation)).toBe(false)
  })

  it('round-trips through split then merge', () => {
    const original = rec(1, { title: 'recap', seenAt: 9, scrollLine: 42 })
    const { conversation, annotation } = splitAnnotation(original)
    expect(mergeAnnotation(conversation, annotation)).toEqual(original)
  })

  it('lets the record keep what the annotation does not carry', () => {
    // A pre-split line still has title inline; the sidecar only knows seenAt.
    const inline = rec(1, { title: 'from the line' })
    expect(mergeAnnotation(inline, { seenAt: 5 })).toEqual(
      rec(1, { title: 'from the line', seenAt: 5 }),
    )
  })

  it('lets the annotation win where both have a value', () => {
    expect(mergeAnnotation(rec(1, { title: 'stale' }), { title: 'fresh' }).title).toBe('fresh')
  })
})

describe('TurnStore — the split is real on disk', () => {
  it('writes no annotation field onto a conversation line', () => {
    save([rec(1), rec(2, { title: 'recap', seenAt: 999, scrollLine: 42 })])
    expect(conversationText()).not.toMatch(/title|seenAt|scrollLine/)
  })

  it('writes them to a sidecar keyed by CHECKPOINT INDEX, not array position', () => {
    save([rec(7), rec(8, { title: 'recap', seenAt: 999 })])
    expect(snapshotAnnotations()).toEqual({
      '8': { title: 'recap', seenAt: 999 },
    })
  })

  it('keeps the sidecar out of the ledger walk', () => {
    save([rec(1, { title: 'recap' })])
    // The turns directory holds conversations and nothing else, so the walk
    // cannot mistake an annotation file for an agent's history.
    expect(readdirSync(dir)).toEqual(['t1.jsonl'])
    expect([...store.loadAll().keys()]).toEqual(['t1'])
  })

  it('writes no sidecar at all for an agent that has no annotations', () => {
    save([rec(1), rec(2)])
    expect(existsSync(annotationFile())).toBe(false)
  })

  it('drops an annotation when its CHECKPOINT disappears, so a rewind takes effect', () => {
    save([rec(1, { title: 'one' }), rec(2, { title: 'two', seenAt: 5 })])
    save([rec(1, { title: 'one' })])
    expect(snapshotAnnotations()).toEqual({ '1': { title: 'one' } })
  })

  it('clears an annotation the history stopped carrying', () => {
    // The caller hands over the WHOLE history, so absence is authoritative —
    // a store that inherited whatever was on disk could never clear anything.
    save([rec(1, { title: 'recap', seenAt: 5 })])
    save([rec(1)])
    expect(store.load('t1')[0]).toEqual(rec(1))
    // The clear is PUBLISHED as an epoch-bumped empty snapshot (Sol r9 P2),
    // never a raw unlink a crash could roll back.
    expect(snapshotAnnotations()).toEqual({})
    expect(new TurnStore(dir, annDir).load('t1')[0]).toEqual(rec(1))
  })

  it('replaces a changed annotation rather than merging into it', () => {
    save([rec(1, { title: 'first', seenAt: 5 })])
    save([rec(1, { title: 'second' })])
    expect(store.load('t1')[0]).toEqual(rec(1, { title: 'second' }))
  })
})

/**
 * The reason the split is worth doing: acknowledging a result used to rewrite
 * the entire conversation file to record that someone looked at it.
 */
describe('TurnStore — an annotation-only edit does not touch the conversation', () => {
  it('leaves the conversation bytes identical when seenAt is stamped', () => {
    save([rec(1), rec(2)])
    const before = conversationText()
    save([rec(1), rec(2, { seenAt: 999 })])
    expect(conversationText()).toBe(before)
    expect(store.load('t1')[1].seenAt).toBe(999)
  })

  it('leaves them identical when a Sous title lands late', () => {
    save([rec(1), rec(2)])
    const before = conversationText()
    save([rec(1), rec(2, { title: 'recap' })])
    expect(conversationText()).toBe(before)
    expect(store.load('t1')[1].title).toBe('recap')
  })

  it('still rewrites the conversation when the conversation itself changed', () => {
    // Dedupe and reconcile edit prompts/replies, which is why the store's
    // conservative fallback has to stay.
    save([rec(1), rec(2)])
    save([rec(1), rec(2, { reply: 'corrected' })])
    expect(store.load('t1')[1].reply).toBe('corrected')
  })
})

describe('TurnStore — files written before the split', () => {
  it('reads inline annotations back unchanged, before any rewrite', () => {
    const records = [rec(1), rec(2, { title: 'recap', seenAt: 999, scrollLine: 42 })]
    writeFileSync(
      path.join(dir, 'old.jsonl'),
      records.map((r) => `${JSON.stringify(r)}\n`).join(''),
      'utf8',
    )
    expect(new TurnStore(dir).load('old')).toEqual(records)
  })

  it('carries a legacy .json array’s annotations across the migration', () => {
    const records = [rec(1), rec(2, { title: 'recap', seenAt: 999 })]
    writeFileSync(path.join(dir, 'leg.json'), JSON.stringify(records), 'utf8')
    // First read migrates to lines; the SECOND is the one that would expose a
    // migration that stripped annotations without saving them.
    expect(store.load('leg')).toEqual(records)
    expect(new TurnStore(dir).load('leg')).toEqual(records)
  })
})

describe('TurnStore — annotations survive the same journeys as the history', () => {
  it('round-trips through a fresh store instance', () => {
    save([rec(1), rec(2, { title: 'recap', seenAt: 999, scrollLine: 42 })])
    expect(new TurnStore(dir).load('t1')).toEqual([
      rec(1),
      rec(2, { title: 'recap', seenAt: 999, scrollLine: 42 }),
    ])
  })

  it('comes back through loadAll and loadTail too', () => {
    save([rec(1), rec(2, { title: 'recap' })])
    const fresh = new TurnStore(dir)
    expect(fresh.loadAll().get('t1')?.[1].title).toBe('recap')
    expect(fresh.loadTail('t1', 1)[0].title).toBe('recap')
  })

  it('does not leak one agent’s annotations onto another', () => {
    save([rec(1, { title: 'mine' })], 't1')
    save([rec(1)], 't2')
    expect(new TurnStore(dir).load('t2')[0].title).toBeUndefined()
  })

  it('is dropped with the terminal', () => {
    save([rec(1, { title: 'recap' })])
    expect(existsSync(annotationFile())).toBe(true)
    store.remove('t1')
    expect(existsSync(annotationFile())).toBe(false)
  })

  it('sanitizes the terminal id for the sidecar filename too', () => {
    save([rec(1, { title: 'recap' })], '../evil/../../id')
    expect(existsSync(path.join(annDir, 'evilid.json'))).toBe(true)
  })
})

const annotationLog = (id = 't1'): string => path.join(annDir, `${id}.log.jsonl`)

/**
 * Sol r6 P1: the incremental path must be O(changed) ON DISK, not just in
 * records visited. The previous persist enumerated, sorted and serialized the
 * COMPLETE map whenever one annotation changed; now a change is one appended
 * op line, and the snapshot is only rewritten by the full path or compaction.
 */
describe('AnnotationStore — updates append ops, never reserialize the snapshot', () => {
  it('one changed annotation costs one op line; the snapshot bytes never move', () => {
    const annotations = new AnnotationStore(annDir)
    expect(annotations.save('t1', [rec(1, { title: 'one' }), rec(2)])).toBe(true)
    const snapshotBefore = readFileSync(annotationFile(), 'utf8')

    expect(annotations.update('t1', [rec(2, { seenAt: 5 })])).toBe(true)

    expect(readFileSync(annotationFile(), 'utf8')).toBe(snapshotBefore)
    expect(readFileSync(annotationLog(), 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('a fresh store replays snapshot + log back into one picture', () => {
    const annotations = new AnnotationStore(annDir)
    annotations.save('t1', [rec(1, { title: 'one' })])
    annotations.update('t1', [rec(2, { seenAt: 5 })])

    const replayed = new AnnotationStore(annDir).load('t1')
    expect(replayed.get(1)).toEqual({ title: 'one' })
    expect(replayed.get(2)).toEqual({ seenAt: 5 })
  })

  it('a clear op removes an annotation across a restart, exactly as the rebuild would', () => {
    const annotations = new AnnotationStore(annDir)
    annotations.save('t1', [rec(1, { title: 'one' }), rec(2, { seenAt: 5 })])
    annotations.update('t1', [rec(2)])

    expect(new AnnotationStore(annDir).load('t1').get(2)).toBeUndefined()
    // The snapshot still holds the stale key — the log's clear op wins.
    expect(snapshotAnnotations()).toMatchObject({
      '2': { seenAt: 5 },
    })
  })

  it('folds the log into the snapshot once replay weight crosses the threshold', () => {
    const annotations = new AnnotationStore(annDir)
    annotations.save('t1', [rec(1, { title: 'recap' })])
    for (let i = 1; i <= ANNOTATION_LOG_COMPACT_MIN_OPS; i += 1) {
      expect(annotations.update('t1', [rec(1, { title: 'recap', seenAt: i })])).toBe(true)
    }
    // The op that crossed the threshold triggered compaction: log folded away,
    // snapshot carries the latest value, and a fresh store reads it whole.
    expect(existsSync(annotationLog())).toBe(false)
    expect(snapshotAnnotations()).toEqual({
      '1': { title: 'recap', seenAt: ANNOTATION_LOG_COMPACT_MIN_OPS },
    })
    expect(new AnnotationStore(annDir).load('t1').get(1)).toEqual({
      title: 'recap',
      seenAt: ANNOTATION_LOG_COMPACT_MIN_OPS,
    })
  })
})

/**
 * Sol r6 P1: a write that did not land must never be remembered as saved.
 * Both paths return success, publish to memory only on success, retain the
 * un-landed work, and retry it on the next flush.
 */
describe('AnnotationStore — a failed write is retained and retried, never claimed', () => {
  it('save: fails closed once, then the retry lands the same bytes', () => {
    const annotations = new AnnotationStore(annDir)
    chmodSync(annDir, 0o500)
    expect(annotations.save('t1', [rec(1, { title: 'recap' })])).toBe(false)
    // Nothing on disk — and nothing forgotten: reads still see the candidate.
    expect(existsSync(annotationFile())).toBe(false)
    expect(annotations.load('t1').get(1)).toEqual({ title: 'recap' })

    chmodSync(annDir, 0o700)
    expect(annotations.save('t1', [rec(1, { title: 'recap' })])).toBe(true)
    expect(snapshotAnnotations()).toEqual({
      '1': { title: 'recap' },
    })
    expect(new AnnotationStore(annDir).load('t1').get(1)).toEqual({ title: 'recap' })
  })

  it('save: an update after the failure folds into the retried rebuild', () => {
    const annotations = new AnnotationStore(annDir)
    chmodSync(annDir, 0o500)
    expect(annotations.save('t1', [rec(1, { title: 'recap' })])).toBe(false)

    chmodSync(annDir, 0o700)
    expect(annotations.update('t1', [rec(2, { seenAt: 5 })])).toBe(true)
    const replayed = new AnnotationStore(annDir).load('t1')
    expect(replayed.get(1)).toEqual({ title: 'recap' })
    expect(replayed.get(2)).toEqual({ seenAt: 5 })
  })

  it('update: fails closed once, then retries WITHOUT duplicating the op', () => {
    const annotations = new AnnotationStore(annDir)
    annotations.save('t1', [rec(1, { title: 'one' })])
    chmodSync(annDir, 0o500)
    expect(annotations.update('t1', [rec(2, { seenAt: 5 })])).toBe(false)
    expect(existsSync(annotationLog())).toBe(false)
    // Retained, not claimed: memory still carries the dirty op…
    expect(annotations.load('t1').get(2)).toEqual({ seenAt: 5 })

    chmodSync(annDir, 0o700)
    // …and replaying the SAME record writes it exactly once.
    expect(annotations.update('t1', [rec(2, { seenAt: 5 })])).toBe(true)
    expect(readFileSync(annotationLog(), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(new AnnotationStore(annDir).load('t1').get(2)).toEqual({ seenAt: 5 })
  })
})

describe('AnnotationStore — a bad sidecar costs recaps, never history', () => {
  it('reads a corrupt file as no annotations', () => {
    const annotations = new AnnotationStore(annDir)
    writeFileSync(path.join(annDir, 'x.json'), '{not json', 'utf8')
    expect(annotations.load('x').size).toBe(0)
  })

  it('ignores entries that are not annotation-shaped', () => {
    const annotations = new AnnotationStore(annDir)
    writeFileSync(
      path.join(annDir, 'y.json'),
      JSON.stringify({ '1': { title: 'ok' }, '2': { title: 42 }, three: { seenAt: 1 } }),
      'utf8',
    )
    const loaded = annotations.load('y')
    expect(loaded.get(1)).toEqual({ title: 'ok' })
    expect(loaded.has(2)).toBe(false)
  })

  it('leaves the history readable when the sidecar is unusable', () => {
    save([rec(1), rec(2, { title: 'recap' })])
    writeFileSync(annotationFile(), 'garbage', 'utf8')
    expect(new TurnStore(dir).load('t1').map((r) => r.index)).toEqual([1, 2])
  })
})

/**
 * Sol r7 P1: snapshot and log share an epoch, so a crash between "new
 * snapshot renamed" and "old log unlinked" can never replay stale ops over
 * the newer snapshot. Each boundary is simulated by CONSTRUCTING the exact
 * intermediate disk state (with bytes the real writers produced) and reopening
 * a fresh store, which must read the newest COMPLETE state.
 */
describe('AnnotationStore — snapshot+log crash consistency via shared epoch', () => {
  const annotationLogFile = (id = 't1'): string => path.join(annDir, `${id}.log.jsonl`)

  /** Snapshot says A (epoch 1), log later says B (ops on epoch 1). */
  function seedSnapshotPlusLog(): void {
    const annotations = new AnnotationStore(annDir)
    expect(annotations.save('t1', [rec(1, { title: 'A' })])).toBe(true)
    expect(annotations.update('t1', [rec(1, { title: 'B' })])).toBe(true)
    expect(snapshotEpoch()).toBe(1)
    expect(existsSync(annotationLogFile())).toBe(true)
  }

  it('ops carry the snapshot epoch and replay onto it', () => {
    seedSnapshotPlusLog()
    const op = JSON.parse(readFileSync(annotationLogFile(), 'utf8').trim()) as { e: number }
    expect(op.e).toBe(1)
    expect(new AnnotationStore(annDir).load('t1').get(1)).toEqual({ title: 'B' })
  })

  it('full-save window: snapshot renamed, stale log survives → reads the SAVE, not the log', () => {
    seedSnapshotPlusLog()
    // Keep the epoch-1 log aside, run the full save (epoch 2, log unlinked),
    // then resurrect the stale log — the exact crash-between-rename-and-unlink
    // state, byte for byte.
    const staleLog = readFileSync(annotationLogFile(), 'utf8')
    const annotations = new AnnotationStore(annDir)
    expect(annotations.save('t1', [rec(1, { title: 'C' })])).toBe(true)
    expect(snapshotEpoch()).toBe(2)
    expect(existsSync(annotationLogFile())).toBe(false)
    writeFileSync(annotationLogFile(), staleLog, 'utf8')

    // Before the epoch, this replayed to B and silently rolled C back.
    expect(new AnnotationStore(annDir).load('t1').get(1)).toEqual({ title: 'C' })
  })

  it('crash BEFORE the rename (temp staged, old snapshot intact) still reads snapshot+log', () => {
    seedSnapshotPlusLog()
    writeFileSync(`${annotationFile()}.tmp`, JSON.stringify({ epoch: 2, annotations: {} }), 'utf8')
    expect(new AnnotationStore(annDir).load('t1').get(1)).toEqual({ title: 'B' })
  })

  it('legacy empty-save window: snapshot missing, stale log survives → reads EMPTY, no resurrection', () => {
    seedSnapshotPlusLog()
    // A pre-r9 empty save unlinked the snapshot first; a crash before the log
    // unlink leaves only the log. Its ops are epoch 1; a bare directory is
    // epoch 0 — so they stay inert whatever store version reopens the state.
    rmSync(annotationFile())
    const replayed = new AnnotationStore(annDir).load('t1')
    expect(replayed.size).toBe(0)
  })

  it('the empty save PUBLISHES an epoch-bumped empty snapshot and reclaims the log (Sol r9)', () => {
    seedSnapshotPlusLog()
    const annotations = new AnnotationStore(annDir)
    expect(annotations.save('t1', [rec(1)])).toBe(true)
    // Not an unlink: emptiness rides the same temp+fsync+rename+dir-fsync
    // path as any other save, so it is durable the moment it is claimed.
    expect(snapshotEpoch()).toBe(2)
    expect(snapshotAnnotations()).toEqual({})
    expect(existsSync(annotationLogFile())).toBe(false)
    expect(new AnnotationStore(annDir).load('t1').size).toBe(0)
  })

  it('crash boundary: the empty publish holds even when the log unlink never happened', () => {
    seedSnapshotPlusLog()
    const staleLog = readFileSync(annotationLogFile(), 'utf8')
    const annotations = new AnnotationStore(annDir)
    expect(annotations.save('t1', [rec(1)])).toBe(true)
    // Crash-sim: the log unlink's directory entry never persisted — the old
    // epoch-1 ops are back whole. The published snapshot is epoch 2, so they
    // replay as inert and the clear the store reported SURVIVES the reboot.
    writeFileSync(annotationLogFile(), staleLog, 'utf8')
    expect(new AnnotationStore(annDir).load('t1').size).toBe(0)
  })

  it('a failed empty publish retains the pending clear and the retry lands it', () => {
    seedSnapshotPlusLog()
    const annotations = new AnnotationStore(annDir)
    chmodSync(annDir, 0o500) // the empty snapshot's temp cannot be created
    expect(annotations.save('t1', [rec(1)])).toBe(false)
    // Retained, not claimed: reads already see the clear the disk lacks.
    expect(annotations.load('t1').size).toBe(0)
    expect(snapshotAnnotations()).toEqual({ '1': { title: 'A' } }) // disk untouched

    chmodSync(annDir, 0o700)
    expect(annotations.save('t1', [rec(1)])).toBe(true)
    expect(snapshotAnnotations()).toEqual({})
    expect(new AnnotationStore(annDir).load('t1').size).toBe(0)
  })

  it('an agent that never had an annotation still leaves NO file behind', () => {
    const annotations = new AnnotationStore(annDir)
    expect(annotations.save('t1', [rec(1), rec(2)])).toBe(true)
    expect(existsSync(annotationFile())).toBe(false)
    expect(existsSync(annotationLogFile())).toBe(false)
  })

  it('after the empty save, a log-only agent writes epoch-0 ops that DO replay', () => {
    const annotations = new AnnotationStore(annDir)
    expect(annotations.update('t1', [rec(3, { seenAt: 7 })])).toBe(true)
    expect(existsSync(annotationFile())).toBe(false)
    const op = JSON.parse(readFileSync(annotationLogFile(), 'utf8').trim()) as { e: number }
    expect(op.e).toBe(0)
    expect(new AnnotationStore(annDir).load('t1').get(3)).toEqual({ seenAt: 7 })
  })

  it('compaction bumps the epoch too, so its own stale window is covered', () => {
    const annotations = new AnnotationStore(annDir)
    annotations.save('t1', [rec(1, { title: 'recap' })])
    for (let i = 1; i <= ANNOTATION_LOG_COMPACT_MIN_OPS; i += 1) {
      annotations.update('t1', [rec(1, { title: 'recap', seenAt: i })])
    }
    expect(existsSync(annotationLogFile())).toBe(false)
    expect(snapshotEpoch()).toBe(2)
    expect(new AnnotationStore(annDir).load('t1').get(1)).toEqual({
      title: 'recap',
      seenAt: ANNOTATION_LOG_COMPACT_MIN_OPS,
    })
  })

  it('legacy files — bare-map snapshot, ops without e — read as one epoch-0 pair', () => {
    writeFileSync(annotationFile(), JSON.stringify({ '1': { title: 'legacy' } }), 'utf8')
    writeFileSync(annotationLogFile(), `${JSON.stringify({ i: 2, a: { seenAt: 5 } })}\n`, 'utf8')
    const replayed = new AnnotationStore(annDir).load('t1')
    expect(replayed.get(1)).toEqual({ title: 'legacy' })
    expect(replayed.get(2)).toEqual({ seenAt: 5 })
  })
})
