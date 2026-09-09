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
//   V4  EVERY MARK'S IDENTITY RESOLVES TO A STREAM ROW (one-stream T4) —
//       reported, never a failure, and "no stream index yet" is UNKNOWN
//       rather than "every mark is an orphan"
//   V5  A TRANSCRIPT IS ONLY GONE IF IT EXISTED (Scout, 2026-09-07) — an id
//       the app minted at spawn and replaced seconds later is `never written`,
//       and an id with any evidence of existence still FAILS

import { describe, expect, it } from 'vitest'
import { paneAgentOf, resolvePaneAgent } from '../src/shared/pane-agent.mjs'
import {
  MINT_GRACE_MS,
  liveVerdict,
  marksVerdict,
  reachVerdict,
  transcriptEvidence
} from '../src/shared/checkpoint-gate.mjs'

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

  it('FAILS when a transcript the card really used is gone from disk', () => {
    const verdict = reachVerdict({
      bound: BOUND,
      lineage: [BG, OTHER],
      spillIds: [],
      everBound: [OTHER.slice(0, 8)], // the app watched this card rotate off it
      hasTranscript: (id: string) => id !== OTHER,
      // …and the app's own index says it read blocks out of that file.
      factsFor: (id: string) => ({ inStreamIndex: id === OTHER })
    })
    expect(verdict.verdict).toBe('FAIL')
    expect(verdict.gone.map((absent) => absent.id)).toEqual([OTHER])
  })

  it('an id nothing ever wrote is reported, not failed (a card that never booted)', () => {
    // Cookrew mints the id when it binds the card, so a dormant terminal
    // carries an id with no transcript and no checkpoints to lose. Failing on
    // those is how the line that matters gets skipped.
    const verdict = reachVerdict({
      bound: BOUND,
      lineage: [],
      spillIds: [],
      everBound: [],
      hasTranscript: () => false
    })
    expect(verdict.verdict).toBe('OK')
    expect(verdict.unwritten.map((absent) => absent.id)).toEqual([BOUND])
    expect(verdict.gone).toEqual([])
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

/**
 * V4 — THE MARKS LINE (one-stream T4, 2026-09-07).
 *
 * The design added exactly one claim to this gate: "every mark's identity
 * resolves to a block in the stream. An orphan mark is reported, never
 * dropped." Three states, and the middle one is the whole reason this is a
 * pure function rather than a grep: a card the app has not materialised yet
 * has NO ANSWER, and calling all of its marks orphans would be an alarm about
 * the gate's own timing.
 */
describe('V4 — an orphan mark is reported, never dropped and never a failure', () => {
  const A = 'u-aaaaaaaa-1111'
  const B = 'u-bbbbbbbb-2222'

  it('says nothing when a card has no marks at all', () => {
    expect(marksVerdict({ identities: [], placed: new Set([A]) })).toMatchObject({
      verdict: 'OK',
      marks: 0,
      orphans: [],
      detail: ''
    })
  })

  it('OK when every mark sits on a row', () => {
    expect(marksVerdict({ identities: [A, B], placed: new Set([A, B, 'u-c']) })).toMatchObject({
      verdict: 'OK',
      marks: 2,
      orphans: []
    })
  })

  it('names the orphans, and says how many of how many', () => {
    const verdict = marksVerdict({ identities: [A, B], placed: new Set([A]) })
    expect(verdict.verdict).toBe('ORPHANS')
    expect(verdict.orphans).toEqual([B])
    expect(verdict.detail).toContain('1/2')
    expect(verdict.detail).toContain(B.slice(0, 8))
  })

  it('UNKNOWN — not "all orphans" — when the stream index has not been written', () => {
    // The difference that matters: a card the app has never opened. Reporting
    // its every title as unreachable is how a gate teaches people to ignore it.
    const verdict = marksVerdict({ identities: [A, B], placed: null })
    expect(verdict.verdict).toBe('UNKNOWN')
    expect(verdict.orphans).toEqual([])
    expect(verdict.detail).toContain('not materialised yet')
  })

  it('an EMPTY index is an answer, and its answer is that nothing is placed', () => {
    // Distinct from null: the app materialised this card and found no rows,
    // which is a real finding about a chain with no readable transcript.
    const verdict = marksVerdict({ identities: [A], placed: new Set() })
    expect(verdict.verdict).toBe('ORPHANS')
    expect(verdict.orphans).toEqual([A])
  })

  it('counts an identity once however many mark lines carried it', () => {
    expect(marksVerdict({ identities: [A, A, A], placed: new Set([A]) })).toMatchObject({
      verdict: 'OK',
      marks: 1
    })
  })

  it('accepts a plain array of placed identities as well as a Set', () => {
    expect(marksVerdict({ identities: [A], placed: [A] })).toMatchObject({ verdict: 'OK' })
  })
})

/**
 * V5 — A TRANSCRIPT IS ONLY GONE IF IT EXISTED (Scout, 2026-09-07).
 *
 * The gate printed `FAIL … Scout … TRANSCRIPT GONE: b0d36b55`. The durable
 * record has that id bound at 11:34:19.136Z; the event log has
 * `terminal.session-rotated b0d36b55 → b77a8949` at 11:34:35.444Z, sixteen
 * seconds later; and no file of that name exists anywhere under ~/.claude.
 * Cookrew MINTS a session id when it binds a fresh terminal, the process then
 * adopts the session it really writes, and the placeholder is replaced. There
 * were no checkpoints in those sixteen seconds to lose.
 *
 * The defect was in what the gate accepted as proof: a rotation event NAMING
 * an id says the id was once BOUND, not that it was ever WRITTEN. So the
 * failing verdict now needs positive evidence — a stream row read out of that
 * file, a later transcript naming it as the predecessor it compacted, a turn
 * record attributable to it, or a binding that outlived the mint grace — and
 * an id with none of those is `never written`, reported with its reason.
 *
 * The invariant this must not weaken is the one exit 1 exists for: an id with
 * ANY evidence of existence and no file on disk is still a FAIL.
 */
describe('V5 — TRANSCRIPT GONE requires evidence the transcript existed', () => {
  const MINTED = 'b0d36b55-a20a-4a97-9fe0-bca2740d25ac'
  const LIVE = 'b77a8949-5e90-43fe-911e-f4a1ccb6eb09'
  /** Scout's exact numbers, off the spill and the event log. */
  const MINTED_AT = Date.parse('2026-09-07T11:34:19.136Z')
  const ROTATED_AT = Date.parse('2026-09-07T11:34:35.444Z')
  const HELD_MS = ROTATED_AT - MINTED_AT

  /** Scout's card as the gate found it: the live file there, the mint absent. */
  const scout = (facts: Record<string, unknown> = {}): ReturnType<typeof reachVerdict> =>
    reachVerdict({
      bound: LIVE,
      lineage: [MINTED],
      spillIds: [LIVE, MINTED],
      everBound: [MINTED.slice(0, 8), LIVE.slice(0, 8)],
      hasTranscript: (id: string) => id === LIVE,
      factsFor: (id: string) => (id === MINTED ? { heldMs: HELD_MS, ...facts } : {})
    })

  it("Scout's sixteen-second placeholder is never written, not gone", () => {
    const verdict = scout()
    expect(verdict.verdict).toBe('OK')
    expect(verdict.gone).toEqual([])
    expect(verdict.unwritten.map((absent) => absent.id)).toEqual([MINTED])
  })

  it('and says why, in the words the owner can check against the log', () => {
    expect(scout().unwritten[0].reason).toBe(
      'minted at spawn, replaced 16 s later, nothing written'
    )
  })

  it('the rotation event alone is no longer proof the transcript existed', () => {
    // The old rule: `everBound` names it ⇒ gone. That is what cried wolf.
    expect(scout().unwritten[0].evidence).toBeNull()
  })

  it('a file the stream index really read, now absent, is GONE', () => {
    const verdict = scout({ inStreamIndex: true })
    expect(verdict.verdict).toBe('FAIL')
    expect(verdict.gone.map((absent) => absent.id)).toEqual([MINTED])
    expect(verdict.gone[0].evidence).toBe('stream-index')
    expect(verdict.gone[0].reason).toContain('stream index')
  })

  it('a predecessor a later transcript compacted, now absent, is GONE', () => {
    const verdict = scout({ namedByCompaction: true })
    expect(verdict.verdict).toBe('FAIL')
    expect(verdict.gone[0].evidence).toBe('compaction')
    expect(verdict.gone[0].reason).toContain('predecessor')
  })

  it('a turn record attributable to it, now absent, is GONE', () => {
    const verdict = scout({ inTurnStore: true })
    expect(verdict.verdict).toBe('FAIL')
    expect(verdict.gone[0].evidence).toBe('turn-store')
  })

  it('a binding that outlived the mint grace is itself the evidence', () => {
    const verdict = reachVerdict({
      bound: LIVE,
      lineage: [MINTED],
      spillIds: [],
      everBound: [MINTED.slice(0, 8)],
      hasTranscript: (id: string) => id === LIVE,
      factsFor: () => ({ heldMs: MINT_GRACE_MS })
    })
    expect(verdict.verdict).toBe('FAIL')
    expect(verdict.gone[0].evidence).toBe('held')
    expect(verdict.gone[0].reason).toContain('5 min')
  })

  it('one millisecond inside the grace is still a mint, one out is a session', () => {
    expect(transcriptEvidence({ heldMs: MINT_GRACE_MS - 1 }).existed).toBe(false)
    expect(transcriptEvidence({ heldMs: MINT_GRACE_MS }).existed).toBe(true)
  })

  it('an UNDATED binding is never written, and says the binding is undated', () => {
    // Forge, 2026-09-07: the spill learned 699e207e at the migration write, two
    // hours AFTER the log saw it rotate away, so the interval is not measurable
    // and the gate must say so rather than invent one.
    const verdict = transcriptEvidence({ witnessed: true, heldMs: null })
    expect(verdict.existed).toBe(false)
    expect(verdict.evidence).toBeNull()
    expect(verdict.reason).toContain('undated')
  })

  it('an id nothing ever named keeps its own reason (the dormant demo card)', () => {
    const verdict = transcriptEvidence({})
    expect(verdict.existed).toBe(false)
    expect(verdict.reason).toBe('nothing written, and nothing ever named it')
  })

  it('evidence outranks a short hold — a real session can rotate in seconds', () => {
    // A /compact of a session that had just resumed is seconds old and its
    // transcript is real. The hold is the LAST resort, never a veto.
    expect(transcriptEvidence({ heldMs: 1_000, inStreamIndex: true })).toMatchObject({
      existed: true,
      evidence: 'stream-index'
    })
  })

  it('a card with no facts at all still reports, never fails', () => {
    // The gate can gather no evidence for a card the app has never opened.
    // Silence is not proof of loss, and a gate that fails on silence is the
    // gate nobody reads.
    const verdict = reachVerdict({
      bound: LIVE,
      lineage: [MINTED],
      spillIds: [],
      everBound: [MINTED.slice(0, 8)],
      hasTranscript: (id: string) => id === LIVE
    })
    expect(verdict.verdict).toBe('OK')
    expect(verdict.unwritten.map((absent) => absent.id)).toEqual([MINTED])
  })
})
