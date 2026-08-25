// Sol r7 P1 — tail updates are APPEND-ONLY overlay lines, O(changed bytes).
//
// The r6 fix made the tail replacement atomic by rewriting the whole file per
// tail delta — O(total history) every ~2s of a long active turn. The overlay
// format makes the same update one appended line ({"__tail":true,
// "supersedes":N, …record…}, last-wins per index on read), with the dead
// weight folded away by ONE bounded atomic rewrite outside the hot path.
//
// The fs module is wrapped (passthrough) so the gate can count the actual
// bytes read and written by the hot path, not just observe file shapes.

import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { TAIL_OVERLAY_COMPACT_MIN_LINES, TurnStore } from '../src/main/turn-store'
import type { TurnRecord } from '../src/shared/turn'

const meter = vi.hoisted(() => ({
  active: false,
  readBytes: 0,
  writeBytes: 0,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const sizeOf = (data: unknown): number =>
    typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : (data as Buffer).length
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      const result = actual.readFileSync(...args)
      if (meter.active) meter.readBytes += sizeOf(result)
      return result
    }) as unknown as typeof actual.readFileSync,
    readSync: ((...args: unknown[]) => {
      const got = (actual.readSync as (...a: unknown[]) => number)(...args)
      if (meter.active) meter.readBytes += got
      return got
    }) as unknown as typeof actual.readSync,
    appendFileSync: ((...args: Parameters<typeof actual.appendFileSync>) => {
      if (meter.active) meter.writeBytes += sizeOf(args[1])
      return actual.appendFileSync(...args)
    }) as unknown as typeof actual.appendFileSync,
    writeSync: ((...args: unknown[]) => {
      const wrote = (actual.writeSync as (...a: unknown[]) => number)(...args)
      if (meter.active) meter.writeBytes += wrote
      return wrote
    }) as unknown as typeof actual.writeSync,
  }
})

let root: string
let dir: string
let annDir: string
let store: TurnStore

/** Same turns dir, same EXPLICIT annotations dir — no cross-test sharing of
 *  the tmpdir-level sibling default. */
const reopen = (): TurnStore => new TurnStore(dir, annDir)

beforeEach(() => {
  meter.active = false
  meter.readBytes = 0
  meter.writeBytes = 0
  root = mkdtempSync(path.join(tmpdir(), 'cookrew-overlay-'))
  dir = path.join(root, 'turns')
  annDir = path.join(root, 'checkpoint-annotations')
  store = reopen()
})
afterEach(() => {
  vi.restoreAllMocks()
  try {
    chmodSync(dir, 0o700)
  } catch {
    // already writable or gone
  }
  rmSync(root, { recursive: true, force: true })
})

const rec = (index: number, over: Partial<TurnRecord> = {}): TurnRecord => ({
  index,
  prompt: `ask ${index}`,
  reply: `reply ${index}`,
  startedAt: index * 10,
  endedAt: index * 10 + 5,
  ...over,
})

const file = (id = 't1'): string => path.join(dir, `${id}.jsonl`)
const text = (id = 't1'): string => readFileSync(file(id), 'utf8')
const overlayLineFor = (record: TurnRecord): string => {
  const line = JSON.stringify(record)
  return `{"__tail":true,"supersedes":${record.index},${line.slice(1)}`
}

function seed(count: number, id = 't1'): TurnRecord[] {
  const records = Array.from({ length: count }, (_, i) => rec(i + 1))
  store.scheduleSave(id, records)
  store.flushAll()
  return records
}

describe('overlay semantics — last wins per checkpoint index', () => {
  it('reads the overlay version of a record, not the superseded base line', () => {
    seed(2)
    appendFileSync(file(), `${overlayLineFor(rec(2, { reply: 'superseding' }))}\n`, 'utf8')
    const loaded = reopen().load('t1')
    expect(loaded).toHaveLength(2)
    expect(loaded[1].reply).toBe('superseding')
  })

  it('later overlays win over earlier ones for the same index', () => {
    seed(2)
    appendFileSync(
      file(),
      `${overlayLineFor(rec(2, { reply: 'first' }))}\n${overlayLineFor(rec(2, { reply: 'second' }))}\n`,
      'utf8',
    )
    expect(reopen().load('t1')[1].reply).toBe('second')
  })

  it('count() subtracts only canonical overlays — logical, not physical, lines', () => {
    seed(2)
    appendFileSync(
      file(),
      `${overlayLineFor(rec(2, { reply: 'a' }))}\n${overlayLineFor(rec(2, { reply: 'b' }))}\n`,
      'utf8',
    )
    expect(reopen().count('t1')).toBe(2)
  })

  it('an orphan overlay (base line lost) still surfaces its record — and count() agrees', () => {
    seed(1)
    appendFileSync(file(), `${overlayLineFor(rec(5, { reply: 'orphan' }))}\n`, 'utf8')
    const loaded = reopen().load('t1')
    expect(loaded.map((r) => r.index)).toEqual([1, 5])
    expect(loaded[1].reply).toBe('orphan')
    // Sol r8 P2: the reader PRESERVES the orphan as a record, so the pager's
    // count must not subtract it as though it superseded anything. The old
    // substring count answered 1 here against a loaded history of 2.
    expect(reopen().count('t1')).toBe(2)
  })

  it('count() applies the reader’s recovery rules to corrupt and orphan lines alike', () => {
    seed(2)
    appendFileSync(
      file(),
      [
        overlayLineFor(rec(9, { reply: 'orphan — a record the reader keeps' })),
        '{"__tail":true,"supersedes":2,broken', // marker-shaped corrupt: dropped
        'plain garbage line', // corrupt: dropped, never counted
        overlayLineFor(rec(2, { reply: 'canonical — supersedes base 2' })),
      ]
        .map((line) => `${line}\n`)
        .join(''),
      'utf8',
    )
    const fresh = reopen()
    // The invariant, stated as itself: whatever mix of plain, overlay, orphan
    // and corrupt lines the file holds, count() and the loaded history agree.
    expect(fresh.count('t1')).toBe(fresh.load('t1').length)
    expect(fresh.count('t1')).toBe(3) // 1, 2 (superseded in place), orphan 9
  })
})

describe('the write path appends overlays and stays O(changed) — byte-counted', () => {
  it('repeated tail updates on a 300-turn ledger read+write only the changed record, never the file', () => {
    seed(300)
    const fresh = reopen()
    fresh.load('t1') // seed the written-tail metadata, as a boot would
    const ledgerBytes = statSync(file()).size
    expect(ledgerBytes).toBeGreaterThan(20_000)
    const internals = fresh as unknown as { writeAll: (id: string, r: TurnRecord[]) => void }
    const writeAll = vi.spyOn(internals, 'writeAll')

    meter.active = true
    for (let round = 1; round <= 10; round += 1) {
      const tail = rec(300, { reply: `grew ${'x'.repeat(round * 5)}`, final: round === 10 })
      fresh.scheduleDelta('t1', [...seedRecords(), tail], [tail])
      fresh.flushAll()
    }
    meter.active = false

    // The gate: ten tail updates against a ~30 KB ledger. A single full-file
    // read or rewrite would blow these bounds by an order of magnitude —
    // what was actually read is ten last-line verifications, and what was
    // written is ten overlay lines.
    expect(writeAll).not.toHaveBeenCalled()
    expect(meter.readBytes).toBeLessThan(4_000)
    expect(meter.writeBytes).toBeLessThan(4_000)
    expect(meter.readBytes).toBeLessThan(ledgerBytes / 5)
    expect(meter.writeBytes).toBeLessThan(ledgerBytes / 5)

    // And it all reads back whole, logically unchanged in length.
    const replayed = reopen().load('t1')
    expect(replayed).toHaveLength(300)
    expect(replayed[299].reply).toBe(`grew ${'x'.repeat(50)}`)
  })

  /** The 299 untouched records handed alongside each delta. */
  function seedRecords(): TurnRecord[] {
    return Array.from({ length: 299 }, (_, i) => rec(i + 1))
  }

  it('a tail update that lands WITH appended records writes the overlay plus the new lines only', () => {
    seed(3)
    const fresh = reopen()
    fresh.load('t1')
    const before = text()

    const finalized = rec(3, { reply: 'finalized', final: true })
    const appended = rec(4)
    fresh.scheduleDelta('t1', [rec(1), rec(2), finalized, appended], [finalized, appended])
    fresh.flushAll()

    const after = text()
    expect(after.startsWith(before)).toBe(true)
    const grew = after.slice(before.length).trim().split('\n')
    expect(grew).toHaveLength(2)
    expect(grew[0].startsWith('{"__tail":true,"supersedes":3,')).toBe(true)
    expect(fresh.count('t1')).toBe(4)
    expect(reopen().load('t1').map((r) => r.index)).toEqual([1, 2, 3, 4])
  })

  it('stays on the overlay path across MULTIPLE restarts — an overlay tail re-seeds cleanly', () => {
    seed(2)
    const first = reopen()
    first.load('t1')
    first.scheduleDelta('t1', [rec(1), rec(2, { reply: 'v2' })], [rec(2, { reply: 'v2' })])
    first.flushAll()

    const second = reopen()
    second.load('t1')
    const internals = second as unknown as { writeAll: (id: string, r: TurnRecord[]) => void }
    const writeAll = vi.spyOn(internals, 'writeAll')
    const before = text()
    second.scheduleDelta('t1', [rec(1), rec(2, { reply: 'v3' })], [rec(2, { reply: 'v3' })])
    second.flushAll()

    expect(writeAll).not.toHaveBeenCalled()
    expect(text().startsWith(before)).toBe(true)
    expect(reopen().load('t1')[1].reply).toBe('v3')
  })

  /**
   * THIS EXPECTATION CHANGED — it used to assert a full REWRITE here.
   *
   * The original contract was "an overlay may only be appended onto bytes we
   * wrote; otherwise rewrite the whole file from our records", and the rewrite
   * was the safe half of that pair — safe relative to a blind overlay, which
   * would splice into a file of unknown shape.
   *
   * It is not safe in general, and this is the unit-scale version of the
   * incident: the store's records are only ever a view of the ledger, so
   * rewriting the file from them discards whatever the external write put
   * there. At two records that is a stray space. At the same code path with a
   * lineage restore on the other side it was 519 checkpoints, gone
   * forty-five seconds after they were written. The tail check had already
   * noticed the file was not ours; the response was the problem, not the
   * detection.
   *
   * So a changed file now REFUSES the write outright (TurnStore.flush, "the
   * choke point"). The original intent — never append an overlay onto bytes we
   * did not write — is preserved and strengthened: nothing is written at all,
   * and the external bytes survive to be read back.
   */
  it('refuses to WRITE AT ALL when the file no longer ends with the bytes it wrote (hand edit)', () => {
    const seeded = seed(2)
    // Someone edited the ledger under us: the last line is not ours anymore.
    writeFileSync(file(), `${text().trimEnd()} \n`, 'utf8')

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    store.scheduleDelta('t1', [rec(1), rec(2, { reply: 'edited-under' })], [rec(2, { reply: 'edited-under' })])
    store.flushAll()
    expect(spy).toHaveBeenCalled() // refused out loud
    spy.mockRestore()

    expect(text()).not.toContain('__tail') // no blind overlay, as before
    // And no rewrite either: the edit made under us is still there, and our
    // in-memory 'edited-under' did not replace a file we had stopped reading.
    expect(reopen().load('t1')[1].reply).toBe(seeded[1].reply)

    // Not wedged: a write built on a fresh read lands normally.
    const after = reopen()
    after.load('t1')
    after.scheduleDelta('t1', [rec(1), rec(2, { reply: 'v9' })], [rec(2, { reply: 'v9' })])
    after.flushAll()
    expect(reopen().load('t1')[1].reply).toBe('v9')
  })
})

describe('bounded fold — dead overlay weight is compacted OUTSIDE the hot path', () => {
  /** Let scheduled/async work drain — a few macrotask rounds. */
  const idle = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  /** The fold is ASYNC now (Sol r9 P1) — poll until its commit lands. */
  const awaitFold = async (id = 't1'): Promise<void> => {
    for (let i = 0; i < 400; i += 1) {
      if (!text(id).includes('__tail')) return
      await idle(5)
    }
    throw new Error('the scheduled fold never landed')
  }

  it('the overlay append that crosses the policy schedules ONE clean rewrite off the flush stack', async () => {
    seed(2)
    const fresh = reopen()
    fresh.load('t1')
    const internals = fresh as unknown as { writeAll: (id: string, r: TurnRecord[]) => void }
    const writeAll = vi.spyOn(internals, 'writeAll')
    // Small base: the byte half-fraction is crossed early, so the line floor
    // is the binding constraint — the fold fires exactly at the floor.
    for (let i = 1; i <= TAIL_OVERLAY_COMPACT_MIN_LINES; i += 1) {
      const tail = rec(2, { reply: `round ${i}` })
      fresh.scheduleDelta('t1', [rec(1), tail], [tail])
      fresh.flushAll()
    }
    // Sol r8 P1: NO flush folded — the threshold overlay was appended like
    // any other and the file still carries the dead weight…
    expect(writeAll).not.toHaveBeenCalled()
    expect(text()).toContain('__tail')

    // …until the scheduled async task commits the one atomic rewrite —
    // chunked, off every flush stack, never through the synchronous writeAll.
    await awaitFold()
    expect(writeAll).not.toHaveBeenCalled()
    const folded = text()
    expect(folded).not.toContain('__tail')
    expect(folded.trim().split('\n')).toHaveLength(2)
    expect(reopen().load('t1')[1].reply).toBe(
      `round ${TAIL_OVERLAY_COMPACT_MIN_LINES}`,
    )
    expect(fresh.count('t1')).toBe(2)
  })

  it('at the threshold against a LARGE ledger, the flush itself moves zero full-file bytes', async () => {
    // Large synthetic ledger: 300 base records plus ~2 KB overlay replies, so
    // the byte half-fraction is crossed long before the 64-line floor and the
    // floor is what fires — exactly at overlay #64, against a >100 KB file.
    seed(300)
    const fresh = reopen()
    fresh.load('t1')
    const base = Array.from({ length: 299 }, (_, i) => rec(i + 1))
    const grow = (round: number): TurnRecord =>
      rec(300, { reply: `${'x'.repeat(2000)} round ${round}` })
    const internals = fresh as unknown as { writeAll: (id: string, r: TurnRecord[]) => void }
    const writeAll = vi.spyOn(internals, 'writeAll')

    for (let round = 1; round < TAIL_OVERLAY_COMPACT_MIN_LINES; round += 1) {
      fresh.scheduleDelta('t1', [...base, grow(round)], [grow(round)])
      fresh.flushAll()
    }
    const ledgerBytes = statSync(file()).size
    expect(ledgerBytes).toBeGreaterThan(100_000)

    // Overlay #64 — the flush that reaches the fold policy — metered alone.
    meter.active = true
    const last = grow(TAIL_OVERLAY_COMPACT_MIN_LINES)
    fresh.scheduleDelta('t1', [...base, last], [last])
    fresh.flushAll()
    meter.active = false

    // The gate (Sol r8 P1): zero full-file bytes on the flush path. What
    // moved is one ~2 KB overlay line plus the tail verification read —
    // nothing that scales with the 100+ KB ledger. The r7 shape rewrote the
    // whole file from THIS flush.
    expect(writeAll).not.toHaveBeenCalled()
    expect(meter.writeBytes).toBeLessThan(4_000)
    expect(meter.readBytes).toBeLessThan(8_000)
    expect(meter.writeBytes).toBeLessThan(ledgerBytes / 10)

    // The scheduled fold lands off the flush stack — once, atomic, clean.
    await awaitFold()
    expect(writeAll).not.toHaveBeenCalled()
    expect(text()).not.toContain('__tail')
    const replayed = reopen().load('t1')
    expect(replayed).toHaveLength(300)
    expect(replayed[299].reply).toBe(last.reply)
  })

  it('a heavy overlay file left by a crash is SCHEDULED for folding at load — load itself only reads', async () => {
    store.scheduleSave('t1', [rec(1), rec(2, { title: 'recap' })])
    store.flushAll()
    // Simulate a session that appended a fold's worth of overlays and died.
    const overlays = Array.from(
      { length: TAIL_OVERLAY_COMPACT_MIN_LINES },
      (_, i) => `${overlayLineFor(rec(2, { reply: `crash round ${i + 1}` }))}\n`,
    ).join('')
    appendFileSync(file(), overlays, 'utf8')
    expect(text()).toContain('__tail')

    const fresh = reopen()
    const loaded = fresh.load('t1')
    expect(loaded[1].reply).toBe(`crash round ${TAIL_OVERLAY_COMPACT_MIN_LINES}`)
    // Load SCHEDULES the fold rather than paying the O(history) rewrite on
    // its own stack (Sol r9 P1): immediately after load the file still holds
    // its overlay weight, and the reader above was already correct.
    expect(text()).toContain('__tail')

    await awaitFold()
    // The fold ran: one clean line per logical record, no overlay weight…
    const folded = text()
    expect(folded).not.toContain('__tail')
    expect(folded.trim().split('\n')).toHaveLength(2)
    // …the conversation lines stayed annotation-free, and the title — which
    // lives in the sidecar — still reads back on the folded record.
    expect(folded).not.toContain('recap')
    expect(reopen().load('t1')[1].title).toBe('recap')
  })

  it('below the floor, load does NOT rewrite — a light overlay tail is not churn', () => {
    seed(2)
    appendFileSync(file(), `${overlayLineFor(rec(2, { reply: 'light' }))}\n`, 'utf8')
    const before = text()
    reopen().load('t1')
    expect(text()).toBe(before)
  })

  // Windows: fault-injection via chmod 0o500 on a directory is ignored by NTFS — macOS/Linux CI covers it.
  it.skipIf(process.platform === 'win32')('a failed fold costs nothing but bytes: the history still reads whole', async () => {
    seed(2)
    const overlays = Array.from(
      { length: TAIL_OVERLAY_COMPACT_MIN_LINES },
      (_, i) => `${overlayLineFor(rec(2, { reply: `round ${i + 1}` }))}\n`,
    ).join('')
    appendFileSync(file(), overlays, 'utf8')
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    chmodSync(dir, 0o500) // the fold's temp file cannot be created
    try {
      const loaded = reopen().load('t1')
      expect(loaded[1].reply).toBe(`round ${TAIL_OVERLAY_COMPACT_MIN_LINES}`)
      await idle(50) // the scheduled fold runs — and fails — while locked out
      expect(text()).toContain('__tail') // unfolded, but nothing lost
    } finally {
      chmodSync(dir, 0o700)
      quiet.mockRestore()
    }
  })

  it('count() is served from the cached logical count — no reread after the seed', async () => {
    seed(3)
    const fresh = reopen()
    expect(fresh.count('t1')).toBe(3) // cold seed: the one recovery parse
    meter.active = true
    expect(fresh.count('t1')).toBe(3)
    expect(fresh.count('t1')).toBe(3)
    expect(meter.readBytes).toBe(0) // served from cache, zero file bytes
    meter.active = false

    // Every write keeps the cache current instead of invalidating it: after
    // an append + a tail overlay, count() answers without touching the file.
    fresh.load('t1')
    const grown = rec(4)
    fresh.scheduleDelta('t1', [rec(1), rec(2), rec(3), grown], [grown])
    fresh.flushAll()
    const finalized = rec(4, { reply: 'finalized', final: true })
    fresh.scheduleDelta('t1', [rec(1), rec(2), rec(3), finalized], [finalized])
    fresh.flushAll()
    meter.readBytes = 0
    meter.active = true
    expect(fresh.count('t1')).toBe(4)
    expect(meter.readBytes).toBe(0)
    meter.active = false

    // A full rewrite updates it too…
    fresh.scheduleSave('t1', [rec(1), rec(2)])
    fresh.flushAll()
    meter.readBytes = 0
    meter.active = true
    expect(fresh.count('t1')).toBe(2)
    expect(meter.readBytes).toBe(0)
    meter.active = false
  })
})
