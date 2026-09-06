// WHAT THE CHECKPOINT GATE ACTUALLY PROVES — two separate claims.
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
 * The reach half.
 *
 * `everBound` is the independent witness — 8-char prefixes recovered from the
 * event log's `terminal.session-rotated` details, which were written when the
 * app itself observed each hop. An id that log names and the chain no longer
 * contains is PROOF that the chain lost it; the log rotates, so its silence
 * proves nothing and is never treated as evidence.
 *
 * `gone` is the other way a checkpoint stops being reachable: the id is on the
 * chain but the transcript it names is not on disk, so nothing can open it.
 *
 * A chain id with no transcript that NOTHING witnesses is `unwritten`, not
 * `gone`, and does not fail the run. Cookrew mints a session id when it binds
 * a card, so a terminal that was created and never booted carries an id claude
 * never wrote a byte for — there were no checkpoints in it to lose. Measured
 * on the owner's machine the first time this ran: 7 of 10 failures were
 * dormant demo cards of exactly that shape, which is how a gate teaches the
 * person reading it to skip the line that matters.
 */
export function reachVerdict({ bound, lineage, spillIds, everBound, hasTranscript }) {
  const chain = unionLineage(spillIds, lineage, bound ? [bound] : [])
  const witnesses = everBound ?? []
  const missing = witnesses.filter((witness) => !chain.some((id) => id.startsWith(witness)))
  const absent = chain.filter((id) => !hasTranscript(id))
  const witnessed = (id) => witnesses.some((witness) => id.startsWith(witness))
  const gone = absent.filter(witnessed)
  const unwritten = absent.filter((id) => !witnessed(id))
  const verdict = missing.length === 0 && gone.length === 0 ? 'OK' : 'FAIL'
  return { verdict, chain, missing: dedupe(missing), gone, unwritten }
}

function dedupe(list) {
  return [...new Set(list)]
}

function short(id) {
  return typeof id === 'string' ? id.slice(0, 8) : String(id)
}
