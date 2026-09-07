// THE PERSISTED CURSOR (one-stream T2.5, panel C ①).
//
// The claim: advancing the cursor and persisting the rows it covers is ONE
// atomic write, so a crash between the temp file and the rename leaves the
// PREVIOUS state whole and readable — the store falls behind the transcript
// and never claims rows it did not materialise (Codex thread_history.rs:112).

import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  STREAM_STATE_VERSION,
  emptyStreamState,
  parseStreamState,
  readStreamState,
  streamStateFileFor,
  writeStreamState,
  type StreamState
} from '../src/main/stream-state'

const T0 = Date.parse('2026-09-07T09:00:00.000Z')

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'stream-state-'))
})

function state(over: Partial<StreamState> = {}): StreamState {
  return {
    ...emptyStreamState(),
    cursor: { file: '/tmp/s1.jsonl', byteOffset: 4096, ordinal: 7 },
    index: [
      {
        identity: 'u7',
        ordinal: 7,
        startedAt: T0,
        endedAt: T0 + 500,
        promptHead: 'seven',
        compacted: false,
        file: '/tmp/s1.jsonl',
        firstAt: T0,
        latestAt: T0 + 500,
        occurrences: [{ file: '/tmp/s1.jsonl', byteOffset: 4096 }]
      }
    ],
    ...over
  }
}

describe('streamStateFileFor', () => {
  it('refuses an id that cannot safely name a file', () => {
    expect(streamStateFileFor('../escape', { dir })).toBeNull()
    expect(streamStateFileFor('', { dir })).toBeNull()
    expect(streamStateFileFor('term-1', { dir })).toBe(path.join(dir, 'term-1.json'))
  })
})

describe('writeStreamState', () => {
  it('round-trips the cursor, the counts, the rollbacks and the rows', () => {
    const written = state({
      anomalies: { UnknownLine: 2 },
      rolledBack: [{ fromOrdinal: 5, at: T0 }]
    })
    expect(writeStreamState('term-1', written, { dir }).ok).toBe(true)
    expect(readStreamState('term-1', { dir })).toEqual(written)
  })

  it('writes 0600 into a 0700 directory — the owner’s session shape', () => {
    writeStreamState('term-1', state(), { dir })
    const file = streamStateFileFor('term-1', { dir }) as string
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
  })

  it('a crash between the temp file and the rename leaves the OLD state readable', () => {
    const first = state()
    expect(writeStreamState('term-1', first, { dir }).ok).toBe(true)
    const ahead = state({ cursor: { file: '/tmp/s1.jsonl', byteOffset: 999_999, ordinal: 99 } })
    const result = writeStreamState('term-1', ahead, {
      dir,
      rename: () => {
        throw new Error('simulated crash before rename')
      }
    })
    expect(result.ok).toBe(false)
    // Behind the transcript, not lying about it.
    expect(readStreamState('term-1', { dir })).toEqual(first)
    // …and no temp file is left to be mistaken for the record.
    expect(readdirSync(dir)).toEqual(['term-1.json'])
  })

  it('an unusable terminal id is a refusal, never a thrown write', () => {
    const result = writeStreamState('../escape', state(), { dir })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('refusing unusable terminal id')
  })
})

describe('readStreamState', () => {
  it('an absent file is an empty cursor — a full replay, never a wrong one', () => {
    expect(readStreamState('never-written', { dir })).toEqual(emptyStreamState())
    expect(existsSync(path.join(dir, 'never-written.json'))).toBe(false)
  })

  it('unparseable, wrong-shaped and future-versioned states all read as empty', () => {
    expect(parseStreamState('{ not json')).toEqual(emptyStreamState())
    expect(parseStreamState('[]')).toEqual(emptyStreamState())
    expect(parseStreamState(JSON.stringify({ version: 99, cursor: { ordinal: 5 } }))).toEqual(
      emptyStreamState()
    )
  })

  it('drops a row that will not parse rather than guessing at it', () => {
    const parsed = parseStreamState(
      JSON.stringify({
        version: STREAM_STATE_VERSION,
        cursor: { file: 'f', byteOffset: 1, ordinal: 2 },
        anomalies: { UnknownLine: 1, NotAClass: 4 },
        rolledBack: [{ fromOrdinal: 2, at: T0 }, { nope: true }],
        index: [
          { identity: '', ordinal: 1 },
          { identity: 'u2', ordinal: 2, startedAt: 1, endedAt: 2, file: 'f' }
        ]
      })
    )
    expect(parsed.index.map((row) => row.identity)).toEqual(['u2'])
    expect(parsed.anomalies).toEqual({ UnknownLine: 1 })
    expect(parsed.rolledBack).toEqual([{ fromOrdinal: 2, at: T0 }])
  })

  it('a truncated file on disk reads as empty, never as a partial cursor', () => {
    writeFileSync(path.join(dir, 'term-1.json'), '{"version":1,"curso')
    expect(readStreamState('term-1', { dir })).toEqual(emptyStreamState())
  })
})
