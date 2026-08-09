import { describe, expect, it } from 'vitest'
import { planCheckpointRestore, pushRestorePoint, RESTORE_UNDO_CAP } from '../src/main/restore-plan'

// ENDPOINT RESTORE (rewind a teammate in place to any checkpoint).
//
// Cookrew reads the session FILE, so it sees EVERY checkpoint — including ones
// Claude Code's own /rewind drops after a compact. This planner turns "restore
// to checkpoint N" into an exact cutoff uuid, or an honest refusal.

const CLAUDE = 'claude --permission-mode bypassPermissions'
const U1 = '1e54c8a8-4e59-49e7-979c-8b9dccb361c3'
const U2 = '2ab34c8a-1111-4e49-879c-8b9dccb36abc'
const blocks = [
  { index: 1, id: U1 },
  { index: 2, id: U2 }
]

describe('planCheckpointRestore — claude', () => {
  it('resolves a checkpoint to its exact cutoff uuid', () => {
    const plan = planCheckpointRestore({
      command: CLAUDE,
      sessionId: 'sess-1',
      checkpointIndex: 2,
      blocks
    })
    expect(plan).toMatchObject({ ok: true, cutoffUuid: U2, harness: 'claude' })
  })
  it('restores an OLD checkpoint the same way (pre-compact endpoints included)', () => {
    const plan = planCheckpointRestore({ command: CLAUDE, sessionId: 's', checkpointIndex: 1, blocks })
    expect(plan).toMatchObject({ ok: true, cutoffUuid: U1 })
  })
  it('refuses when the terminal has no bound session file', () => {
    const plan = planCheckpointRestore({ command: CLAUDE, sessionId: null, checkpointIndex: 1, blocks })
    expect(plan.ok).toBe(false)
    expect(plan.reason).toMatch(/session/i)
  })
  it('refuses an unknown checkpoint index', () => {
    const plan = planCheckpointRestore({ command: CLAUDE, sessionId: 's', checkpointIndex: 99, blocks })
    expect(plan.ok).toBe(false)
    expect(plan.reason).toMatch(/checkpoint/i)
  })
  it('refuses a block whose id is not a real message uuid (never cut on a guess)', () => {
    const plan = planCheckpointRestore({
      command: CLAUDE,
      sessionId: 's',
      checkpointIndex: 1,
      blocks: [{ index: 1, id: 'p1' }] // codex-style ordinal
    })
    expect(plan.ok).toBe(false)
  })
})

describe('planCheckpointRestore — other harnesses / shells', () => {
  it('refuses codex (rollout truncation not supported yet) — honestly, not silently', () => {
    const plan = planCheckpointRestore({
      command: 'codex',
      sessionId: 's',
      checkpointIndex: 1,
      blocks: [{ index: 1, id: 'p1' }]
    })
    expect(plan.ok).toBe(false)
    expect(plan.reason).toMatch(/codex/i)
  })
  it('refuses a plain shell (nothing to restore)', () => {
    const plan = planCheckpointRestore({ command: 'bash', sessionId: null, checkpointIndex: 1, blocks })
    expect(plan.ok).toBe(false)
  })
})

describe('pushRestorePoint — undo stack', () => {
  it('records the pre-restore session so a rewind is reversible', () => {
    const s = pushRestorePoint([], { sessionId: 'old', at: 10, rewoundToIndex: 5 })
    expect(s).toEqual([{ sessionId: 'old', at: 10, rewoundToIndex: 5 }])
  })
  it('is immutable and newest-first', () => {
    const s0 = [{ sessionId: 'a', at: 1, rewoundToIndex: 1 }]
    const s1 = pushRestorePoint(s0, { sessionId: 'b', at: 2, rewoundToIndex: 2 })
    expect(s1.map((r) => r.sessionId)).toEqual(['b', 'a'])
    expect(s0).toHaveLength(1)
  })
  it('caps the stack so restores never grow unbounded', () => {
    let s: ReturnType<typeof pushRestorePoint> = []
    for (let i = 0; i < RESTORE_UNDO_CAP + 5; i += 1) {
      s = pushRestorePoint(s, { sessionId: `s${i}`, at: i, rewoundToIndex: i })
    }
    expect(s).toHaveLength(RESTORE_UNDO_CAP)
    expect(s[0].sessionId).toBe(`s${RESTORE_UNDO_CAP + 4}`) // newest kept
  })
})
