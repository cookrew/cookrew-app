import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { forkClaudeSession } from '../src/main/claude-fork'
import { rekeyPinsByUuid } from '../src/main/pin-rekey'
import { mergeCheckpointRows } from '../src/renderer/src/transcript'
import { parseClaudeTrace, traceIndexOf } from '../src/shared/trace-blocks'
import type { TurnRecord } from '../src/shared/turn'
import { cutVersionPin, pinAnchors, type VersionPinRecord } from '../src/shared/version-pin'

// THE BUG CLASS. A compact rotates the session file, and the durable turn
// ledger deliberately CONTINUES its numbering across the rotation (the owner's
// 400 lost checkpoints). The trace — the rail, the drawer, every T-number the
// user can see — numbers the CURRENT file from T1. Same conversation, two
// index spaces, and every seam that joined them BY INDEX picked a checkpoint
// from the wrong session: fork cut at a pre-compact turn, pins drew on the
// wrong row, titles paired with strangers. The join that cannot be fooled is
// the message uuid, which both sides carry; these tests pin every seam to it.

const T = (s: string): string => `2026-08-30T10:${s}:00.000Z`
const user = (text: string, ts: string, uuid: string): string =>
  JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: text }, timestamp: ts })
const assistant = (text: string, ts: string): string =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    timestamp: ts
  })

/** The CURRENT (post-compact) session file: three turns, u101..u103. */
function currentFileLines(): string[] {
  return [
    user('post-compact ask one', T('10'), 'u101'),
    assistant('reply one', T('11')),
    user('post-compact ask two', T('12'), 'u102'),
    assistant('reply two', T('13')),
    user('post-compact ask three', T('14'), 'u103'),
    assistant('reply three', T('15'))
  ]
}

/** The ledger as the chain continuation left it: indices 1..5 span TWO files —
 *  1..2 are pre-compact (uuids the current file has never held), 3..5 are the
 *  current file's turns under CONTINUED numbers. Trace space calls those same
 *  turns 1..3. */
function chainLedger(): TurnRecord[] {
  const rec = (index: number, uuid: string, prompt: string): TurnRecord => ({
    index,
    uuid,
    prompt,
    reply: `r-${uuid}`,
    title: `title-${uuid}`,
    startedAt: index,
    endedAt: index
  })
  return [
    rec(1, 'u001', 'pre-compact ask one'),
    rec(2, 'u002', 'pre-compact ask two'),
    rec(3, 'u101', 'post-compact ask one'),
    rec(4, 'u102', 'post-compact ask two'),
    rec(5, 'u103', 'post-compact ask three')
  ]
}

function sessionDirs(): { projectsDir: string; cwd: string; dir: string } {
  const projectsDir = mkdtempSync(path.join(tmpdir(), 'cookrew-align-'))
  const cwd = '/tmp/align-src'
  const dir = path.join(projectsDir, cwd.replace(/[/.]/g, '-'))
  mkdirSync(dir, { recursive: true })
  return { projectsDir, cwd, dir }
}

describe('fork cuts in the session the rail shows, not the ledger chain', () => {
  it('rail index resolves against the FILE blocks when ledger numbering diverged', () => {
    const { projectsDir, cwd, dir } = sessionDirs()
    writeFileSync(path.join(dir, 'current.jsonl'), currentFileLines().join('\n'))

    // The user forked rail row T2 — "post-compact ask two", u102. The ledger's
    // record at index 2 is the PRE-COMPACT u002; cutting there restores a
    // session state from before the compact, silently.
    const fork = forkClaudeSession({
      command: 'claude',
      cwd,
      sessionId: 'current',
      turns: chainLedger(),
      turnIndex: 2,
      projectsDir
    })
    expect(fork).not.toBeNull()
    const copy = readFileSync(
      path.join(dir, `${fork!.sessionId}.jsonl`),
      'utf8'
    )
    expect(copy).toContain('post-compact ask two')
    expect(copy).not.toContain('post-compact ask three') // truncated AT u102
  })

  it('a ledger-space index past the file ceiling still cuts by the ledger uuid (call-fork path)', () => {
    const { projectsDir, cwd, dir } = sessionDirs()
    writeFileSync(path.join(dir, 'current.jsonl'), currentFileLines().join('\n'))

    // cutCallVersion passes the LATEST ledger index (5). The file has no block
    // 5 — the ledger record's uuid (u103) must still bind the cut.
    const fork = forkClaudeSession({
      command: 'claude',
      cwd,
      sessionId: 'current',
      turns: chainLedger(),
      turnIndex: 5,
      projectsDir
    })
    expect(fork).not.toBeNull()
    const copy = readFileSync(path.join(dir, `${fork!.sessionId}.jsonl`), 'utf8')
    expect(copy).toContain('post-compact ask three')
  })
})

describe('trace index carries the block identity to the renderer', () => {
  it('traceIndexOf emits each block\'s stable id', () => {
    const blocks = parseClaudeTrace(currentFileLines())
    const entries = traceIndexOf(blocks)
    expect(entries.map((e) => e.id)).toEqual(['u101', 'u102', 'u103'])
    expect(entries.map((e) => e.index)).toEqual([1, 2, 3])
  })
})

describe('mergeCheckpointRows joins by uuid, never across sessions by index', () => {
  const traceIndex = [
    { index: 1, id: 'u101', title: 'post-compact ask one' },
    { index: 2, id: 'u102', title: 'post-compact ask two' },
    { index: 3, id: 'u103', title: 'post-compact ask three' }
  ]

  it('a chain ledger pairs records onto the rows that ARE those turns', () => {
    const rows = mergeCheckpointRows(chainLedger(), traceIndex)
    expect(rows.map((r) => r.index)).toEqual([1, 2, 3])
    // Row T2 is u102 — its record is ledger index 4, NOT ledger index 2.
    expect(rows[1].record?.uuid).toBe('u102')
    expect(rows[1].record?.title).toBe('title-u102')
    // Pre-compact records (u001/u002) belong to an earlier segment: no
    // phantom rows, no mispaired titles.
    expect(rows.every((r) => r.record === null || r.record.uuid?.startsWith('u10'))).toBe(true)
  })

  it('rows carry the trace identity for uuid-keyed consumers (pins, role-save)', () => {
    const rows = mergeCheckpointRows(chainLedger(), traceIndex)
    expect(rows.map((r) => r.id)).toEqual(['u101', 'u102', 'u103'])
  })

  it('uuid-less legacy records still pair by index under the ceiling', () => {
    const scrape: TurnRecord[] = [1, 2].map((index) => ({
      index,
      prompt: `p${index}`,
      reply: '',
      startedAt: index,
      endedAt: index
    }))
    const rows = mergeCheckpointRows(scrape, traceIndex)
    expect(rows[0].record?.prompt).toBe('p1')
    expect(rows[1].record?.prompt).toBe('p2')
  })

  it('trace entries without ids keep the historical index merge (old servers)', () => {
    const bare = traceIndex.map(({ index, title }) => ({ index, title }))
    const rows = mergeCheckpointRows(chainLedger(), bare)
    // No identity to join on: behaves as before — records ≤ ceiling pair by
    // index (mispairing included; the server upgrade is what fixes it).
    expect(rows).toHaveLength(3)
    expect(rows[1].record?.uuid).toBe('u002')
  })
})

describe('version pins anchor by checkpoint uuid', () => {
  const rows = [
    { index: 1, id: 'u101' },
    { index: 2, id: 'u102' },
    { index: 3, id: 'u103' }
  ]

  it('cutVersionPin stores the uuid it was cut at', () => {
    const pin = cutVersionPin([], { atIndex: 5, atUuid: 'u103', scrollLine: 0, cutAt: 1 })
    expect(pin.atUuid).toBe('u103')
  })

  it('a pin whose ledger index lies on another session anchors by uuid', () => {
    // Cut at ledger T5 == u103 == rail row T3. Index lookup would miss (no
    // row 5) or, worse, land on a row that is a different turn.
    const pin: VersionPinRecord = { version: 1, atIndex: 5, atUuid: 'u103', scrollLine: 0, cutAt: 1 }
    const anchors = pinAnchors([pin], rows)
    expect(anchors).toHaveLength(1)
    expect(anchors[0].frac).toBeCloseTo(2 / 3)
  })

  it('uuid wins over a colliding index', () => {
    // atIndex 2 exists among the rows but names a DIFFERENT turn than the
    // pin's uuid. The uuid is the identity; the index is a stale label.
    const pin: VersionPinRecord = { version: 1, atIndex: 2, atUuid: 'u103', scrollLine: 0, cutAt: 1 }
    expect(pinAnchors([pin], rows)[0].frac).toBeCloseTo(2 / 3)
  })

  it('a legacy pin with no uuid keeps its index anchoring', () => {
    const pin: VersionPinRecord = { version: 1, atIndex: 2, scrollLine: 0, cutAt: 1 }
    expect(pinAnchors([pin], rows)[0].frac).toBeCloseTo(1 / 3)
  })

  it('a uuid absent from the drawn rows is omitted, never guessed', () => {
    const pin: VersionPinRecord = { version: 1, atIndex: 1, atUuid: 'u001', scrollLine: 0, cutAt: 1 }
    expect(pinAnchors([pin], rows)).toHaveLength(0)
  })
})

describe('rekeyPinsByUuid — the re-key refuseRenumber has been demanding', () => {
  const ledger = chainLedger()

  it('backfills atUuid from the ledger record the pin was cut at', () => {
    const pins: VersionPinRecord[] = [
      { version: 1, atIndex: 2, scrollLine: 0, cutAt: 1 },
      { version: 2, atIndex: 5, scrollLine: 0, cutAt: 2 }
    ]
    const { pins: rekeyed, changed } = rekeyPinsByUuid(pins, ledger)
    expect(changed).toBe(2)
    expect(rekeyed.map((p) => p.atUuid)).toEqual(['u002', 'u103'])
    // Everything else is untouched — a re-key is not an edit.
    expect(rekeyed.map((p) => p.version)).toEqual([1, 2])
    expect(pins[0].atUuid).toBeUndefined() // input not mutated
  })

  it('is idempotent and honest about records it cannot resolve', () => {
    const pins: VersionPinRecord[] = [
      { version: 1, atIndex: 2, atUuid: 'u002', scrollLine: 0, cutAt: 1 }, // done
      { version: 2, atIndex: 99, scrollLine: 0, cutAt: 2 } // no such record
    ]
    const { pins: rekeyed, changed } = rekeyPinsByUuid(pins, ledger)
    expect(changed).toBe(0)
    expect(rekeyed[0]).toEqual(pins[0])
    expect(rekeyed[1].atUuid).toBeUndefined()
  })
})
