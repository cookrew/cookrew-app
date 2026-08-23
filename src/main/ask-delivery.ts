// Did the brief actually run? — the confirmation `cookrew ask` never did.
//
// askTerminal returns diffOutput(before, after): a SCREEN DIFF. When a paste
// lands in the TUI's input box and the submitting CR is swallowed mid-ingest,
// nothing new is painted, the diff is empty, and empty came back as success.
// The owner reproduced this on five agents in one session and worked around it
// by hand — following every ask with a raw carriage return, sometimes twice.
// That workaround is correct, and it belongs in the product.
//
// WHY THE CR IS SWALLOWED (the mechanism, so the fix is not cargo cult): a
// TUI ingests a large bracketed paste over time. ask.ts waits
// SUBMIT_DELAY_BASE + 100ms/KB before sending the CR, capped at 1500ms — so
// every brief past ~13.5KB gets the same 1.5s no matter its size, and a CR
// arriving mid-ingest is folded INTO the paste as a newline instead of
// submitting it. The cap makes the failure certain at real brief sizes. The
// answer is not a longer guess: it is to stop guessing and OBSERVE, then send
// the CR again — the CR only, never the text.
//
// RETRY THE SUBMIT, NEVER THE TEXT. Re-sending the brief into a box that
// already holds it pastes a second copy and submits both. That distinction is
// the whole reason `unsubmitted` and `dropped` are separate outcomes with
// opposite remedies (see shared/ask-outcome.ts).

import { ASK_EXIT, ASK_REMEDY, classifyDelivery, type AskOutcome } from '../shared/ask-outcome'
import { promptLanded } from './dispatch'
import { multiplexer, sessionNameFor } from './pty'

/** Long enough for a resubmitted turn to register with the tracker. */
const SUBMIT_SETTLE_MS = 1200

/** The tracker surface this module needs — narrowed so tests need no TurnTracker. */
export interface TurnCountSource {
  list: () => readonly { terminalId: string; turnCount: number }[]
}

/**
 * Build the observation seam every transport shares.
 *
 * `submit` writes the carriage return and takes no text, structurally: the
 * brief is already in the box, and a seam that COULD resend it would
 * eventually be asked to.
 */
export function terminalDeliveryDeps(
  turns: TurnCountSource,
  write: (data: string) => void
): DeliveryDeps {
  const turnCountOf = (terminalId: string): number | null =>
    turns.list().find((entry) => entry.terminalId === terminalId)?.turnCount ?? null
  return {
    turnCountOf,
    capture: (terminalId) => multiplexer()?.capture(sessionNameFor(terminalId)) ?? null,
    outputDepth: (terminalId) => {
      // A scrollState that THROWS on a dead session must not take the whole
      // ask with it: the wedge check is an ENRICHMENT of the verdict, and
      // trading a merely-wrong verdict for a hard failure is a bad trade.
      // Unknown depth is the fail-closed direction, and it is counted below.
      try {
        return multiplexer()?.scrollState(sessionNameFor(terminalId)).historySize ?? null
      } catch {
        return null
      }
    },
    submit: () => write('\r'),
    settle: () => new Promise((resolve) => setTimeout(resolve, SUBMIT_SETTLE_MS))
  }
}

/**
 * A delivery that did not start a turn, carrying the exit code the CLI must
 * leave with. An Error rather than a return value on purpose: every existing
 * caller of the ask verb already treats a throw as failure, so a delivery that
 * silently produced nothing now takes the SAME path as a refusal instead of
 * the success path it has been taking. The old behaviour has to become loud
 * without every call site opting in.
 */
export class DeliveryError extends Error {
  readonly outcome: AskOutcome
  readonly exitCode: number

  constructor(outcome: AskOutcome, agentName: string) {
    super(`${agentName}: ${outcome} — ${ASK_REMEDY[outcome]}`)
    this.name = 'DeliveryError'
    this.outcome = outcome
    this.exitCode = ASK_EXIT[outcome]
  }
}

/**
 * Read the depth without ever failing the ask.
 *
 * Guarded HERE as well as at the production seam, because the boundary that
 * matters is this one: the wedge check ENRICHES a verdict and must never
 * replace a merely-wrong answer with a hard failure. A scrollState that throws
 * on a dead session is a very ordinary thing for a backend to do.
 */
function readDepth(deps: DeliveryDeps, terminalId: string): number | null {
  try {
    return deps.outputDepth?.(terminalId) ?? null
  } catch {
    return null
  }
}

/** Bounded CR retries before we stop and report `unsubmitted` honestly. */
const MAX_SUBMIT_RETRIES = 2

/**
 * How many delivery verdicts were reached WITHOUT a usable depth reading, so
 * the wedge check could not run.
 *
 * The wedge branch degrades to silence by design — an unknown depth must not
 * become an accusation. But a feature that can only ever fail to fire is
 * indistinguishable from a world where no pane ever wedges, and this one was
 * bought with a day of field pain. `historySize` advancing on paint is proven
 * against fakes returning 100/141/null; the precedent for a plausible field
 * that does NOT advance is in this very lane (herdr's `revision`, frozen at 1
 * across four output bursts). So the degrade is COUNTED. A fleet reporting
 * thousands of blind deliveries and zero wedges is reporting that the check
 * is inert, not that the panes are healthy.
 *
 * Deliberately a counter and not a throw: the safe direction stays the
 * behaviour, and visibility is added beside it rather than in place of it.
 */
const deliveryBlindness = { blind: 0, seen: 0 }

/** Delivery verdicts split by whether the wedge check could run at all. */
export function deliveryWedgeCoverage(): { blind: number; seen: number } {
  return { ...deliveryBlindness }
}

/** Test seam; production never resets. */
export function resetDeliveryWedgeCoverage(): void {
  deliveryBlindness.blind = 0
  deliveryBlindness.seen = 0
}

/**
 * ONE CONTRACT, EVERY CALLER.
 *
 * The CLI and the phone both ask agents for work, and for one release the CLI
 * confirmed delivery while `POST /api/terminal/:id/ask` still returned the
 * bare reply — so whether a dropped brief was reported depended on WHICH
 * CLIENT you used. That is worse than neither confirming: the phone is exactly
 * where an owner is least able to tell a dropped brief from a slow one, and a
 * per-client truth is a truth nobody can rely on.
 *
 * So the ORDER lives here and nowhere else: count the turns BEFORE delivering,
 * deliver, then confirm against the tracker. Callers supply their transport's
 * delivery leg and their own view of the terminal; neither gets to skip the
 * confirmation, because the throw is on this side of the seam.
 */
export async function deliverAndConfirm(input: {
  terminalId: string
  agentName: string
  prompt: string
  /** The transport's delivery leg — askTerminal, bound by the caller. */
  deliver: () => Promise<string>
  observe: DeliveryDeps
}): Promise<{ outcome: AskOutcome; reply: string; submitRetries: number }> {
  // BEFORE delivery, so this brief's turn can never be confused with one that
  // was already running — identity over timing, the same reason the dispatch
  // route correlates on a dispatchId rather than on "the next completion".
  const turnsBefore = input.observe.turnCountOf(input.terminalId)
  const depthBefore = readDepth(input.observe, input.terminalId)
  const reply = await input.deliver()
  const report = await confirmDelivery(input.observe, {
    terminalId: input.terminalId,
    prompt: input.prompt,
    turnsBefore,
    depthBefore
  })
  if (report.outcome !== 'completed') throw new DeliveryError(report.outcome, input.agentName)
  return { outcome: report.outcome, reply, submitRetries: report.submitRetries }
}

/**
 * The reply text a caller should show. A turn that ran but painted nothing the
 * screen diff could see (a native submission whose reply landed outside the
 * mirror window) used to come back as `''` — the same empty string a dropped
 * brief produced. Saying which one it was costs a sentence.
 */
export function replyText(reply: string, submitRetries: number): string {
  if (reply.trim().length > 0) return reply
  const resubmits = submitRetries > 0 ? `, after ${submitRetries} resubmit(s)` : ''
  return `(delivered — the turn ran and produced no capturable reply${resubmits})`
}

export interface DeliveryDeps {
  /**
   * Completed turns recorded for this terminal, or NULL when the terminal is
   * not tracked at all — a detached pane, a dormant workspace's agent.
   *
   * Null is the load-bearing value and it means "we cannot see", never "no
   * turn ran". A detached agent may be working perfectly; reporting that as a
   * dropped brief would be our blindness described as their failure.
   */
  turnCountOf: (terminalId: string) => number | null
  /** Visible pane text, or null when it cannot be read. Null = cannot tell. */
  capture: (terminalId: string) => string | null
  /** Write the submitting carriage return. The CR, and only ever the CR. */
  submit: (terminalId: string) => void
  /** Wait long enough for a submitted turn to register before re-checking. */
  settle: () => Promise<void>
  /**
   * Scrollback depth — output written to this pane, ever. Rises with every
   * burst; null when it cannot be read.
   *
   * This is `max_offset_from_bottom`, MEASURED to rise with output
   * (0 → 18 → 59 → 100 → 141 across four bursts). herdr's `revision` looks
   * like the counter for this and is not: it versions pane metadata and stayed
   * at 1 across all four, so sampling revision twice and finding it frozen is
   * the normal state of every healthy pane.
   */
  outputDepth?: (terminalId: string) => number | null
}

export interface DeliveryReport {
  outcome: AskOutcome
  /** How many carriage returns the product had to send to get the turn going. */
  submitRetries: number
}

/**
 * Confirm — or refuse to claim — that a delivered brief started a turn.
 *
 * `turnsBefore` is the count captured BEFORE delivery, so a turn that was
 * already running cannot be mistaken for this brief's. A brief that arrives
 * while the agent is mid-turn is refused upstream as `busy`; this function is
 * only reached once the delivery attempt itself completed.
 */
export async function confirmDelivery(
  deps: DeliveryDeps,
  input: {
    terminalId: string
    prompt: string
    turnsBefore: number | null
    /** Scrollback depth captured BEFORE delivery, for the wedge check. */
    depthBefore?: number | null
  }
): Promise<DeliveryReport> {
  const { terminalId, prompt } = input

  const started = (): boolean => {
    const now = deps.turnCountOf(terminalId)
    return now !== null && input.turnsBefore !== null && now > input.turnsBefore
  }

  // Observability is asked FIRST and separately from the box, because a
  // capture that returns nothing for lack of a view is byte-for-byte
  // identical to a genuinely empty box. Only this fact separates them.
  const observable = deps.turnCountOf(terminalId) !== null && input.turnsBefore !== null
  if (started()) return { outcome: 'completed', submitRetries: 0 }
  if (!observable) return { outcome: 'unverifiable', submitRetries: 0 }

  // THE WEDGE CHECK. A pane that took our bytes and painted NOTHING is not
  // idle and is not a dropped brief — it has stopped reading input, and every
  // remedy that sends more bytes is wasted on it. Only asked when both depths
  // are readable: an unknown depth is not evidence of a frozen one.
  const depthNow = readDepth(deps, terminalId)
  const painted =
    input.depthBefore === undefined || input.depthBefore === null || depthNow === null
      ? undefined
      : depthNow > input.depthBefore
  if (painted === undefined) {
    deliveryBlindness.blind += 1
    if (deliveryBlindness.blind === 1 || deliveryBlindness.blind % 50 === 0) {
      console.warn(
        `Delivery wedge check is blind: no scrollback depth for ${terminalId} ` +
          `(${deliveryBlindness.blind} blind / ${deliveryBlindness.seen} seen). ` +
          'A backend whose historySize never advances makes `unresponsive` unreachable.'
      )
    }
  } else {
    deliveryBlindness.seen += 1
  }

  const pane = deps.capture(terminalId)
  const inBox = pane === null ? null : promptLanded(pane, prompt)
  if (inBox !== true || painted === false) {
    return {
      outcome: classifyDelivery({
        turnStarted: false,
        observable,
        promptInBox: inBox,
        ...(painted !== undefined ? { panePainted: painted } : {})
      }),
      submitRetries: 0
    }
  }

  // The brief IS in the box and no turn began: the swallowed CR. Send another
  // one — the workaround the owner was performing by hand, now evidence-based
  // and bounded rather than hopeful. Each attempt re-asks the tracker, so the
  // loop stops the moment the turn is real.
  for (let attempt = 1; attempt <= MAX_SUBMIT_RETRIES; attempt += 1) {
    deps.submit(terminalId)
    await deps.settle()
    if (started()) return { outcome: 'completed', submitRetries: attempt }
  }

  // Still sitting there. Report it as the thing it is: the text is delivered
  // and unsubmitted, and the caller's remedy is another CR — never the brief
  // again, which would double-paste.
  return { outcome: 'unsubmitted', submitRetries: MAX_SUBMIT_RETRIES }
}
