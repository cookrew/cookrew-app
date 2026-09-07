// WHAT THE CHECKPOINT GATE ACTUALLY PROVES — three separate claims.
//
// LIVE (the old one, narrowed). For a card whose pane agent can be
// IDENTIFIED, the session the card is bound to is the session that process
// says it writes. Everything else is UNKNOWN. On 2026-09-06 the gate printed
// MISMATCH for Conductor because it had picked a background job that inherited
// COOKREW_TERMINAL_ID — a false alarm on a correctly bound card. A gate that
// cries wolf is how a real mismatch gets ignored, so an undecidable pane now
// prints UNKNOWN and does not fail the run.
//
// REACH (the new one, and the owner's real requirement). NO CHECKPOINT IS
// UNREACHABLE: every session id that has ever been bound to a card is still in
// (binding ∪ lineage ∪ spill), and every transcript those ids name is on disk.
// This is the claim the capped lineage broke — `slice(len - 20)` dropped the
// oldest id with no error anywhere — and the one the live check never made.
// Narrowed on 2026-09-07 (Scout): an id whose transcript is absent only FAILS
// when something says that transcript was ever written. See MINT_GRACE_MS and
// transcriptEvidence — the app mints a session id at spawn, and a placeholder
// replaced sixteen seconds later is not sixteen seconds of lost history.
//
// FLAP (2026-09-06, reported only). A card is not ALTERNATING between two
// sessions. See flapVerdict below for why a repeated rotation destination is
// always wrong, and why it must never fail the run.
//
// MARKS (one-stream T4, 2026-09-07, reported only). Every mark's identity
// resolves to a row in the card's stream — the design's own added line:
// "An orphan mark is reported, never dropped." A mark is a Sous title, a
// seen-at, a pin, a rail anchor or a fork reference, and an orphan one is a
// title with nowhere to sit, never a lost checkpoint. It must not fail the
// run for the same reason FLAP must not.
//
// Pure verdicts over facts the caller gathered, so both halves are testable
// without a machine in a particular state (tests/checkpoint-gate-verdict).

import { unionLineage } from './lineage-spill-format.mjs'

/**
 * The live half. `resolution` comes from resolvePaneAgent — its `agent` is
 * null exactly when the pane's process could not be identified, and that is
 * reported, never guessed at.
 */
export function liveVerdict(bound, resolution) {
  if (!resolution || resolution.agent === null) {
    return { verdict: 'UNKNOWN', detail: resolution?.reason ?? 'no pane agent' }
  }
  const live = resolution.agent.sessionId
  if (!bound) {
    return { verdict: 'MISMATCH', detail: `card is unbound while its pane writes ${short(live)}` }
  }
  if (bound === live) return { verdict: 'OK', detail: '' }
  return {
    verdict: 'MISMATCH',
    detail: `bound ${short(bound)}, pane process writes ${short(live)}`
  }
}

/**
 * HOW LONG A BINDING MUST HAVE LASTED before its absence is a loss.
 *
 * SCOUT, 2026-09-07. The gate printed `TRANSCRIPT GONE: b0d36b55` for a card
 * whose durable record has that id bound at 11:34:19.136Z and whose event log
 * has `terminal.session-rotated b0d36b55 → b77a8949` at 11:34:35.444Z —
 * sixteen seconds — with no file of that name anywhere under ~/.claude.
 * Cookrew MINTS a session id when it binds a fresh terminal, the process then
 * adopts the session it really writes (claude-session-adoption.ts), and the
 * placeholder is replaced. Nothing was ever written under it and there were no
 * checkpoints in those sixteen seconds to lose.
 *
 * Five minutes is measured against the mechanisms that can replace a minted
 * id: the spawn boot ladder runs out at 20 s (ORACLE_BOOT_DELAYS_MS), the
 * oracle sweep is 30 s (ORACLE_SWEEP_MS) and the rebind damper refuses a
 * return for 60 s (REBIND_BACKOFF_MS). Five minutes is five damper windows —
 * every mechanism has had its say several times over, so an id replaced later
 * than this was a session somebody was actually using.
 *
 * The interval is only ever a CLOSED one: from the binding to the rotation
 * that replaced it. A card that sits bound for days without ever booting is
 * not evidence of anything, and reading its age as a hold would fail every
 * dormant card on the canvas.
 */
export const MINT_GRACE_MS = 5 * 60 * 1000

/**
 * DID THIS SESSION'S TRANSCRIPT EVER EXIST — the whole rule, over facts the
 * caller gathered about ONE id.
 *
 * The defect this answers is what the gate used to accept as proof: a
 * `terminal.session-rotated` event NAMING an id says the id was once BOUND,
 * never that it was ever WRITTEN. So a failing verdict needs positive
 * evidence, in the order it is trustworthy:
 *
 *   inStreamIndex     the persisted index lists blocks the app read OUT of
 *                     that file — the app's own record that it was there
 *   namedByCompaction a LATER transcript declares it as the predecessor it
 *                     compacted; claude wrote that join, nobody derived it
 *   inTurnStore       the old turn store holds records attributable to it
 *   heldMs            it was bound longer than the mint grace, so whatever
 *                     was written in that time is what is now missing
 *
 * `witnessed` — the event log saw a rotation naming it — is deliberately NOT
 * on that list. It is the fact that cried wolf, and it survives only to
 * sharpen the reason line.
 *
 * Absence of evidence is reported as `never written`, never as loss: this
 * gate runs against a machine where the app may have opened nothing, and a
 * gate that fails on silence is the gate nobody reads.
 */
export function transcriptEvidence(facts = {}, graceMs = MINT_GRACE_MS) {
  const { inStreamIndex, namedByCompaction, inTurnStore, witnessed } = facts
  const heldMs = typeof facts.heldMs === 'number' && facts.heldMs >= 0 ? facts.heldMs : null
  if (inStreamIndex) {
    return found('stream-index', 'the stream index lists blocks read out of it')
  }
  if (namedByCompaction) {
    return found('compaction', 'a later transcript names it as the predecessor it compacted')
  }
  if (inTurnStore) {
    return found('turn-store', 'the turn store holds records written under it')
  }
  if (heldMs !== null && heldMs >= graceMs) {
    return found('held', `bound for ${humanDuration(heldMs)}, past the ${humanDuration(graceMs)} mint grace`)
  }
  return { existed: false, evidence: null, reason: mintReason(heldMs, witnessed === true) }
}

function found(evidence, reason) {
  return { existed: true, evidence, reason }
}

/** Why an id with no evidence is being reported rather than failed. */
function mintReason(heldMs, witnessed) {
  if (heldMs !== null) {
    return `minted at spawn, replaced ${humanDuration(heldMs)} later, nothing written`
  }
  if (witnessed) return 'bound and replaced with nothing written, the binding undated'
  return 'nothing written, and nothing ever named it'
}

/** Coarse and readable — this is a sentence in a report, not a measurement. */
function humanDuration(ms) {
  if (ms < 90_000) return `${Math.round(ms / 1000)} s`
  if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)} min`
  return `${Math.round(ms / 3_600_000)} h`
}

/**
 * The reach half.
 *
 * `everBound` is the independent witness — 8-char prefixes recovered from the
 * event log's `terminal.session-rotated` details, which were written when the
 * app itself observed each hop. An id that log names and the chain no longer
 * contains is PROOF that the chain lost it; the log rotates, so its silence
 * proves nothing and is never treated as evidence.
 *
 * `gone` is the other way a checkpoint stops being reachable: the id is on the
 * chain, the transcript it names is not on disk, and something says that
 * transcript was really there — see transcriptEvidence for what may say so.
 *
 * A chain id with no transcript and no such evidence is `unwritten`, not
 * `gone`, and does not fail the run: Cookrew mints a session id when it binds
 * a card, so a terminal that was created and never booted — or one whose mint
 * was replaced at spawn (Scout, 2026-09-07) — carries an id claude never wrote
 * a byte for. Measured on the owner's machine the first time this ran: 7 of 10
 * failures were dormant cards of exactly that shape, which is how a gate
 * teaches the person reading it to skip the line that matters.
 *
 * `factsFor(id)` supplies what the caller could gather about an absent id;
 * gathering nothing is allowed and means nothing is claimed.
 */
export function reachVerdict({ bound, lineage, spillIds, everBound, hasTranscript, factsFor }) {
  const chain = unionLineage(spillIds, lineage, bound ? [bound] : [])
  const witnesses = everBound ?? []
  const missing = witnesses.filter((witness) => !chain.some((id) => id.startsWith(witness)))
  const witnessed = (id) => witnesses.some((witness) => id.startsWith(witness))
  const judged = chain
    .filter((id) => !hasTranscript(id))
    .map((id) => {
      const facts = { ...(factsFor?.(id) ?? {}), witnessed: witnessed(id) }
      const { existed, evidence, reason } = transcriptEvidence(facts)
      return { id, existed, evidence, reason }
    })
  const gone = judged.filter((absent) => absent.existed).map(withoutFlag)
  const unwritten = judged.filter((absent) => !absent.existed).map(withoutFlag)
  const verdict = missing.length === 0 && gone.length === 0 ? 'OK' : 'FAIL'
  return { verdict, chain, missing: dedupe(missing), gone, unwritten }
}

/** The row as it is reported: which list it is in already says `existed`. */
function withoutFlag({ id, evidence, reason }) {
  return { id, evidence, reason }
}

/** How many of a card's most recent rotations the flap check looks at. */
export const FLAP_WINDOW = 8

/**
 * The third line, reported and never failing: is this card ALTERNATING?
 *
 * A conversation only ever moves forward — a compaction, a /clear, a resume
 * and a held-session fork each mint a session id the card has never been bound
 * to — so a rotation DESTINATION that repeats is not a rotation at all, it is
 * two mechanisms disagreeing about which session the card owns. That is what
 * Conductor's log showed on 2026-09-06: 295d5f1c and a78aa3e5 as destinations
 * over and over, because spawn kept adopting a background job's transcript and
 * the oracle sweep kept putting the binding back (claude-session-adoption.ts).
 *
 * `rotations` is the ordered list of destinations from the card's
 * `terminal.session-rotated` events, oldest first, as 8-char prefixes. Only
 * the last FLAP_WINDOW count: an alternation the owner already fixed is
 * history, and a gate that keeps shouting about it teaches the reader to skip
 * the line. Never failing — a flap is a wrong rail and a noisy history, not an
 * unreachable checkpoint, and the two claims above are what exit 1 is for.
 */
export function flapVerdict({ rotations, window = FLAP_WINDOW }) {
  const recent = (rotations ?? []).slice(-window)
  const seen = new Set()
  const repeated = []
  for (const to of recent) {
    if (seen.has(to)) repeated.push(to)
    seen.add(to)
  }
  return {
    verdict: repeated.length > 0 ? 'FLAP' : 'OK',
    ids: dedupe(repeated),
    rotations: recent.length
  }
}

/**
 * The marks half. `placed` is the set of identities the stream materialised
 * for this card, or NULL when it has materialised none — and those are
 * different facts. A card the app has never opened has no answer to give, and
 * calling all of its marks orphans would be an alarm about the gate's own
 * timing rather than about the data.
 *
 * Pure, so the three states — nothing to check, undecidable, orphans — can be
 * asserted without a ~/.cookrew in a particular state.
 */
export function marksVerdict({ identities, placed }) {
  const held = dedupe(identities ?? [])
  if (held.length === 0) return { verdict: 'OK', marks: 0, orphans: [], detail: '' }
  if (placed === null || placed === undefined) {
    return {
      verdict: 'UNKNOWN',
      marks: held.length,
      orphans: [],
      detail: `${held.length} mark(s), stream index not materialised yet — undecidable`
    }
  }
  const reachable = placed instanceof Set ? placed : new Set(placed)
  const orphans = held.filter((identity) => !reachable.has(identity))
  if (orphans.length === 0) return { verdict: 'OK', marks: held.length, orphans: [], detail: '' }
  return {
    verdict: 'ORPHANS',
    marks: held.length,
    orphans,
    detail:
      `ORPHAN MARKS: ${orphans.length}/${held.length} resolve to no stream row ` +
      `(${orphans.slice(0, 4).map(short).join(' ')}${orphans.length > 4 ? ' …' : ''})`
  }
}

function dedupe(list) {
  return [...new Set(list)]
}

function short(id) {
  return typeof id === 'string' ? id.slice(0, 8) : String(id)
}
