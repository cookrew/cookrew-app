// LINEAGE CHECKPOINT REACH — the fix for "an auto-compact loses the previous
// checkpoints".
//
// An auto-compact ROTATES the session: a new file starts, the rail (correctly,
// per checkpoint-session-alignment) numbers it from T1, and the earlier
// segments' checkpoints stop being reachable anywhere in the product. The data
// was never lost — the transcripts are intact and every rotation writes a
// declared predecessor edge (claude-rotation.ts) — it was only unreachable:
// restore-plan grew `cutoffSessionId` and the restore executor honors it, but
// nothing ever SUPPLIED a cross-segment checkpoint. This spec pins the supply
// side:
//
//   1. TraceReader.lineageSegments — the earlier segments of a node's session
//      chain, derived from the transcripts' own declared edges (never from a
//      guess), each in its OWN T1..Tn coordinate space.
//   2. checkpointRefs({includeLineage}) — the opt-in union the restore
//      executor asks for when a rewind targets an earlier segment. The
//      DEFAULT stays current-file-only (trace-reader.test.ts pins that).
//   3. planCheckpointRestore targetSessionId — index collisions across
//      segments resolve to the RIGHT segment, and never silently to the
//      oldest one that happens to share the number.
//   4. boundaryMarkers — a rotation-born file gets ONE boundary at its root
//      (the ◆ compact claude itself wrote, now carrying previousSessionId),
//      not a duplicate ⇥ clear beside it.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/main/store'
import { TraceReader } from '../src/main/trace'
import { planCheckpointRestore } from '../src/main/restore-plan'
import { claudeProjectSlug } from '../src/shared/claude-fork'
import type { TerminalNodeData } from '../src/shared/model'

const T0 = Date.parse('2026-08-30T10:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

// sessionChain reads DECLARED edges, and rotationEdgeOf refuses non-UUID ids —
// so fixture session ids must be uuid-shaped, exactly like the real files.
const SID_A = 'aaaaaaaa-1111-4111-8111-111111111111'
const SID_B = 'bbbbbbbb-2222-4222-8222-222222222222'
const SID_C = 'cccccccc-3333-4333-8333-333333333333'

const CWD = '/work/repo'

function terminal(patch: Partial<TerminalNodeData>): TerminalNodeData {
  return {
    kind: 'terminal',
    id: `t-${Math.floor(Math.random() * 1e9)}`,
    name: 'Agent',
    preset: 'Claude Code',
    command: 'claude',
    cwd: CWD,
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    ...patch
  }
}

const promptLine = (uuid: string, text: string, ms: number, sid: string): string =>
  JSON.stringify({
    type: 'user',
    uuid,
    sessionId: sid,
    timestamp: iso(ms),
    message: { role: 'user', content: text }
  })
const replyLine = (ms: number, sid: string): string =>
  JSON.stringify({
    type: 'assistant',
    sessionId: sid,
    timestamp: iso(ms),
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }
  })

/** A session file, optionally born from a rotation (head declares its predecessor). */
function writeSession(
  projectsDir: string,
  sid: string,
  prompts: string[],
  options: { rotatedFrom?: string } = {}
): void {
  const dir = path.join(projectsDir, claudeProjectSlug(CWD))
  mkdirSync(dir, { recursive: true })
  const lines: string[] = []
  if (options.rotatedFrom) {
    lines.push(
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: { trigger: 'auto', preTokens: 90000, postTokens: 4000 }
      }),
      JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        sessionId: sid,
        session_id: options.rotatedFrom,
        cwd: CWD,
        timestamp: iso(T0),
        message: { role: 'user', content: 'Summary of the earlier conversation.' }
      })
    )
  }
  prompts.forEach((p, i) => {
    lines.push(promptLine(`${sid.slice(0, 8)}-u${i + 1}`, p, T0 + i * 1000, sid))
    lines.push(replyLine(T0 + i * 1000 + 500, sid))
  })
  writeFileSync(path.join(dir, `${sid}.jsonl`), lines.join('\n') + '\n')
}

function reader(): { store: WorkspaceStore; projectsDir: string } {
  return {
    store: new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'lin-store-'))),
    projectsDir: mkdtempSync(path.join(tmpdir(), 'lin-proj-'))
  }
}

describe('TraceReader.lineageSegments — earlier segments, transcript-proven', () => {
  it('lists the predecessor of a rotation-born session, oldest first, current excluded', async () => {
    const { store, projectsDir } = reader()
    writeSession(projectsDir, SID_A, ['a1', 'a2', 'a3'])
    writeSession(projectsDir, SID_B, ['b1', 'b2'], { rotatedFrom: SID_A })
    const node = store.addNode(terminal({ claudeSessionId: SID_B })) as TerminalNodeData

    const segments = await new TraceReader(store, { projectsDir }).lineageSegments(node.id)
    expect(segments.map((s) => s.sessionId)).toEqual([SID_A])
    expect(segments[0].entries.map((e) => e.index)).toEqual([1, 2, 3])
    // Every entry carries its message uuid — restore cuts on identity, never position.
    expect(segments[0].entries.map((e) => e.id)).toEqual([
      'aaaaaaaa-u1',
      'aaaaaaaa-u2',
      'aaaaaaaa-u3'
    ])
  })

  it('walks a two-rotation chain: both earlier segments, oldest first', async () => {
    const { store, projectsDir } = reader()
    writeSession(projectsDir, SID_A, ['a1'])
    writeSession(projectsDir, SID_B, ['b1', 'b2'], { rotatedFrom: SID_A })
    writeSession(projectsDir, SID_C, ['c1'], { rotatedFrom: SID_B })
    const node = store.addNode(terminal({ claudeSessionId: SID_C })) as TerminalNodeData

    const segments = await new TraceReader(store, { projectsDir }).lineageSegments(node.id)
    expect(segments.map((s) => s.sessionId)).toEqual([SID_A, SID_B])
    // B is itself rotation-born, so its T1 is the replayed compact summary —
    // the same checkpoint the rail showed while B was live (semantics pinned:
    // lineage reach must never renumber a segment).
    expect(segments.map((s) => s.entries.length)).toEqual([1, 3])
  })

  it('a session with no declared predecessor has no earlier segments (never a guess)', async () => {
    const { store, projectsDir } = reader()
    writeSession(projectsDir, SID_A, ['a1', 'a2'])
    // A sibling file exists but nothing DECLARES it — it must not be adopted.
    writeSession(projectsDir, SID_B, ['b1'])
    const node = store.addNode(terminal({ claudeSessionId: SID_A })) as TerminalNodeData

    expect(await new TraceReader(store, { projectsDir }).lineageSegments(node.id)).toEqual([])
  })

  it('non-claude and unbound nodes have no lineage segments', async () => {
    const { store, projectsDir } = reader()
    const unbound = store.addNode(terminal({ claudeSessionId: null })) as TerminalNodeData
    const codex = store.addNode(
      terminal({ preset: 'Codex', command: 'codex', claudeSessionId: null })
    ) as TerminalNodeData
    const r = new TraceReader(store, { projectsDir })
    expect(await r.lineageSegments(unbound.id)).toEqual([])
    expect(await r.lineageSegments(codex.id)).toEqual([])
  })
})

describe('checkpointRefs — opt-in lineage union for the restore executor', () => {
  it('includeLineage unions earlier segments (tagged) before the current file', async () => {
    const { store, projectsDir } = reader()
    writeSession(projectsDir, SID_A, ['a1', 'a2', 'a3'])
    writeSession(projectsDir, SID_B, ['b1', 'b2'], { rotatedFrom: SID_A })
    const node = store.addNode(terminal({ claudeSessionId: SID_B })) as TerminalNodeData

    const r = new TraceReader(store, { projectsDir })
    const union = await r.checkpointRefs(node.id, { includeLineage: true })
    // B's own T1 is the replayed compact summary (a rotation-born file's
    // first prompt entry), then b1/b2 — the union never renumbers anything.
    expect(union.map((x) => [x.index, x.sessionId])).toEqual([
      [1, SID_A],
      [2, SID_A],
      [3, SID_A],
      [1, SID_B],
      [2, SID_B],
      [3, SID_B]
    ])
    // The default is UNCHANGED: current-file-only, indices never drift.
    const plain = await r.checkpointRefs(node.id)
    expect(plain.map((x) => x.index)).toEqual([1, 2, 3])
    expect(plain.every((x) => x.sessionId === SID_B)).toBe(true)
  })
})

describe('planCheckpointRestore — segment-aware index resolution', () => {
  const CLAUDE = 'claude --permission-mode bypassPermissions'
  const uA = (n: number): string => `aaaaaaa${n}-1111-4111-8111-11111111111${n}`
  const uB = (n: number): string => `bbbbbbb${n}-2222-4222-8222-22222222222${n}`
  const union = [
    { index: 1, id: uA(1), sessionId: SID_A },
    { index: 2, id: uA(2), sessionId: SID_A },
    { index: 3, id: uA(3), sessionId: SID_A },
    { index: 1, id: uB(1), sessionId: SID_B },
    { index: 2, id: uB(2), sessionId: SID_B }
  ]

  it('without a target, current-only refs resolve by index exactly as before', () => {
    // The executor only fetches the union when a target is named; a plain
    // rewind still supplies current-file refs, and nothing changes for it.
    const plan = planCheckpointRestore({
      command: CLAUDE,
      sessionId: SID_B,
      checkpointIndex: 2,
      blocks: union.filter((b) => b.sessionId === SID_B)
    })
    expect(plan.ok).toBe(true)
    expect(plan.cutoffUuid).toBe(uB(2))
  })

  it('with targetSessionId, the cut lands in the earlier segment and names its file', () => {
    const plan = planCheckpointRestore({
      command: CLAUDE,
      sessionId: SID_B,
      checkpointIndex: 3,
      blocks: union,
      targetSessionId: SID_A
    })
    expect(plan).toMatchObject({ ok: true, cutoffUuid: uA(3), cutoffSessionId: SID_A })
  })

  it('refuses an index the targeted segment does not have — even when another segment has it', () => {
    const plan = planCheckpointRestore({
      command: CLAUDE,
      sessionId: SID_B,
      checkpointIndex: 3, // exists in A, NOT in B
      blocks: union,
      targetSessionId: SID_B
    })
    expect(plan.ok).toBe(false)
  })

  it('refuses an unknown target segment', () => {
    const plan = planCheckpointRestore({
      command: CLAUDE,
      sessionId: SID_B,
      checkpointIndex: 1,
      blocks: union,
      targetSessionId: SID_C
    })
    expect(plan.ok).toBe(false)
  })

  it('legacy untagged blocks still resolve by index alone (back-compat)', () => {
    const plan = planCheckpointRestore({
      command: CLAUDE,
      sessionId: SID_B,
      checkpointIndex: 1,
      blocks: [{ index: 1, id: uB(1) }]
    })
    expect(plan.ok).toBe(true)
    expect(plan.cutoffUuid).toBe(uB(1))
  })
})

describe('boundaryMarkers — one boundary per rotation, carrying the lineage pointer', () => {
  it('a rotation-born file keeps its ◆ compact at the root (with previousSessionId), no duplicate ⇥ clear', async () => {
    const { store, projectsDir } = reader()
    writeSession(projectsDir, SID_A, ['a1', 'a2'])
    writeSession(projectsDir, SID_B, ['b1'], { rotatedFrom: SID_A })
    const node = store.addNode(
      terminal({ claudeSessionId: SID_B, sessionLineage: [SID_A] })
    ) as TerminalNodeData

    const markers = await new TraceReader(store, { projectsDir }).boundaryMarkers(node.id)
    const atRoot = markers.filter((m) => m.afterIndex === 0)
    expect(atRoot).toHaveLength(1)
    expect(atRoot[0].kind).toBe('compact')
    expect(atRoot[0].previousSessionId).toBe(SID_A)
  })

  it('a /clear-born file (no in-file boundary) still gets its ⇥ clear marker', async () => {
    const { store, projectsDir } = reader()
    writeSession(projectsDir, SID_A, ['a1'])
    writeSession(projectsDir, SID_B, ['b1'])
    const node = store.addNode(
      terminal({ claudeSessionId: SID_B, sessionLineage: [SID_A] })
    ) as TerminalNodeData

    const markers = await new TraceReader(store, { projectsDir }).boundaryMarkers(node.id)
    expect(markers).toEqual([{ kind: 'clear', afterIndex: 0, previousSessionId: SID_A }])
  })
})
