import { describe, expect, it } from 'vitest'
import { canRestoreExact, isRefOwned } from '../src/main/recover-gate'
import type { TerminalNodeData } from '../src/shared/model'

// The gate seam that decides didSpawn — it regressed twice in QA (fresh-boot
// on claude, stray/shared on codex). These assert: position-only fires IFF the
// exact prior session is genuinely unavailable, and it NEVER fresh-boots.

function node(over: Partial<TerminalNodeData>): TerminalNodeData {
  return {
    kind: 'terminal',
    id: 'n1',
    name: 'Agent',
    preset: 'claude',
    command: 'claude',
    cwd: '/work/repo',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 },
    ...over
  }
}

// No real files: inject every side-effect so the DECISION is what's tested.
const noTurns = { turnsHistory: () => [] }

describe('canRestoreExact — plain shell', () => {
  it('always restorable (nothing to resume)', () => {
    expect(canRestoreExact(node({ command: 'bash' }), noTurns)).toBe(true)
    expect(canRestoreExact(node({ command: 'zsh -l' }), noTurns)).toBe(true)
  })
})

describe('canRestoreExact — claude', () => {
  it('restorable when the resolver finds an existing id (never a fresh mint)', () => {
    const deps = { ...noTurns, claudeResolver: () => 'abc-123' }
    expect(canRestoreExact(node({ command: 'claude', claudeSessionId: 'abc-123' }), deps)).toBe(true)
  })
  it('position-only when the id is missing AND no turn-history match', () => {
    // resolver returns null == "cannot locate the exact session, would mint fresh"
    const deps = { ...noTurns, claudeResolver: () => null }
    expect(canRestoreExact(node({ command: 'claude', claudeSessionId: null }), deps)).toBe(false)
  })
  it('passes stored id + turns through to the resolver verbatim', () => {
    let seen: unknown
    const deps = {
      turnsHistory: () => [{ index: 1, prompt: 'hi', reply: 'yo', startedAt: 0, endedAt: 0 }],
      claudeResolver: (o: { storedId?: string | null; turns: unknown[] }) => {
        seen = o
        return o.storedId ?? null
      }
    }
    canRestoreExact(node({ command: 'claude', claudeSessionId: 'sid' }), deps)
    expect(seen).toMatchObject({ storedId: 'sid', cwd: '/work/repo', turns: [{ index: 1 }] })
  })
})

describe('canRestoreExact — codex', () => {
  it('restorable when bound to a rollout whose file exists', () => {
    const deps = { ...noTurns, fileExists: (p: string) => p === '/roll/a.jsonl' }
    expect(
      canRestoreExact(node({ command: 'codex', codexSessionRef: '/roll/a.jsonl' }), deps)
    ).toBe(true)
  })
  it('position-only when unbound (no ref captured at kill)', () => {
    const deps = { ...noTurns, fileExists: () => true }
    expect(canRestoreExact(node({ command: 'codex', codexSessionRef: null }), deps)).toBe(false)
    expect(canRestoreExact(node({ command: 'codex' }), deps)).toBe(false)
  })
  it('position-only when the bound rollout file is gone (deleted session)', () => {
    const deps = { ...noTurns, fileExists: () => false }
    expect(
      canRestoreExact(node({ command: 'codex', codexSessionRef: '/roll/gone.jsonl' }), deps)
    ).toBe(false)
  })
})

describe('canRestoreExact — opencode (S1)', () => {
  it('restorable when a shape-valid id has an existing session file', () => {
    const deps = { ...noTurns, opencodeExists: (id: string) => id === 'ses_live' }
    expect(
      canRestoreExact(node({ command: 'opencode', opencodeSessionId: 'ses_live' }), deps)
    ).toBe(true)
  })
  it('position-only when the id is shape-valid but the file was deleted (S1)', () => {
    const deps = { ...noTurns, opencodeExists: () => false }
    expect(
      canRestoreExact(node({ command: 'opencode', opencodeSessionId: 'ses_gone' }), deps)
    ).toBe(false)
  })
  it('position-only for a malformed id, even if existence would say true', () => {
    const deps = { ...noTurns, opencodeExists: () => true }
    expect(
      canRestoreExact(node({ command: 'opencode', opencodeSessionId: 'not-a-ses' }), deps)
    ).toBe(false)
    expect(canRestoreExact(node({ command: 'opencode' }), deps)).toBe(false)
  })
})

describe('isRefOwned — 1:1 claim guard', () => {
  const a = node({ id: 'a', codexSessionRef: '/roll/x.jsonl' })
  const b = node({ id: 'b', codexSessionRef: '/roll/y.jsonl' })
  it('true when a DIFFERENT node already holds the ref', () => {
    expect(isRefOwned([a, b], 'c', 'codexSessionRef', '/roll/x.jsonl')).toBe(true)
  })
  it('false when only self holds it (re-bind to own ref is fine)', () => {
    expect(isRefOwned([a, b], 'a', 'codexSessionRef', '/roll/x.jsonl')).toBe(false)
  })
  it('false when nobody holds it', () => {
    expect(isRefOwned([a, b], 'c', 'codexSessionRef', '/roll/free.jsonl')).toBe(false)
  })
})
