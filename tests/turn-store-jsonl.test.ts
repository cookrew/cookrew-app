import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TurnStore } from '../src/main/turn-store'
import type { TurnRecord } from '../src/shared/turn'

let dir: string
let store: TurnStore

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cookrew-turns-'))
  store = new TurnStore(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

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

  it('does not lose the history if a line is corrupt', () => {
    save([rec(1), rec(2)])
    writeFileSync(path.join(dir, 't1.jsonl'), `${lines()[0]}\n{ broken\n${lines()[1]}\n`, 'utf8')
    expect(store.load('t1').map((r) => r.index)).toEqual([1, 2])
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
