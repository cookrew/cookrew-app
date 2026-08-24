// A WRITER THAT TREATS ITS OWN PARTIAL VIEW AS THE WHOLE TRUTH.
//
// Three members now, all in this lane, all fixed by the same sentence —
// consult the record before writing:
//
//   1. TurnTracker.replaceHistory numbered an incoming run against its
//      in-memory copy and saved the run as the entire history. A restored 613
//      became 16.
//   2. rebuildLedgerInto regenerated from the CURRENT transcript and saved
//      that over a ledger which legitimately spanned several.
//   3. TurnTracker.applyHistoryDelta — this file's reason — mutated the same
//      in-memory copy and handed it to scheduleDelta as the whole history. A
//      restored 542 became 23, on the owner's real ledger, forty-five seconds
//      after it was written.
//
// Each fix was correct and each was applied one caller at a time, which is why
// there was a third. The guard here is at the choke point every writer passes
// through — TurnStore.flush — so the NEXT writer inherits it without knowing
// it exists.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TAIL_OVERLAY_COMPACT_MIN_LINES, TurnStore } from '../src/main/turn-store'
import { TurnTracker } from '../src/main/turn-tracker'
import type { TurnRecord } from '../src/shared/turn'

const ID = 'agent-1'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'write-choke-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const rec = (index: number, uuid: string): TurnRecord => ({
  index,
  uuid,
  prompt: `p${index}`,
  reply: 'r',
  startedAt: index,
  endedAt: index + 1
})

const ledger = (n: number, from = 1): TurnRecord[] =>
  Array.from({ length: n }, (_, at) => rec(from + at, `u-${from + at}`))

describe('TurnStore refuses to write a ledger it did not fully read', () => {
  it('drops a delta whose author last read the file two writes ago', () => {
    const turns = path.join(dir, 'turns')
    // The running app: 22 turns, read and held.
    const app = new TurnStore(turns)
    app.scheduleSave(ID, ledger(22))
    app.flushAll()
    expect(app.load(ID)).toHaveLength(22)

    // The repair tool, in another process, restores the full lineage.
    const tool = new TurnStore(turns)
    tool.scheduleSave(ID, ledger(542))
    tool.flushAll()
    expect(tool.load(ID)).toHaveLength(542)

    // The app appends one turn to the 22 it still believes in.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    app.scheduleDelta(ID, [...ledger(22), rec(23, 'u-new')], [rec(23, 'u-new')])
    app.flushAll()
    expect(spy).toHaveBeenCalled() // refused OUT LOUD, never silently
    spy.mockRestore()

    expect(new TurnStore(turns).load(ID)).toHaveLength(542)
  })

  /**
   * THE SECOND PERSISTENCE BUG, found by the test above going red the wrong
   * way. It did not produce 23 records — it produced 543.
   *
   * The append path asks whether the file still ends where it remembers by
   * comparing its own REMEMBERED tail line, not the bytes on disk, so against
   * a file that changed underneath it it appended anyway: index 23 spliced in
   * after index 542, a duplicate index and a ledger that no longer ascends.
   * That is worse than the shrink it was written to catch, because a shrink is
   * at least a valid ledger. A stale premise is not safe for ANY write, which
   * is why the guard is compare-and-swap on the file rather than a size check.
   */
  it('does not SPLICE onto a file it never read (the append is blind, too)', () => {
    const turns = path.join(dir, 'turns')
    const app = new TurnStore(turns)
    app.scheduleSave(ID, ledger(22))
    app.flushAll()
    app.load(ID)

    const tool = new TurnStore(turns)
    tool.scheduleSave(ID, ledger(542))
    tool.flushAll()

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    app.scheduleDelta(ID, [...ledger(22), rec(23, 'u-new')], [rec(23, 'u-new')])
    app.flushAll()
    spy.mockRestore()

    const after = new TurnStore(turns).load(ID)
    const indices = after.map((r) => r.index)
    expect(indices).toHaveLength(new Set(indices).size) // no duplicate index
    expect(indices.every((v, at) => at === 0 || v > indices[at - 1])).toBe(true) // ascends
  })

  it('refuses a FULL save on the same stale premise, not just a delta', () => {
    const turns = path.join(dir, 'turns')
    const app = new TurnStore(turns)
    app.scheduleSave(ID, ledger(22))
    app.flushAll()
    app.load(ID)

    const tool = new TurnStore(turns)
    tool.scheduleSave(ID, ledger(542))
    tool.flushAll()

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    app.scheduleSave(ID, ledger(22))
    app.flushAll()
    spy.mockRestore()

    expect(new TurnStore(turns).load(ID)).toHaveLength(542)
  })

  it('ALLOWS a shrink when the premise is current — a /rewind still works', () => {
    // The guard is about stale premises, not about shrinking. A caller that
    // read the file as it stands and then writes fewer records is doing the
    // one thing a rewind must be able to do.
    const turns = path.join(dir, 'turns')
    const store = new TurnStore(turns)
    store.scheduleSave(ID, ledger(22))
    store.flushAll()

    expect(store.load(ID)).toHaveLength(22) // read the current bytes…
    store.scheduleSave(ID, ledger(12)) // …then rewind to 12
    store.flushAll()

    expect(new TurnStore(turns).load(ID)).toHaveLength(12)
  })

  it('ALLOWS ordinary appends — the steady state is untouched', () => {
    const turns = path.join(dir, 'turns')
    const store = new TurnStore(turns)
    store.scheduleSave(ID, ledger(22))
    store.flushAll()
    store.scheduleDelta(ID, [...ledger(22), rec(23, 'u-23')], [rec(23, 'u-23')])
    store.flushAll()
    expect(new TurnStore(turns).load(ID)).toHaveLength(23)
  })

  it('ALLOWS a first write to a ledger that does not exist yet', () => {
    const turns = path.join(dir, 'turns')
    const store = new TurnStore(turns)
    store.scheduleSave(ID, ledger(3))
    store.flushAll()
    expect(new TurnStore(turns).load(ID)).toHaveLength(3)
  })

  it('FORGETS what it believed: a refusal invalidates the derived caches too', () => {
    // Not just the write — everything downstream of the premise. `counts` is
    // the one that bites: the tracker's delta path asks it whether its buffer
    // still matches the record, and a refusal that left the old count in place
    // would answer "yes, 22" forever. The ledger would stay safe and the
    // tracker would never repair — every write refused, no turn persisted,
    // silently, until something forced a full reconcile.
    const turns = path.join(dir, 'turns')
    const app = new TurnStore(turns)
    app.scheduleSave(ID, ledger(22))
    app.flushAll()
    app.load(ID)
    expect(app.count(ID)).toBe(22)

    const tool = new TurnStore(turns)
    tool.scheduleSave(ID, ledger(542))
    tool.flushAll()

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    app.scheduleSave(ID, ledger(22))
    app.flushAll()
    spy.mockRestore()

    // The store stops asserting a number it has been shown is wrong.
    expect(app.count(ID)).toBe(542)
  })

  it('RECOVERS: after a refusal the next read sees the truth and can write on it', () => {
    // A refusal must not wedge the terminal. The store drops its stale view, so
    // the caller's next read is of the real file and the write after that lands.
    const turns = path.join(dir, 'turns')
    const app = new TurnStore(turns)
    app.scheduleSave(ID, ledger(22))
    app.flushAll()
    app.load(ID)

    const tool = new TurnStore(turns)
    tool.scheduleSave(ID, ledger(542))
    tool.flushAll()

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    app.scheduleSave(ID, ledger(22))
    app.flushAll()
    spy.mockRestore()

    expect(app.load(ID)).toHaveLength(542) // re-read, not the stale 22
    app.scheduleDelta(ID, [...ledger(542), rec(543, 'u-543')], [rec(543, 'u-543')])
    app.flushAll()
    expect(new TurnStore(turns).load(ID)).toHaveLength(543)
  })
})

/**
 * THE STORE'S OWN ASYNC WRITER MUST NOT TRIP ITS OWN GUARD.
 *
 * The fold rewrites the ledger off the flush stack, by rename. That is this
 * store writing its own file, and the records it writes are the ones it just
 * read — the premise stays true. But the guard compares bytes, and a rename
 * changes every part of the stamp, so a fold that forgets to re-observe leaves
 * the very next write looking stale and refuses a turn for no reason.
 *
 * Refusing wrongly is far cheaper than writing wrongly — one turn persisted
 * late, recovered by the next reconcile — which is why the guard is built to
 * fail this direction. It is still a bug, and a quiet one: it would show up as
 * an occasional missing checkpoint under exactly the heavy ledgers the fold
 * exists to serve.
 */
describe('the fold re-observes the file it just rewrote', () => {
  it('a write straight after a fold is not refused', async () => {
    const turns = path.join(dir, 'turns')
    const store = new TurnStore(turns)
    store.scheduleSave(ID, ledger(40))
    store.flushAll()
    store.load(ID)

    // Enough tail overlays to cross the fold policy, then let it commit.
    for (let round = 1; round <= TAIL_OVERLAY_COMPACT_MIN_LINES + 2; round += 1) {
      const tail = { ...rec(40, 'u-40'), reply: `grew ${'x'.repeat(round * 400)}` }
      store.scheduleDelta(ID, [...ledger(39), tail], [tail])
      store.flushAll()
    }
    for (let wait = 0; wait < 400; wait += 1) {
      if (!readFileSync(path.join(turns, `${ID}.jsonl`), 'utf8').includes('__tail')) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const appended = rec(41, 'u-41')
    store.scheduleDelta(ID, [...ledger(40), appended], [appended])
    store.flushAll()
    const refused = spy.mock.calls.length > 0
    spy.mockRestore()

    expect(refused).toBe(false)
    expect(new TurnStore(turns).load(ID)).toHaveLength(41)
  })
})

describe('the delta path checks its premise against the durable ledger', () => {
  it('falls back to the full reconcile when memory disagrees with the record', () => {
    const turns = path.join(dir, 'turns')
    const store = new TurnStore(turns)
    const restored = ledger(542)
    store.scheduleSave(ID, restored)
    store.flushAll()

    const tracker = new TurnTracker(undefined, store)
    // The running tracker still holds the pre-restore 22 — the same numbering
    // the transcript produces, which is why nothing looks wrong from inside.
    const stale = restored.slice(-22).map((r, i) => ({ ...r, index: i + 1 }))
    ;(tracker as unknown as { histories: Map<string, TurnRecord[]> }).histories.set(ID, [...stale])

    const appended = rec(23, 'u-brand-new')
    const full = [...stale, appended]
    tracker.applyHistoryDelta(ID, { kind: 'append', records: [appended] }, () => full)
    store.flushAll()

    // 542 + the new turn, not 23. The delta's premise — "my copy is the
    // record" — did not hold, so it took the honest path instead of guessing.
    const after = new TurnStore(turns).load(ID)
    expect(after).toHaveLength(543)
    expect(after[after.length - 1].uuid).toBe('u-brand-new')
    expect(after.map((r) => r.index)).toEqual(
      Array.from({ length: 543 }, (_, at) => at + 1)
    )
  })

  it('still takes the O(delta) path when memory DOES match the record', () => {
    const turns = path.join(dir, 'turns')
    const store = new TurnStore(turns)
    store.scheduleSave(ID, ledger(22))
    store.flushAll()

    const tracker = new TurnTracker(undefined, store)
    expect(tracker.history(ID)).toHaveLength(22) // loads from the record

    const saves: number[] = []
    const spy = vi.spyOn(store, 'scheduleSave').mockImplementation((_id, records) => {
      saves.push(records.length)
    })
    const appended = rec(23, 'u-23')
    tracker.applyHistoryDelta(ID, { kind: 'append', records: [appended] }, () => [
      ...ledger(22),
      appended
    ])
    spy.mockRestore()

    // A fallback would have gone through replaceHistory → scheduleSave. The
    // premise held, so it did not: the fast path is still fast.
    expect(saves).toEqual([])
    expect(tracker.history(ID)).toHaveLength(23)
  })
})
