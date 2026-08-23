// planRecovery — the tool this whole incident rests on.
//
// It rewrites an agent's checkpoint history across compacts. It had no tests,
// which is the wrong shape for the one piece of code that decides what the
// owner's rail says. These are those tests, and they lean hardest on the
// REFUSALS: a recovery that declines is recoverable, one that writes the wrong
// history is not.
//
// Every case runs against a transcript root this test owns. The real ~/.claude
// is never read.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeProjectDir } from '../src/main/claude-fork'
import { planRecovery } from '../src/main/lineage-recover'
import type { TurnRecord } from '../src/shared/turn'

const CWD = '/w/proj'
let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'recover-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const id = (n: number): string => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`
const msg = (n: number): string => `${String(n).padStart(8, 'c')}-2222-4222-8222-222222222222`

/** A transcript: `turns` user prompts, optionally continuing `predecessor`. */
function writeTranscript(own: string, turns: number, predecessor: string | null, from = 0): void {
  const dir = claudeProjectDir(CWD, root)
  mkdirSync(dir, { recursive: true })
  const lines: string[] = []
  if (predecessor !== null) {
    lines.push(
      JSON.stringify({
        parentUuid: null,
        logicalParentUuid: msg(999),
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: { trigger: 'auto', preTokens: 1, postTokens: 1 },
        sessionId: own,
        cwd: CWD
      }),
      JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        message: { role: 'user', content: 'continued…' },
        sessionId: own,
        session_id: predecessor,
        cwd: CWD
      })
    )
  }
  for (let i = 0; i < turns; i += 1) {
    lines.push(
      JSON.stringify({
        type: 'user',
        uuid: msg(from + i),
        sessionId: own,
        cwd: CWD,
        message: { role: 'user', content: `prompt ${from + i}` }
      })
    )
  }
  writeFileSync(path.join(dir, `${own}.jsonl`), `${lines.join('\n')}\n`)
}

const node = (over: Record<string, unknown> = {}): never =>
  ({
    id: 'term-1',
    kind: 'terminal',
    cwd: CWD,
    command: 'claude',
    claudeSessionId: id(2),
    ...over
  }) as never

const deps = (over: Record<string, unknown> = {}) =>
  ({
    pinCount: () => 0,
    existingRecords: (): TurnRecord[] => [],
    projectsDir: root,
    ...over
  }) as never

describe('planRecovery — what it produces', () => {
  it('numbers a two-transcript chain continuously, oldest first', async () => {
    writeTranscript(id(1), 3, null, 0)
    writeTranscript(id(2), 2, id(1), 10)
    const out = await planRecovery(node(), deps())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.recovery.chain).toEqual([id(1), id(2)])
    // 3 turns, then the successor's own summary turn PLUS its 2 turns. The
    // post-compact summary is itself a checkpoint — it was index 1 of
    // Commander's real ledger, which is what "the ledger restarted" looked like.
    expect(out.recovery.perFile).toEqual([3, 3])
    expect(out.recovery.records.map((r) => r.index)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('carries each transcript\'s own message uuids through the renumber', async () => {
    // The uuid is the identity the annotation re-key matches on, so a recovery
    // that renumbered without preserving them would silently orphan every one.
    writeTranscript(id(1), 2, null, 0)
    writeTranscript(id(2), 1, id(1), 10)
    const out = await planRecovery(node(), deps())
    if (!out.ok) throw new Error('expected a plan')
    // The conversation turns keep their transcript uuids, in order — that is
    // what the annotation re-key matches on.
    const carried = out.recovery.records.map((r) => r.uuid).filter((u) => u?.includes('-2222-'))
    expect(carried).toEqual([msg(0), msg(1), msg(10)])
  })

  it('HAZARD: a post-compact summary turn has an INDEX-DERIVED uuid', async () => {
    // Flagged before this lane began and now confirmed live, on the one record
    // type the whole recovery turns on. checkpointIdentity is
    //     id.uuid ?? `claude-${id.index}-${digest(id.prompt)}`
    // and a summary turn carries no transcript uuid, so it takes the fallback —
    // whose value CONTAINS THE INDEX. Renumber it and its "uuid" changes:
    // claude-1-… becomes claude-598-….
    //
    // Consequences, both silent: the annotation re-key cannot match a summary
    // turn across a renumber, and alignToLedger cannot recognise one as a head.
    // This test asserts the CURRENT behaviour so the fix has a witness; it must
    // be inverted when checkpointIdentity stops embedding the index.
    writeTranscript(id(1), 1, null, 0)
    writeTranscript(id(2), 1, id(1), 10)
    const out = await planRecovery(node(), deps())
    if (!out.ok) throw new Error('expected a plan')
    const summary = out.recovery.records.find((r) => r.prompt.startsWith('continued'))
    expect(summary?.uuid).toMatch(/^claude-\d+-/)
  })

  it('reports the existing ledger length, so the caller can see the delta', async () => {
    writeTranscript(id(2), 4, null, 0)
    const existing = [{ index: 1, uuid: msg(0), prompt: 'p', reply: 'r', startedAt: 0, endedAt: 1 }]
    const out = await planRecovery(node(), deps({ existingRecords: () => existing }))
    if (!out.ok) throw new Error('expected a plan')
    expect(out.recovery.existing).toBe(1)
    expect(out.recovery.records.length).toBe(4)
  })

  it('READS through the injected seam and writes nothing', async () => {
    // The whole reason planRecovery is separate from the write: a recovery you
    // can read before it runs is the difference between a repair and a hope.
    // Every transcript byte arrives through readFile, so a test can watch what
    // it touches — and there is no write path to watch at all.
    writeTranscript(id(2), 2, null, 0)
    const read: string[] = []
    const out = await planRecovery(
      node(),
      deps({
        readFile: (f: string) => {
          read.push(path.basename(f))
          return readFileSync(f, 'utf8')
        }
      })
    )
    expect(out.ok).toBe(true)
    expect(read).toEqual([`${id(2)}.jsonl`])
  })
})

describe('planRecovery — what it refuses', () => {
  it('REFUSES a node carrying version pins, before reading anything', async () => {
    // Pins are index-keyed; renumbering moves every one onto a different
    // checkpoint with no error. Declining is the only safe answer until they
    // are re-keyed by uuid.
    writeTranscript(id(2), 3, null, 0)
    const out = await planRecovery(node(), deps({ pinCount: () => 2 }))
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('refused')
    expect(out.detail).toContain('2 version pin')
  })

  it('refuses a terminal with no transcript parser', async () => {
    const out = await planRecovery(node({ command: '' }), deps())
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('no-harness')
  })

  it('refuses a node with no bound session rather than guessing one', async () => {
    const out = await planRecovery(node({ claudeSessionId: undefined }), deps())
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('no-chain')
  })

  it('refuses when the bound session has no transcript on disk', async () => {
    const out = await planRecovery(node(), deps())
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('no-chain')
  })

  it('STOPS at a missing predecessor instead of fabricating the gap', async () => {
    // A shorter true history beats a longer invented one, and a chain with a
    // hole in it is undetectable downstream.
    writeTranscript(id(2), 2, id(1), 10) // id(1) never written
    const out = await planRecovery(node(), deps())
    if (!out.ok) throw new Error('expected a plan')
    expect(out.recovery.chain).toEqual([id(2)])
    // Its own summary turn plus its 2 turns — and nothing invented for the
    // predecessor that is not on disk.
    expect(out.recovery.records.length).toBe(3)
  })
})

/**
 * rebuildLedgerInto is the "regenerate a lost ledger" repair tool. It reads
 * only the node's CURRENT transcript, and scheduleSave treats its argument as
 * the whole truth — so pointed at a lineage-spanning ledger it deletes rather
 * than merges. It has no production callers today, which is the only reason
 * the restored 613 survived it.
 */
describe('rebuildLedgerInto refuses to shrink a ledger', () => {
  it('DECLINES when the rebuild is shorter than what it would replace', async () => {
    const { rebuildLedgerInto } = await import('../src/main/ledger-rebuild')
    writeTranscript(id(2), 2, null, 0) // the current transcript: a few turns
    const stored = Array.from({ length: 613 }, (_, i) => ({
      index: i + 1,
      uuid: msg(i),
      prompt: 'p',
      reply: 'r',
      startedAt: i,
      endedAt: i + 1
    }))
    const saved: TurnRecord[][] = []
    const store = {
      load: () => stored,
      scheduleSave: (_id: string, records: TurnRecord[]) => saved.push(records),
      flushAll: () => undefined
    }
    const out = rebuildLedgerInto(store as never, node() as never, { projectsDir: root } as never)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.reason).toBe('would-shrink')
      expect(out.detail).toContain('613 stored records')
    }
    expect(saved).toEqual([]) // nothing written at all
  })

  it('still writes when the rebuild is not shorter', async () => {
    const { rebuildLedgerInto } = await import('../src/main/ledger-rebuild')
    writeTranscript(id(2), 4, null, 0)
    const saved: TurnRecord[][] = []
    const store = {
      load: (): TurnRecord[] => [],
      scheduleSave: (_id: string, records: TurnRecord[]) => saved.push(records),
      flushAll: () => undefined
    }
    const out = rebuildLedgerInto(store as never, node() as never, { projectsDir: root } as never)
    expect(out.ok).toBe(true)
    expect(saved[0]?.length).toBe(4)
  })
})
