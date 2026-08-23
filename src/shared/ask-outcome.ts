// What a delivery actually did — the fact `cookrew ask` must report instead of
// exit 0.
//
// THE DEFECT THIS EXISTS TO END: askTerminal returned `diffOutput(before,
// after)`, a screen diff. A brief that pasted but never submitted produces no
// new output, so the diff came back EMPTY — and empty returned as success. The
// command's success criterion was "I finished waiting", not "the agent did
// anything". Owner-reproduced on five agents in one session: pasted, sat as
// `[Pasted text #N +M lines]`, exit 0, empty output, indistinguishable from a
// brief that vanished before it reached the pane.
//
// A FACT ABOUT US IS NOT A FACT ABOUT THEM. This is the second time this shape
// has been met, so it is named here as a category rather than left for the
// third person to rediscover:
//
//   1. The payment facilitator being unreachable is OUR outage. Reporting it
//      as `invalid` told a buyer who had paid that their money was not money
//      (registry M2, the fourth reason).
//   2. A terminal we cannot observe is OUR blindness. Reporting it as
//      `dropped` tells an owner their brief was lost when it may be running
//      perfectly.
//
// Both describe the reporter's uncertainty in the language of the subject's
// failure. The rule that falls out: when we cannot see, we say so —
// `unverifiable` — and we never let "I could not confirm" be spendable as
// either success or accusation.
//
// DISTINCTNESS IS REQUIRED HERE because the caller's next action differs, and
// each remedy is DESTRUCTIVE applied to the other case:
//   - `unsubmitted` → send a carriage return. Re-sending the text would paste
//     a second copy beside the first and submit both.
//   - `dropped` → send the whole brief again. Sending a bare CR would submit
//     whatever was already sitting in that input box.
// Collapsing them into one "delivery failed" is how an orchestrator corrupts a
// prompt while believing it is retrying.

/** Every terminal state a delivery attempt can end in. */
export type AskOutcome =
  /** The turn started AND ended; a reply is available. */
  | 'completed'
  /** The turn started; the caller asked not to wait for it to finish. */
  | 'started'
  /** The text IS in the input box and no turn began. Send CR, not the text. */
  | 'unsubmitted'
  /** Nothing reached the pane. Send the whole brief again. */
  | 'dropped'
  /** The target is already mid-turn; this delivery was refused, not lost. */
  | 'busy'
  /** No pane, or a pane that cannot take work (context-full, retired). */
  | 'unreachable'
  /** Delivered, and we cannot see what became of it. May well be running. */
  | 'unverifiable'

/**
 * Process exit code per outcome. Distinct numbers because a shell caller's
 * next action differs per outcome exactly as a programmatic caller's does —
 * collapsing them to 1 would rebuild the ambiguity one layer down.
 *
 * `unverifiable` is NON-ZERO by ruling: "I could not confirm" must never be
 * spendable as success. It is the one non-zero code that does NOT mean
 * something is broken, which is why it has its own number rather than sharing
 * with `dropped`.
 */
export const ASK_EXIT: Readonly<Record<AskOutcome, number>> = {
  completed: 0,
  started: 0,
  unsubmitted: 3,
  dropped: 4,
  busy: 5,
  unreachable: 6,
  unverifiable: 7
}

/**
 * HTTP status per outcome, for the phone and any other API client.
 *
 * DELIBERATELY COARSER than the exit codes: HTTP has a small vocabulary and
 * `unsubmitted` and `dropped` share 502. That is safe only because the
 * response BODY carries `outcome` and `remedy` — the two remedies are
 * opposite, so a client that read the status alone and guessed would corrupt
 * the input box. A status is a category; the body is the fact.
 */
export const ASK_HTTP_STATUS: Readonly<Record<AskOutcome, number>> = {
  completed: 200,
  started: 202,
  // We failed to get the brief running. Which failure it was is in the body.
  unsubmitted: 502,
  dropped: 502,
  // The agent is fine and busy — a conflict, not a failure.
  busy: 409,
  unreachable: 503,
  // We delivered and cannot confirm. Not 200: "I could not confirm" must
  // never be spendable as success, on any transport.
  unverifiable: 504
}

/** True when the outcome means the agent is now working on the brief. */
export function isDelivered(outcome: AskOutcome): boolean {
  return outcome === 'completed' || outcome === 'started'
}

/**
 * What the caller should DO next. Shipped with the outcome so an orchestrator
 * does not have to hold this table in its head — the remedies are opposite
 * and one of them corrupts the input box when misapplied.
 */
export const ASK_REMEDY: Readonly<Record<AskOutcome, string>> = {
  completed: 'nothing — the reply is the result',
  started: 'await the dispatch id for the reply',
  unsubmitted:
    'send a carriage return to submit it — do NOT resend the text, it is already in the box',
  dropped: 'send the whole brief again — nothing reached the pane',
  busy: 'wait for the current turn to finish, or preempt it deliberately',
  unreachable: 'recover or compact the agent before dispatching again',
  unverifiable:
    'check the pane — the brief may be running; do NOT resend blind, it may double-submit'
}

/**
 * Evidence gathered about one delivery attempt. Every field is something
 * OBSERVED, never assumed: `turnStarted` comes from the turn tracker leaving
 * idle, and `promptInBox` from the producer lease's durable residue fact or a
 * transcript echo.
 */
export interface DeliveryEvidence {
  /** The tracker observed this terminal begin a turn. */
  turnStarted: boolean
  /**
   * Can we observe this terminal AT ALL? False for a detached pane, an
   * untracked terminal, or a dormant workspace's agent — none of which is
   * evidence that anything failed.
   */
  observable: boolean
  /**
   * Is the delivered text sitting in the input box unconsumed? True/false when
   * known, NULL when the question itself could not be answered — which is not
   * the same as "no".
   */
  promptInBox: boolean | null
  /** The pane refused the work outright, with which named reason. */
  refused?: 'busy' | 'unreachable'
}

/**
 * Classify one delivery attempt from evidence alone.
 *
 * ORDER MATTERS and is the whole safety property:
 *   1. A refusal is a fact the pane gave us — nothing was delivered, nothing
 *      is in the box, and no observation is needed to know it.
 *   2. A started turn ends the question: the brief is running.
 *   3. UNOBSERVABLE comes BEFORE any conclusion about the box. This is the
 *      rule the category note above exists for — a terminal we cannot watch
 *      must never be reported as `dropped`, because "I saw nothing" and
 *      "nothing happened" are different sentences and only one of them is
 *      about the agent.
 *   4. Only with a live view does the box's contents decide between the two
 *      opposite remedies.
 */
export function classifyDelivery(evidence: DeliveryEvidence): AskOutcome {
  if (evidence.refused !== undefined) return evidence.refused
  if (evidence.turnStarted) return 'completed'
  if (!evidence.observable) return 'unverifiable'
  if (evidence.promptInBox === null) return 'unverifiable'
  return evidence.promptInBox ? 'unsubmitted' : 'dropped'
}
