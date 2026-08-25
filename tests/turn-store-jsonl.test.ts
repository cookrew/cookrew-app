import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TurnStore } from '../src/main/turn-store'
import type { TurnRecord } from '../src/shared/turn'

let dir: string
let store: TurnStore

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cookrew-turns-'))
  store = new TurnStore(dir)
})
afterEach(() => {
  vi.restoreAllMocks()
  try {
    chmodSync(dir, 0o700)
  } catch {
    // already gone
  }
  rmSync(dir, { recursive: true, force: true })
})

const rec = (index: number, over: Partial<TurnRecord> = {}): TurnRecord => ({
  index,
  prompt: `ask ${index}`,
  reply: `reply ${index}`,
  startedAt: index * 10,
  endedAt: index * 10 + 5,
  ...over,
})

const save = (records: TurnRecord[]): void => {
  store.scheduleSave('t1', records)
  store.flushAll()
}

const lines = (): string[] =>
  readFileSync(path.join(dir, 't1.jsonl'), 'utf8').trim().split('\n').filter(Boolean)

describe('TurnStore — history is no longer capped', () => {
  it('keeps every record, well past the old 100/500 limits', () => {
    save(Array.from({ length: 1200 }, (_, i) => rec(i + 1)))
    expect(store.load('t1')).toHaveLength(1200)
    expect(store.count('t1')).toBe(1200)
  })

  it('preserves the monotonic index across the whole history', () => {
    save(Array.from({ length: 600 }, (_, i) => rec(i + 1)))
    const all = store.load('t1')
    expect(all[0].index).toBe(1)
    expect(all[all.length - 1].index).toBe(600)
  })
})

/**
 * The reason the cap existed: flush rewrote the WHOLE array as pretty-printed
 * JSON on every turn, so an unbounded history costs O(n) per turn and O(n²)
 * over a session. One line per record makes the common case an append.
 */
describe('TurnStore — appends instead of rewriting', () => {
  it('writes one line per record', () => {
    save([rec(1), rec(2), rec(3)])
    expect(lines()).toHaveLength(3)
  })

  it('APPENDS when the history only grew', () => {
    save([rec(1), rec(2)])
    const before = readFileSync(path.join(dir, 't1.jsonl'), 'utf8')
    save([rec(1), rec(2), rec(3)])
    const after = readFileSync(path.join(dir, 't1.jsonl'), 'utf8')
    // The original bytes are untouched; only the new line was added.
    expect(after.startsWith(before)).toBe(true)
    expect(lines()).toHaveLength(3)
  })

  it('REWRITES when an existing record changed, so a seenAt stamp is not lost', () => {
    save([rec(1), rec(2)])
    save([rec(1), rec(2, { seenAt: 999 })])
    const all = store.load('t1')
    expect(all).toHaveLength(2)
    expect(all[1].seenAt).toBe(999)
  })

  it('REWRITES when history shrank, so a dedupe is not silently ignored', () => {
    save([rec(1), rec(2), rec(3)])
    save([rec(1), rec(3)])
    expect(store.load('t1').map((r) => r.index)).toEqual([1, 3])
  })

  it('rewrites correctly even when the store never saw the earlier write', () => {
    save([rec(1), rec(2)])
    const fresh = new TurnStore(dir)
    fresh.scheduleSave('t1', [rec(1), rec(2, { title: 'recap' })])
    fresh.flushAll()
    expect(fresh.load('t1')[1].title).toBe('recap')
  })
})

/** Counting must not pay for parsing bodies — that is what made it lazy. */
describe('TurnStore — count and tail', () => {
  it('counts without loading the bodies', () => {
    save(Array.from({ length: 900 }, (_, i) => rec(i + 1)))
    expect(store.count('t1')).toBe(900)
  })

  it('returns 0 for an agent that has never run', () => {
    expect(store.count('nobody')).toBe(0)
    expect(store.loadTail('nobody', 20)).toEqual([])
  })

  it('loads only the newest N, and they are the newest', () => {
    save(Array.from({ length: 500 }, (_, i) => rec(i + 1)))
    const tail = store.loadTail('t1', 20)
    expect(tail).toHaveLength(20)
    expect(tail[0].index).toBe(481)
    expect(tail[19].index).toBe(500)
  })

  it('returns the whole history when the tail is bigger than it', () => {
    save([rec(1), rec(2)])
    expect(store.loadTail('t1', 50)).toHaveLength(2)
  })

  it('folds pending writes in, so a search never misses the turn just finished', () => {
    save([rec(1)])
    store.scheduleSave('t1', [rec(1), rec(2)])
    expect(store.count('t1')).toBe(2)
    expect(store.loadTail('t1', 5).map((r) => r.index)).toEqual([1, 2])
  })
})

describe('TurnStore — migration from the old JSON array', () => {
  it('reads a legacy .json file and rewrites it as lines', () => {
    writeFileSync(path.join(dir, 't1.json'), JSON.stringify([rec(1), rec(2)], null, 2), 'utf8')
    expect(store.load('t1').map((r) => r.index)).toEqual([1, 2])
    expect(existsSync(path.join(dir, 't1.jsonl'))).toBe(true)
  })

  it('counts a legacy file correctly', () => {
    writeFileSync(path.join(dir, 't1.json'), JSON.stringify([rec(1), rec(2), rec(3)]), 'utf8')
    expect(store.count('t1')).toBe(3)
  })

  it('includes legacy agents in the full ledger walk', () => {
    writeFileSync(path.join(dir, 'legacy.json'), JSON.stringify([rec(1)]), 'utf8')
    save([rec(1), rec(2)])
    const all = store.loadAll()
    expect(all.get('legacy')).toHaveLength(1)
    expect(all.get('t1')).toHaveLength(2)
  })

  it('does not lose the history if a line is corrupt — and count() drops it too', () => {
    save([rec(1), rec(2)])
    writeFileSync(path.join(dir, 't1.jsonl'), `${lines()[0]}\n{ broken\n${lines()[1]}\n`, 'utf8')
    expect(store.load('t1').map((r) => r.index)).toEqual([1, 2])
    // Sol r8 P2: the reader drops the corrupt line, so the count must not
    // keep it — the old physical-line count answered 3 here.
    expect(store.count('t1')).toBe(2)
  })
})

/**
 * Sol r6 P1: the delta pipeline must stay O(delta) ACROSS A RESTART. Before
 * the load-time seeding, a fresh store had no written-tail metadata, so the
 * first scheduleDelta after a boot fell through to a whole-file rewrite.
 */
describe('TurnStore — cold start stays O(delta)', () => {
  const file = (): string => path.join(dir, 't1.jsonl')

  it('APPENDS on the first delta after a restart: load seeds the written tail', () => {
    save([rec(1), rec(2)])
    const fresh = new TurnStore(dir)
    fresh.load('t1')
    const internals = fresh as unknown as { writeAll: (id: string, records: TurnRecord[]) => void }
    const writeAll = vi.spyOn(internals, 'writeAll')
    const before = readFileSync(file(), 'utf8')

    fresh.scheduleDelta('t1', [rec(1), rec(2), rec(3)], [rec(3)])
    fresh.flushAll()

    // Exactly one appended line; the prior bytes are untouched.
    expect(writeAll).not.toHaveBeenCalled()
    const after = readFileSync(file(), 'utf8')
    expect(after.startsWith(before)).toBe(true)
    expect(after.trim().split('\n')).toHaveLength(3)
    expect(fresh.load('t1').map((r) => r.index)).toEqual([1, 2, 3])
  })

  it('supersedes the tail via an appended overlay on the first tail-delta after a restart', () => {
    save([rec(1), rec(2)])
    const fresh = new TurnStore(dir)
    fresh.load('t1')
    const internals = fresh as unknown as { writeAll: (id: string, records: TurnRecord[]) => void }
    const writeAll = vi.spyOn(internals, 'writeAll')
    const before = readFileSync(file(), 'utf8')

    const finalized = rec(2, { reply: 'grew a reply', final: true })
    fresh.scheduleDelta('t1', [rec(1), finalized], [finalized])
    fresh.flushAll()

    // Sol r7 P1: the tail change is an APPENDED overlay line — every byte
    // that was in the file is still there, and only the overlay was written.
    expect(writeAll).not.toHaveBeenCalled()
    const after = readFileSync(file(), 'utf8')
    expect(after.startsWith(before)).toBe(true)
    const physical = after.trim().split('\n')
    expect(physical).toHaveLength(3)
    expect(physical[2].startsWith('{"__tail":true,"supersedes":2,')).toBe(true)
    // Logically the history is still two records, tail replaced.
    expect(fresh.count('t1')).toBe(2)
    expect(fresh.load('t1').map((r) => r.reply)).toEqual(['reply 1', 'grew a reply'])
    expect(new TurnStore(dir).load('t1')[1].reply).toBe('grew a reply')
  })

  it('does NOT trust a file whose lines did not all parse as an append base', () => {
    save([rec(1), rec(2)])
    const good = lines()
    writeFileSync(file(), `${good[0]}\n{ broken\n${good[1]}\n`, 'utf8')
    const fresh = new TurnStore(dir)
    fresh.load('t1')

    fresh.scheduleDelta('t1', [rec(1), rec(2), rec(3)], [rec(3)])
    fresh.flushAll()

    // The unclean read cleared the append base, so the flush rewrote the file
    // whole — appending relative to a count the file does not have would land
    // records in the wrong place.
    expect(readFileSync(file(), 'utf8')).not.toContain('{ broken')
    expect(fresh.load('t1').map((r) => r.index)).toEqual([1, 2, 3])
  })
})

/**
 * Sol r6 P2 / r7 P1: the tail-change write must never destroy the old tail —
 * the overlay append adds bytes and destroys none — and a failed flush must
 * retain its work for retry.
 */
describe('TurnStore — tail replacement is crash-safe and failure retains retry state', () => {
  const file = (): string => path.join(dir, 't1.jsonl')

  it('a failed tail overlay leaves the old bytes byte-identical, then the retry lands it', () => {
    save([rec(1), rec(2)])
    const before = readFileSync(file(), 'utf8')

    // A read-only ledger file fails the overlay append before any byte of the
    // original can move — the crash-window guarantee, observed from outside.
    chmodSync(file(), 0o400)
    const finalized = rec(2, { reply: 'finalized late', final: true })
    store.scheduleDelta('t1', [rec(1), finalized], [finalized])
    store.flushAll()
    expect(readFileSync(file(), 'utf8')).toBe(before)

    // The un-landed records were retained as dirty state: the next flush
    // retries the SAME tail update and it lands.
    chmodSync(file(), 0o600)
    store.flushAll()
    const after = readFileSync(file(), 'utf8')
    expect(after.startsWith(before)).toBe(true)
    expect(after).toContain('finalized late')
    expect(new TurnStore(dir).load('t1')[1].reply).toBe('finalized late')
  })

  // Windows: fault-injection via chmod 0o500 on a directory is ignored by NTFS — macOS/Linux CI covers it.
  it.skipIf(process.platform === 'win32')('a failed full rewrite also leaves the previous file intact and retries', () => {
    save([rec(1), rec(2), rec(3)])
    const before = readFileSync(file(), 'utf8')

    chmodSync(dir, 0o500)
    store.scheduleSave('t1', [rec(1), rec(3)])
    store.flushAll()
    expect(readFileSync(file(), 'utf8')).toBe(before)

    chmodSync(dir, 0o700)
    store.flushAll()
    expect(new TurnStore(dir).load('t1').map((r) => r.index)).toEqual([1, 3])
  })
})

describe('TurnStore — removal', () => {
  it('drops the file for a deleted terminal', () => {
    save([rec(1)])
    store.remove('t1')
    expect(store.load('t1')).toEqual([])
    expect(store.count('t1')).toBe(0)
  })
})
