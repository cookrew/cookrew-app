// WHAT THE GATE READS OFF DISK — the half the pure verdicts stand on.
//
// SCOUT, 2026-09-07. `TRANSCRIPT GONE: b0d36b55` was printed for an id the
// app minted at spawn and replaced sixteen seconds later, because a rotation
// event NAMING an id was being read as proof the id had a transcript. The
// rule that ended that is pure and pinned in checkpoint-gate-verdict; the
// facts it now judges are gathered by scripts/checkpoint-gate-lib.mjs, and a
// fact gathered wrongly re-opens the same defect from the other end:
//
//   R1  a stream row is evidence a transcript existed — the CURSOR is not,
//       because it is where the reader stands, not what it read
//   R2  a compaction summary names the predecessor it compacted, and that is
//       claude's own join
//   R3  a rotation is dated once, at the FIRST departure, so a flap cannot
//       inflate how long an id was held
//   R4  every read of a missing, torn or hand-edited file is an absence of
//       evidence, never a throw — a gate that crashes is a gate nobody runs

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compactionPredecessorsOf,
  markIdentities,
  rotationsOf,
  sessionIdOfFile,
  spillOf,
  streamEvidenceOf
} from '../scripts/checkpoint-gate-lib.mjs'

const CARD = 'fff6d33d-4595-4623-be1f-e3851ad040bc'
const MINTED = 'b0d36b55-a20a-4a97-9fe0-bca2740d25ac'
const LIVE = 'b77a8949-5e90-43fe-911e-f4a1ccb6eb09'
const OLDER = '4188d6fa-41a0-4618-8e66-ea2af33e42b1'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'checkpoint-gate-reads-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const write = (name: string, body: string): string => {
  const file = path.join(dir, name)
  writeFileSync(file, body)
  return file
}

const transcript = (id: string): string => path.join(dir, `${id}.jsonl`)

describe('R1 — the stream index says which transcripts were really read', () => {
  const state = (index: unknown[], cursorFile?: string): void => {
    writeFileSync(
      path.join(dir, `${CARD}.json`),
      JSON.stringify({ version: 1, index, cursor: cursorFile ? { file: cursorFile } : undefined })
    )
  }

  it('names the session each row was read out of', () => {
    state([{ identity: 'a', file: transcript(LIVE) }])
    expect([...streamEvidenceOf(dir, CARD)!.files]).toEqual([LIVE])
  })

  it('counts the replay copies and the occurrences behind a row', () => {
    state([
      {
        identity: 'a',
        file: transcript(LIVE),
        replayedIn: [transcript(OLDER)],
        occurrences: [{ file: transcript(MINTED) }]
      }
    ])
    expect(streamEvidenceOf(dir, CARD)!.files).toEqual(new Set([LIVE, OLDER, MINTED]))
  })

  it('does NOT count the cursor — that is where the reader stands', () => {
    // Five dormant /tmp cards were failed by exactly this on 2026-09-07: an
    // index the app had opened, a cursor naming a file, and no claim to make.
    state([], transcript(MINTED))
    expect(streamEvidenceOf(dir, CARD)!.files.size).toBe(0)
  })

  it('carries the rotation boundary predecessors and the row identities', () => {
    state([{ identity: 'mark-1', file: transcript(LIVE), previousSessionId: MINTED }])
    const evidence = streamEvidenceOf(dir, CARD)!
    expect(evidence.predecessors).toEqual(new Set([MINTED]))
    expect(evidence.identities).toEqual(new Set(['mark-1']))
  })

  it('is NULL when the app has materialised nothing — no answer, not "none"', () => {
    expect(streamEvidenceOf(dir, CARD)).toBeNull()
    writeFileSync(path.join(dir, `${CARD}.json`), '{"version":1}')
    expect(streamEvidenceOf(dir, CARD)).toBeNull()
  })
})

describe('R2 — a compaction names the predecessor it compacted', () => {
  const summary = (own: string, predecessor: string): string =>
    JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      sessionId: own
    }) +
    '\n' +
    JSON.stringify({
      type: 'user',
      isCompactSummary: true,
      sessionId: own,
      session_id: predecessor
    }) +
    '\n'

  it('reads the predecessor out of a successor head', () => {
    const file = write(`${LIVE}.jsonl`, summary(LIVE, MINTED))
    expect(compactionPredecessorsOf([file])).toEqual(new Set([MINTED]))
  })

  it('says nothing about a file that declares no compaction', () => {
    const file = write(`${LIVE}.jsonl`, `${JSON.stringify({ type: 'mode', sessionId: LIVE })}\n`)
    expect(compactionPredecessorsOf([file]).size).toBe(0)
  })

  it('refuses a record that names itself', () => {
    const file = write(`${LIVE}.jsonl`, summary(LIVE, LIVE))
    expect(compactionPredecessorsOf([file]).size).toBe(0)
  })

  it('a file that is not there, or is not JSON, is no evidence and no throw', () => {
    const torn = write(`${OLDER}.jsonl`, '{"isCompactSummary":true,"session_id":"x\n')
    expect(compactionPredecessorsOf([transcript('nowhere'), torn]).size).toBe(0)
  })
})

describe('R3 — the event log dates a departure once, at the first one', () => {
  const events = (lines: object[]): void => {
    writeFileSync(path.join(dir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'))
  }

  const rotation = (from: string, to: string, timestamp: number): object => ({
    type: 'terminal.session-rotated',
    entityId: CARD,
    timestamp,
    details: `${from} → ${to}`
  })

  it("reads Scout's own hop: the witness, the destination and the departure", () => {
    events([rotation(MINTED.slice(0, 8), LIVE.slice(0, 8), 1788780875444)])
    const { witnesses, destinations, departures } = rotationsOf(dir, new Set([CARD]))
    expect(witnesses.get(CARD)).toEqual(new Set([MINTED.slice(0, 8), LIVE.slice(0, 8)]))
    expect(destinations.get(CARD)).toEqual([LIVE.slice(0, 8)])
    expect(departures.get(CARD)!.get(MINTED.slice(0, 8))).toBe(1788780875444)
  })

  it('keeps the FIRST departure when a card flaps back and leaves again', () => {
    // Otherwise a flap would report the id as held for the whole flap, and a
    // mint that was replaced in seconds would read as an afternoon's work.
    events([
      rotation('295d5f1c', 'a78aa3e5', 1_000),
      rotation('a78aa3e5', '295d5f1c', 2_000),
      rotation('295d5f1c', 'a78aa3e5', 9_000)
    ])
    expect(rotationsOf(dir, new Set([CARD])).departures.get(CARD)!.get('295d5f1c')).toBe(1_000)
  })

  it('ignores cards it was not asked about, and lines it cannot read', () => {
    events([rotation('295d5f1c', 'a78aa3e5', 1_000), { type: 'terminal.session-rotated' }])
    expect(rotationsOf(dir, new Set(['another-card'])).witnesses.size).toBe(0)
  })

  it('a directory with no event log at all is silence, not a crash', () => {
    expect(rotationsOf(path.join(dir, 'nowhere'), new Set([CARD])).witnesses.size).toBe(0)
  })
})

describe('R4 — the other records, and what an unreadable one means', () => {
  it('reads the durable lineage with the stamp that dates each binding', () => {
    writeFileSync(
      path.join(dir, `${CARD}.json`),
      JSON.stringify({
        version: 1,
        terminalId: CARD,
        ids: [LIVE, MINTED],
        boundAt: { [MINTED]: '2026-09-07T11:34:19.136Z' }
      })
    )
    const spill = spillOf(dir, CARD)
    expect(spill.ids).toEqual([LIVE, MINTED])
    expect(spill.boundAt[MINTED]).toBe('2026-09-07T11:34:19.136Z')
  })

  it('an absent lineage record is an empty one', () => {
    expect(spillOf(dir, CARD)).toMatchObject({ ids: [], boundAt: {} })
  })

  it('folds a mark ledger to its distinct identities and drops a torn tail', () => {
    write(`${CARD}.jsonl`, '{"identity":"a"}\n{"identity":"a"}\n{"identity":"b"}\n{"identi')
    expect(markIdentities(dir, CARD)).toEqual(['a', 'b'])
  })

  it('a card nobody has titled has no marks, and that is not an error', () => {
    expect(markIdentities(dir, 'no-such-card')).toEqual([])
  })

  it('only a .jsonl path names a session', () => {
    expect(sessionIdOfFile(transcript(LIVE))).toBe(LIVE)
    expect(sessionIdOfFile('/tmp/notes.txt')).toBeNull()
    expect(sessionIdOfFile(undefined)).toBeNull()
  })
})
