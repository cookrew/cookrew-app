// THE GATE'S OWN VERDICTS — the half that used to cry wolf.
//
// 2026-09-06: scripts/checkpoint-live-gate.mjs joined terminal → pid by
// scanning `ps -axEo` for COOKREW_TERMINAL_ID and taking A matching pid. A
// BACKGROUND job inherits COOKREW_TERMINAL_ID from the session that spawned
// it and writes its OWN ~/.claude/sessions/<pid>.json, so the gate picked the
// job and reported MISMATCH on a card that was correctly bound (Conductor,
// bound 295d5f1c, gate claimed live a78aa3e5 — a background job of that very
// session). The app's oracle already refuses a `kind === 'bg'` holder; the two
// had drifted because each carried its own copy of the rule.
//
// So the rule now lives in ONE module (src/shared/pane-agent.mjs) that both
// import, and the gate's verdicts are pure functions pinned here:
//
//   V1  a background holder sharing the terminal id is never the pane agent
//   V2  what cannot be determined is UNKNOWN, never MISMATCH
//   V3  NO CHECKPOINT IS UNREACHABLE: every id ever bound to a card is in
//       (binding ∪ lineage ∪ spill), and names a transcript that is there

import { describe, expect, it } from 'vitest'
import { paneAgentOf, resolvePaneAgent } from '../src/shared/pane-agent.mjs'
import { liveVerdict, reachVerdict } from '../src/shared/checkpoint-gate.mjs'

const BOUND = '295d5f1c-1c62-4b3f-9b0e-2c9d0f1a4b77'
const BG = 'a78aa3e5-6f01-4a0e-9c33-0d8a1b2c3d4e'
const OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e8f7a6b5c4d'
const CWD = '/Users/drej/workspace/cookrew-dev'

/** The two processes that shared Conductor's terminal id on 2026-09-06. */
const holders = [
  { pid: 5001, sessionId: BG, kind: 'bg', cwd: CWD },
  { pid: 5002, sessionId: BOUND, kind: 'interactive', cwd: CWD }
]

describe('V1 — a background holder is never the pane agent', () => {
  it('resolves the pane agent to the interactive holder, not the job', () => {
    const resolved = resolvePaneAgent({ holders, cwd: CWD })
    expect(resolved.agent).toEqual({ pid: 5002, sessionId: BOUND })
  })

  it('so the gate says OK for the card that is correctly bound', () => {
    const resolved = resolvePaneAgent({ holders, cwd: CWD })
    expect(liveVerdict(BOUND, resolved).verdict).toBe('OK')
  })

  it('and refuses the bg pid even when the multiplexer names it', () => {
    expect(paneAgentOf(5001, holders, CWD)).toBeNull()
    expect(liveVerdict(BOUND, resolvePaneAgent({ panePid: 5001, holders, cwd: CWD })).verdict).toBe(
      'UNKNOWN'
    )
  })

  it('honours the multiplexer when it names a real pane holder', () => {
    const many = [...holders, { pid: 5003, sessionId: OTHER, kind: 'interactive', cwd: CWD }]
    expect(resolvePaneAgent({ panePid: 5003, holders: many, cwd: CWD }).agent).toEqual({
      pid: 5003,
      sessionId: OTHER
    })
  })
})

describe('V2 — what cannot be determined is UNKNOWN, never MISMATCH', () => {
  it('two pane candidates and no multiplexer answer', () => {
    const ambiguous = [
      { pid: 5002, sessionId: BOUND, kind: 'interactive', cwd: CWD },
      { pid: 5003, sessionId: OTHER, kind: 'interactive', cwd: CWD }
    ]
    const resolved = resolvePaneAgent({ holders: ambiguous, cwd: CWD })
    expect(resolved.agent).toBeNull()
    expect(liveVerdict(BOUND, resolved).verdict).toBe('UNKNOWN')
  })

  it('only a background holder: nothing can be said about the pane', () => {
    const resolved = resolvePaneAgent({ holders: [holders[0]], cwd: CWD })
    expect(resolved.agent).toBeNull()
    expect(liveVerdict(BOUND, resolved).verdict).toBe('UNKNOWN')
  })

  it('a holder whose cwd is another tree is not this pane (a reused pid)', () => {
    const elsewhere = [{ pid: 5002, sessionId: BOUND, kind: 'interactive', cwd: '/somewhere/else' }]
    expect(resolvePaneAgent({ holders: elsewhere, cwd: CWD }).agent).toBeNull()
  })

  it('a real disagreement is still a MISMATCH', () => {
    const moved = [{ pid: 5002, sessionId: OTHER, kind: 'interactive', cwd: CWD }]
    const resolved = resolvePaneAgent({ holders: moved, cwd: CWD })
    expect(liveVerdict(BOUND, resolved).verdict).toBe('MISMATCH')
  })
})

describe('V3 — no checkpoint is unreachable', () => {
  const present = new Set([BOUND, BG, OTHER])
  const hasTranscript = (id: string): boolean => present.has(id)

  it('passes when every id ever bound is in the chain and readable', () => {
    const verdict = reachVerdict({
      bound: BOUND,
      lineage: [BG],
      spillIds: [OTHER, BG, BOUND],
      everBound: [OTHER.slice(0, 8), BG.slice(0, 8), BOUND.slice(0, 8)],
      hasTranscript
    })
    expect(verdict).toMatchObject({ verdict: 'OK', missing: [], gone: [] })
    expect(verdict.chain).toEqual([OTHER, BG, BOUND])
  })

  it('FAILS when a previously bound id is missing from the chain (the dropped-cap bug)', () => {
    const verdict = reachVerdict({
      bound: BOUND,
      lineage: [BG], // OTHER was sliced off the front by the old cap
      spillIds: [],
      everBound: [OTHER.slice(0, 8), BG.slice(0, 8), BOUND.slice(0, 8)],
      hasTranscript
    })
    expect(verdict.verdict).toBe('FAIL')
    expect(verdict.missing).toEqual([OTHER.slice(0, 8)])
  })

  it('FAILS when a chain id names a transcript that is not there', () => {
    const verdict = reachVerdict({
      bound: BOUND,
      lineage: [BG, OTHER],
      spillIds: [],
      everBound: [],
      hasTranscript: (id: string) => id !== OTHER
    })
    expect(verdict.verdict).toBe('FAIL')
    expect(verdict.gone).toEqual([OTHER])
  })

  it('the spill alone is enough to keep a card reachable', () => {
    // The node's array was wiped (a preset scrub, a team carry, a bad write);
    // the durable record is what makes the checkpoints reachable anyway.
    const verdict = reachVerdict({
      bound: BOUND,
      lineage: [],
      spillIds: [OTHER, BG],
      everBound: [OTHER.slice(0, 8)],
      hasTranscript
    })
    expect(verdict.verdict).toBe('OK')
    expect(verdict.chain).toEqual([OTHER, BG, BOUND])
  })

  it('an unbound card with nothing recorded is not a failure', () => {
    expect(
      reachVerdict({ bound: null, lineage: [], spillIds: [], everBound: [], hasTranscript })
    ).toMatchObject({ verdict: 'OK', chain: [] })
  })
})
