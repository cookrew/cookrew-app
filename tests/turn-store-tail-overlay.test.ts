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

  it('count() subtracts overlays without parsing — logical, not physical, lines', () => {
    seed(2)
    appendFileSync(
      file(),
      `${overlayLineFor(rec(2, { reply: 'a' }))}\n${overlayLineFor(rec(2, { reply: 'b' }))}\n`,
      'utf8',
    )
    expect(reopen().count('t1')).toBe(2)
  })

  it('an orphan overlay (base line lost) still surfaces its record', () => {
    seed(1)
    appendFileSync(file(), `${overlayLineFor(rec(5, { reply: 'orphan' }))}\n`, 'utf8')
    const loaded = reopen().load('t1')
    expect(loaded.map((r) => r.index)).toEqual([1, 5])
    expect(loaded[1].reply).toBe('orphan')
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

  it('refuses the overlay when the file no longer ends with the bytes it wrote (hand edit) — full rewrite instead', () => {
    seed(2)
    // Someone edited the ledger under us: the last line is not ours anymore.
    writeFileSync(file(), `${text().trimEnd()} \n`, 'utf8')
    store.scheduleDelta('t1', [rec(1), rec(2, { reply: 'edited-under' })], [rec(2, { reply: 'edited-under' })])
    store.flushAll()

    expect(text()).not.toContain('__tail')
    expect(reopen().load('t1')[1].reply).toBe('edited-under')
  })
})

describe('bounded fold — dead overlay weight is compacted OUTSIDE the hot path', () => {
  it('the overlay append that crosses the policy folds into ONE clean rewrite', () => {
    seed(2)
    const fresh = reopen()
    fresh.load('t1')
    // Small base: the byte half-fraction is crossed early, so the line floor
    // is the binding constraint — the fold fires exactly at the floor.
    for (let i = 1; i <= TAIL_OVERLAY_COMPACT_MIN_LINES; i += 1) {
      const tail = rec(2, { reply: `round ${i}` })
      fresh.scheduleDelta('t1', [rec(1), tail], [tail])
      fresh.flushAll()
    }
    const folded = text()
    expect(folded).not.toContain('__tail')
    expect(folded.trim().split('\n')).toHaveLength(2)
    expect(reopen().load('t1')[1].reply).toBe(
      `round ${TAIL_OVERLAY_COMPACT_MIN_LINES}`,
    )
    expect(fresh.count('t1')).toBe(2)
  })

  it('a heavy overlay file left by a crash is folded at LOAD time, annotations intact', () => {
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

  it('a failed fold costs nothing but bytes: the history still reads whole', () => {
    seed(2)
    const overlays = Array.from(
      { length: TAIL_OVERLAY_COMPACT_MIN_LINES },
      (_, i) => `${overlayLineFor(rec(2, { reply: `round ${i + 1}` }))}\n`,
    ).join('')
    appendFileSync(file(), overlays, 'utf8')
    chmodSync(dir, 0o500) // the fold's temp file cannot be created
    try {
      const loaded = reopen().load('t1')
      expect(loaded[1].reply).toBe(`round ${TAIL_OVERLAY_COMPACT_MIN_LINES}`)
      expect(text()).toContain('__tail') // unfolded, but nothing lost
    } finally {
      chmodSync(dir, 0o700)
    }
  })
})
