// THE ONE WRITER LEFT (one-stream T4).
//
// scrape-history.ts replaces turn-store's whole write half for the one case
// the design keeps: a harness with no session file, whose PTY scrape is the
// only record its history will ever have. What tests/turn-store-jsonl.test.ts
// held for the retired writer — one line per record, append rather than
// rewrite, a hand-edited file that must not be extended blindly, an id that
// cannot escape its directory — is held here, minus the machinery that went
// with the second copy of the conversation (tail overlays, the bounded fold,
// the delta contract, the directory-fsync debt).
//
// The reader's side of the same contract is tests/turn-store.test.ts.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScrapeHistoryStore } from '../src/main/scrape-history'
import { TurnStore } from '../src/main/turn-store'
import type { TurnRecord } from '../src/shared/turn'

let dir = ''
let store: TurnStore
let writer: ScrapeHistoryStore

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'scrape-history-'))
  store = new TurnStore(dir)
  writer = new ScrapeHistoryStore(dir, store.annotationsDir, store)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const rec = (index: number, over: Partial<TurnRecord> = {}): TurnRecord => ({
  index,
  prompt: `ask ${index}`,
  reply: `reply ${index}`,
  startedAt: index * 10,
  endedAt: index * 10 + 5,
  ...over
})

const ledger = (id = 't1'): string => path.join(dir, `${id}.jsonl`)
const lines = (id = 't1'): string[] =>
  readFileSync(ledger(id), 'utf8').trim().split('\n').filter(Boolean)

describe('ScrapeHistoryStore — one line per record', () => {
  it('writes the whole history the first time and reads back through TurnStore', () => {
    expect(writer.save('t1', [rec(1), rec(2)])).toMatchObject({ ok: true, detail: 'rewrite' })
    expect(lines()).toHaveLength(2)
    expect(store.load('t1')).toEqual([rec(1), rec(2)])
  })

  it('APPENDS a new turn instead of rewriting the file', () => {
    writer.save('t1', [rec(1)])
    const first = readFileSync(ledger(), 'utf8')
    expect(writer.save('t1', [rec(1), rec(2)])).toMatchObject({ detail: 'append' })
    // The prefix is byte-identical: the append touched nothing that was there.
    expect(readFileSync(ledger(), 'utf8').startsWith(first)).toBe(true)
    expect(store.load('t1')).toHaveLength(2)
  })

  it('says nothing to do when the history has not changed', () => {
    writer.save('t1', [rec(1)])
    expect(writer.save('t1', [rec(1)])).toMatchObject({ ok: true, detail: 'unchanged' })
    expect(lines()).toHaveLength(1)
  })

  it('REWRITES when the history shrank — a dedupe dropped a phantom twin', () => {
    writer.save('t1', [rec(1), rec(2), rec(3)])
    expect(writer.save('t1', [rec(1), rec(2)])).toMatchObject({ detail: 'rewrite' })
    expect(lines()).toHaveLength(2)
    expect(store.load('t1')).toEqual([rec(1), rec(2)])
  })

  it('REWRITES when a record in the middle changed', () => {
    writer.save('t1', [rec(1), rec(2)])
    const edited = [rec(1, { reply: 'edited' }), rec(2)]
    expect(writer.save('t1', edited)).toMatchObject({ detail: 'rewrite' })
    expect(store.load('t1')).toEqual(edited)
  })
})

describe('ScrapeHistoryStore — it reads before it writes', () => {
  it('a FRESH writer over an existing ledger appends rather than overwriting it', () => {
    writer.save('t1', [rec(1), rec(2), rec(3)])
    // A new process: nothing remembered, the file already holds three.
    const reborn = new ScrapeHistoryStore(dir, store.annotationsDir, new TurnStore(dir))
    expect(reborn.save('t1', [rec(1), rec(2), rec(3), rec(4)])).toMatchObject({ detail: 'append' })
    expect(new TurnStore(dir).load('t1')).toHaveLength(4)
  })

  it('folds a pre-T4 ledger s tail overlays away on the first rewrite', () => {
    const base = rec(1)
    const newer = rec(1, { reply: 'final' })
    writeFileSync(
      ledger(),
      `${JSON.stringify(base)}\n{"__tail":true,"supersedes":1,${JSON.stringify(newer).slice(1)}\n`,
      'utf8'
    )
    // The reader's logical view is one record; the writer's history is that
    // record plus a new one, so this is a plain append onto the overlay file.
    expect(writer.save('t1', [newer, rec(2)])).toMatchObject({ detail: 'append' })
    expect(store.load('t1')).toEqual([newer, rec(2)])
    // A shrink then rewrites the whole file, and the overlay goes with it.
    writer.save('t1', [newer])
    expect(lines()).toHaveLength(1)
    expect(readFileSync(ledger(), 'utf8')).not.toContain('__tail')
  })

  it('a file that moved under the writer is re-read before the next write', () => {
    writer.save('t1', [rec(1)])
    writeFileSync(ledger(), `${JSON.stringify(rec(1))}\n${JSON.stringify(rec(2))}\n`, 'utf8')
    // Two records on disk now; the writer must notice rather than append
    // record 2 a second time.
    expect(writer.save('t1', [rec(1), rec(2)])).toMatchObject({ detail: 'unchanged' })
    expect(store.load('t1')).toHaveLength(2)
  })
})

describe('ScrapeHistoryStore — annotations and ids', () => {
  it('keeps title and seenAt OUT of the conversation lines', () => {
    writer.save('t1', [rec(1, { title: 'A title', seenAt: 99, scrollLine: 7 })])
    const raw = readFileSync(ledger(), 'utf8')
    expect(raw).not.toContain('A title')
    // …and hands them back on the record, from the sidecar.
    expect(store.load('t1')[0]).toMatchObject({ title: 'A title', seenAt: 99, scrollLine: 7 })
  })

  it('the annotation sidecar is never inside the turns directory', () => {
    expect(store.annotationsDir.startsWith(dir)).toBe(false)
  })

  it('sanitizes an id that would otherwise escape the directory', () => {
    writer.save('../evil/../../id', [rec(1)])
    expect(existsSync(path.join(dir, 'evilid.jsonl'))).toBe(true)
  })

  it('an unwritable directory costs the line, never the turn', () => {
    const closed = new ScrapeHistoryStore(
      path.join(dir, 'nope', '\0bad'),
      path.join(dir, 'annotations')
    )
    expect(closed.save('t1', [rec(1)]).ok).toBe(false)
  })

  it('forget drops the remembered tail so a recycled id cannot inherit one', () => {
    writer.save('t1', [rec(1)])
    rmSync(ledger())
    writer.forget('t1')
    expect(writer.save('t1', [rec(9)])).toMatchObject({ detail: 'rewrite' })
    expect(store.load('t1')).toEqual([rec(9)])
  })
})
