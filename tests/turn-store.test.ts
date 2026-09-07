// THE OLD STORE AS A READER (one-stream T4).
//
// turn-store.ts has no writer any more, so what is left to hold is what it
// promises to read back: a JSONL ledger, a pre-JSONL array file, the tail
// overlays the retired writer left behind, and a corrupt line that must cost
// a line and not the file. Fixtures are written straight to disk or through
// ScrapeHistoryStore — the one writer left — because the store itself can no
// longer produce one.
//
// Deleted with the writer: tests/turn-store-jsonl.test.ts (append vs rewrite,
// overlay emission, permissions), the five fold suites, and
// tests/ledger-write-choke.test.ts. The write half of those contracts is now
// tests/scrape-history.test.ts; the fold has no behaviour left to test.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ScrapeHistoryStore } from '../src/main/scrape-history'
import { TurnStore } from '../src/main/turn-store'
import type { TurnRecord } from '../src/shared/turn'

function freshStore(): { store: TurnStore; writer: ScrapeHistoryStore; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-turns-'))
  const store = new TurnStore(dir)
  return { store, writer: new ScrapeHistoryStore(dir, store.annotationsDir, store), dir }
}

const RECORDS: TurnRecord[] = [
  { index: 1, prompt: 'build it', reply: 'built', startedAt: 100, endedAt: 200 },
  { index: 2, prompt: 'test it', reply: 'tested', title: 'Running tests', startedAt: 300, endedAt: 400 }
]

describe('TurnStore — the reader', () => {
  it('round-trips records written by the one writer left', () => {
    const { store, writer } = freshStore()
    writer.save('term-a', RECORDS)
    expect(store.load('term-a')).toEqual(RECORDS)
  })

  it('returns [] for terminals never saved', () => {
    const { store } = freshStore()
    expect(store.load('nope')).toEqual([])
  })

  it('drops malformed entries from hand-edited files', () => {
    const { store, dir } = freshStore()
    writeFileSync(
      path.join(dir, 'term-b.json'),
      JSON.stringify([RECORDS[0], { junk: true }, 'nope', RECORDS[1]]),
      'utf8'
    )
    expect(store.load('term-b')).toEqual(RECORDS)
  })

  it('survives a corrupt file', () => {
    const { store, dir } = freshStore()
    writeFileSync(path.join(dir, 'term-c.json'), '{not json', 'utf8')
    expect(store.load('term-c')).toEqual([])
  })

  it('does NOT rewrite a legacy array file it reads — a reader converts nothing', () => {
    const { store, dir } = freshStore()
    const legacy = path.join(dir, 'term-e.json')
    writeFileSync(legacy, JSON.stringify(RECORDS), 'utf8')
    expect(store.load('term-e')).toEqual(RECORDS)
    // The old store migrated to .jsonl and renamed this to .migrated. That was
    // a write, and this is the only copy of a pre-JSONL history.
    expect(existsSync(legacy)).toBe(true)
    expect(existsSync(path.join(dir, 'term-e.jsonl'))).toBe(false)
    expect(existsSync(`${legacy}.migrated`)).toBe(false)
  })

  it('applies the retired writer s tail overlays, last wins per index', () => {
    const { store, dir } = freshStore()
    const base = { index: 1, prompt: 'ask', reply: 'first', startedAt: 1, endedAt: 2 }
    const newer = { ...base, reply: 'final' }
    writeFileSync(
      path.join(dir, 'term-f.jsonl'),
      `${JSON.stringify(base)}\n{"__tail":true,"supersedes":1,${JSON.stringify(newer).slice(1)}\n`,
      'utf8'
    )
    expect(store.load('term-f')).toEqual([newer])
    expect(store.count('term-f')).toBe(1)
  })

  it('count agrees with load on a file the reader had to recover', () => {
    const { store, dir } = freshStore()
    writeFileSync(
      path.join(dir, 'term-g.jsonl'),
      `${JSON.stringify(RECORDS[0])}\nnot json at all\n${JSON.stringify(RECORDS[1])}\n`,
      'utf8'
    )
    expect(store.load('term-g')).toHaveLength(2)
    expect(store.count('term-g')).toBe(2)
  })

  it('re-reads when the file moves under it — no write-through cache to trust', () => {
    const { store, dir } = freshStore()
    const file = path.join(dir, 'term-h.jsonl')
    writeFileSync(file, `${JSON.stringify(RECORDS[0])}\n`, 'utf8')
    expect(store.load('term-h')).toHaveLength(1)
    writeFileSync(file, `${JSON.stringify(RECORDS[0])}\n${JSON.stringify(RECORDS[1])}\n`, 'utf8')
    expect(store.viewIsStale('term-h')).toBe(true)
    expect(store.load('term-h')).toHaveLength(2)
  })

  it('remove deletes the file — the one erasure a reader still performs', () => {
    const { store, writer, dir } = freshStore()
    writer.save('term-d', RECORDS)
    expect(existsSync(path.join(dir, 'term-d.jsonl'))).toBe(true)
    store.remove('term-d')
    expect(existsSync(path.join(dir, 'term-d.jsonl'))).toBe(false)
    expect(store.load('term-d')).toEqual([])
  })

  it('sanitizes terminal ids used as filenames', () => {
    const { store, writer, dir } = freshStore()
    writer.save('../evil/../../id', RECORDS)
    expect(readFileSync(path.join(dir, 'evilid.jsonl'), 'utf8')).toContain('build it')
    expect(store.load('../evil/../../id')).toEqual(RECORDS)
  })

  it('loadAll omits empty ledgers and follows a file that changed', () => {
    const { store, writer, dir } = freshStore()
    writer.save('term-i', RECORDS)
    writeFileSync(path.join(dir, 'term-empty.jsonl'), '', 'utf8')
    expect([...store.loadAll().keys()]).toEqual(['term-i'])
    writeFileSync(path.join(dir, 'term-i.jsonl'), `${JSON.stringify(RECORDS[0])}\n`, 'utf8')
    expect(store.loadAll().get('term-i')).toHaveLength(1)
  })
})
