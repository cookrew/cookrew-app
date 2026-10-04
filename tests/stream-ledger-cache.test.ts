// THE TWO LEDGERS A TRANSCRIPT OPEN READS ARE PARSED ONCE PER CHANGE, NOT ONCE
// PER CALL (perf, 2026-10-04).
//
// ~/.cookrew/stream/<id>.json is read at the top of every materialise and
// ~/.cookrew/marks/<id>.jsonl twice per /stream/open and once per live tick
// that touches it. On the owner's busiest card those are 646 KB and 172 KB,
// and neither changes faster than a turn or a scroll. The claim here is
// structural, not timed: the SAME object comes back while the file's stat is
// the same, a new one the moment the file changes, and the shared object is
// frozen so a reader that mutates it fails loudly instead of corrupting the
// next reader's answer.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { forgetMarkLedgers, readMarkLedger, readMarks, writeMark } from '../src/main/marks'
import {
  STREAM_STATE_VERSION,
  forgetStreamStates,
  readStreamState,
  streamStateFileFor,
  writeStreamState,
  type StreamState
} from '../src/main/stream-state'

const T0 = Date.parse('2026-10-04T09:00:00.000Z')

function state(rows: number, cursorBytes: number): StreamState {
  return {
    version: STREAM_STATE_VERSION,
    cursor: { file: '/t/s.jsonl', byteOffset: cursorBytes, ordinal: rows },
    anomalies: {},
    rolledBack: [],
    index: Array.from({ length: rows }, (_, at) => ({
      identity: `id-${at + 1}`,
      ordinal: at + 1,
      startedAt: T0 + at,
      endedAt: T0 + at + 1,
      promptHead: `ask ${at + 1}`,
      compacted: false,
      file: '/t/s.jsonl',
      firstAt: T0,
      latestAt: T0,
      occurrences: [{ file: '/t/s.jsonl', byteOffset: cursorBytes }]
    }))
  }
}

describe('the persisted stream state', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'state-cache-'))
    forgetStreamStates()
  })

  it('answers the SAME object while the file has not changed', () => {
    expect(writeStreamState('card', state(3, 100), { dir }).ok).toBe(true)
    const first = readStreamState('card', { dir })
    const second = readStreamState('card', { dir })
    expect(first.index).toHaveLength(3)
    // Identity, not equality: equal objects could have been parsed twice.
    expect(second).toBe(first)
  })

  it('remembers what it wrote, so the read after a write parses nothing', () => {
    const written = state(2, 50)
    writeStreamState('card', written, { dir })
    expect(readStreamState('card', { dir })).toBe(written)
  })

  it('answers a NEW object the moment the file changes', () => {
    writeStreamState('card', state(2, 50), { dir })
    const before = readStreamState('card', { dir })
    writeStreamState('card', state(3, 90), { dir })
    const after = readStreamState('card', { dir })
    expect(after).not.toBe(before)
    expect(after.index).toHaveLength(3)
    expect(after.cursor.byteOffset).toBe(90)
  })

  it('sees a rewrite made behind its back — the stat is the key, not the call', () => {
    writeStreamState('card', state(1, 10), { dir })
    readStreamState('card', { dir })
    const file = streamStateFileFor('card', { dir }) as string
    writeFileSync(file, `${JSON.stringify(state(4, 400))}\n`)
    expect(readStreamState('card', { dir }).index).toHaveLength(4)
  })

  it('is frozen: a reader that writes into the shared object fails loudly', () => {
    writeStreamState('card', state(2, 50), { dir })
    const shared = readStreamState('card', { dir })
    expect(Object.isFrozen(shared)).toBe(true)
    expect(Object.isFrozen(shared.index)).toBe(true)
    expect(() => {
      ;(shared.index as unknown[]).push({})
    }).toThrow(TypeError)
    expect(() => {
      ;(shared as { cursor: unknown }).cursor = null
    }).toThrow(TypeError)
  })

  it('still answers an absent file as the empty state, every time', () => {
    const first = readStreamState('nobody', { dir })
    expect(first.index).toEqual([])
    expect(first.cursor.file).toBe('')
  })
})

describe('the marks ledger', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'marks-cache-'))
    forgetMarkLedgers()
  })

  it('answers the SAME fold while the ledger has not changed', () => {
    writeMark('card', { identity: 'a', title: 'first' }, { dir })
    const first = readMarkLedger('card', { dir })
    expect(readMarkLedger('card', { dir })).toBe(first)
    expect(readMarks('card', { dir })).toBe(first.marks)
    expect(first.marks.get('a')?.title).toBe('first')
  })

  it('folds afresh after a write — the append is seen, and so is the forget', () => {
    writeMark('card', { identity: 'a', title: 'first' }, { dir })
    const before = readMarkLedger('card', { dir })
    writeMark('card', { identity: 'a', title: 'second' }, { dir })
    const after = readMarkLedger('card', { dir })
    expect(after).not.toBe(before)
    expect(after.marks.get('a')?.title).toBe('second')
    // The earlier answer is untouched: a caller still holding it sees what it
    // read, not what was written later.
    expect(before.marks.get('a')?.title).toBe('first')
  })

  it('answers an absent ledger as empty without remembering anything wrong', () => {
    expect(readMarks('nobody', { dir }).size).toBe(0)
    writeMark('nobody', { identity: 'z', title: 'now' }, { dir })
    expect(readMarks('nobody', { dir }).get('z')?.title).toBe('now')
  })
})
