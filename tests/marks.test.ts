// The marks ledger: last-wins, append-only, 0600 — and it REFUSES to hold
// the conversation, which is the invariant the one-stream design rests on.

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MARK_TITLE_MAX,
  MarkRefused,
  markFileFor,
  markLineOf,
  readMarkLedger,
  readMarks,
  writeMark
} from '../src/main/marks'

let dir: string
const ID = 'a1b2c3d4-0000-4000-8000-000000000001'

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'marks-'))
})

describe('writeMark / readMarks', () => {
  it('folds last-wins per identity, field by field', () => {
    writeMark(ID, { identity: 'u1', title: 'first title' }, { dir, now: () => 1000 })
    writeMark(ID, { identity: 'u1', seenAt: 2000 }, { dir, now: () => 2000 })
    writeMark(ID, { identity: 'u1', title: 'better title' }, { dir, now: () => 3000 })
    writeMark(ID, { identity: 'u2', pin: 7 }, { dir, now: () => 4000 })

    const marks = readMarks(ID, { dir })
    expect(marks.get('u1')).toEqual({
      identity: 'u1',
      at: 3000,
      title: 'better title',
      seenAt: 2000
    })
    expect(marks.get('u2')).toEqual({ identity: 'u2', at: 4000, pin: 7 })
  })

  it('is append-only — every change keeps its own line', () => {
    writeMark(ID, { identity: 'u1', title: 'one' }, { dir })
    writeMark(ID, { identity: 'u1', title: 'two' }, { dir })
    const body = readFileSync(path.join(dir, `${ID}.jsonl`), 'utf8')
    expect(body.trimEnd().split('\n')).toHaveLength(2)
    expect(body.endsWith('\n')).toBe(true)
  })

  it('null clears a field — an un-pinned checkpoint is expressible', () => {
    writeMark(ID, { identity: 'u1', pin: 3, title: 'kept' }, { dir })
    writeMark(ID, { identity: 'u1', pin: null }, { dir })
    expect(readMarks(ID, { dir }).get('u1')).toMatchObject({ title: 'kept' })
    expect(readMarks(ID, { dir }).get('u1')?.pin).toBeUndefined()
  })

  it('writes 0600 files in a 0700 directory', () => {
    writeMark(ID, { identity: 'u1', seenAt: 1 }, { dir: path.join(dir, 'nested') })
    const file = path.join(dir, 'nested', `${ID}.jsonl`)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(path.join(dir, 'nested')).mode & 0o777).toBe(0o700)
  })

  it('an absent ledger reads as no marks, never an exception', () => {
    expect(readMarks(ID, { dir }).size).toBe(0)
  })

  it('refuses an unusable terminal id instead of writing a path segment', () => {
    expect(markFileFor('../escape', { dir })).toBeNull()
    expect(writeMark('../escape', { identity: 'u1', title: 'x' }, { dir })).toEqual({
      ok: false,
      error: 'refusing unusable terminal id: ../escape'
    })
  })
})

describe('the ledger cannot hold the conversation', () => {
  it('refuses prompt and reply by name', () => {
    for (const key of ['prompt', 'reply', 'promptHead', 'text', 'content', 'activity']) {
      expect(() =>
        writeMark(ID, { identity: 'u1', [key]: 'the whole exchange' } as never, { dir })
      ).toThrow(MarkRefused)
    }
    expect(readMarks(ID, { dir }).size).toBe(0)
  })

  it('refuses any field outside the mark itself', () => {
    expect(() => markLineOf({ identity: 'u1', outcome: 'failed' } as never, 1)).toThrow(
      /unknown mark field: outcome/
    )
  })

  it('refuses a title long enough to be a document', () => {
    expect(() => markLineOf({ identity: 'u1', title: 'x'.repeat(MARK_TITLE_MAX + 1) }, 1)).toThrow(
      MarkRefused
    )
    expect(() => markLineOf({ identity: 'u1', title: 'x'.repeat(MARK_TITLE_MAX) }, 1)).not.toThrow()
  })

  it('refuses a mark with no identity, and one with nothing to say', () => {
    expect(() => markLineOf({ identity: '', title: 'x' }, 1)).toThrow(MarkRefused)
    expect(() => markLineOf({ identity: 'u1' }, 1)).toThrow(/records nothing/)
  })

  it('refuses a non-numeric seenAt', () => {
    expect(() => markLineOf({ identity: 'u1', seenAt: 'now' as never }, 1)).toThrow(MarkRefused)
  })
})

describe('a torn tail costs the torn line and nothing else', () => {
  it('drops a partial last line and keeps every complete one', () => {
    const file = path.join(dir, `${ID}.jsonl`)
    writeFileSync(
      file,
      `${JSON.stringify({ identity: 'u1', at: 1, title: 'landed' })}\n` +
        '{"identity":"u2","at":2,"tit'
    )
    const ledger = readMarkLedger(ID, { dir })
    expect(ledger.tornTail).toBe(true)
    expect([...ledger.marks.keys()]).toEqual(['u1'])
  })

  it('counts a corrupt complete line rather than hiding it', () => {
    const file = path.join(dir, `${ID}.jsonl`)
    writeFileSync(file, `not json\n${JSON.stringify({ identity: 'u1', at: 1, title: 'ok' })}\n`)
    const ledger = readMarkLedger(ID, { dir })
    expect(ledger.skipped).toBe(1)
    expect(ledger.marks.get('u1')?.title).toBe('ok')
  })
})
