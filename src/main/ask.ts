import { multiplexer, type PtySession } from './pty'
import {
  defaultProducerLease,
  ownerHolder,
  type ProducerHolder,
  type ProducerLease
} from './producer-lease'

export interface AskOptions {
  /** ms of continuous silence that counts as "the agent finished". */
  quiescenceMs?: number
  /** Give up waiting after this long. */
  timeoutMs?: number
  /** Minimum time to wait before quiescence can trigger (agent boot time). */
  graceMs?: number
  /**
   * The per-terminal producer lease (Sol r6 P0-1). Injectable for tests;
   * production always uses the process-wide default, because the lease only
   * reserves anything when every producer consults the SAME instance.
   */
  lease?: ProducerLease
}

const SUBMIT_DELAY_BASE_MS = 150
const SUBMIT_DELAY_PER_KB_MS = 100
const SUBMIT_DELAY_MAX_MS = 1500

/** Bracketed-paste markers (DECSET 2004): a paste's explicit start/end. */
const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

/**
 * Pause between the prompt text and the submitting Enter. Agent TUIs treat a
 * burst of input as a paste; a carriage return inside that burst becomes a
 * literal newline in their input box instead of a submit. The pause scales
 * with prompt size because the TUI ingests large pastes over time — an Enter
 * arriving before ingestion finishes gets swallowed into the paste.
 */
export function submitDelayMs(promptLength: number): number {
  const scaled = SUBMIT_DELAY_BASE_MS + Math.round((promptLength / 1024) * SUBMIT_DELAY_PER_KB_MS)
  return Math.min(scaled, SUBMIT_DELAY_MAX_MS)
}

/**
 * Deliver `body` as one bracketed-paste unit, then submit it with a delayed
 * Enter. The explicit \x1b[200~…\x1b[201~ markers make the TUI finalize the
 * paste at a known boundary, so the trailing Enter is seen as a submit rather
 * than folded into a still-ingesting paste — the "[Pasted text] never sent"
 * bug that a bare raw write hits when the TUI's own paste heuristic collapses
 * the burst. Same mechanism the fork engine uses (injectWhenReady).
 *
 * CANCELLATION-AWARE (Sol r6 P0-2): the paste and the CR are separated by up
 * to 1.5 seconds, and a dispatch cancelled (or a lease lost) inside that
 * window must not be submitted by the later Enter. `stillValid` is consulted
 * BEFORE EACH write; a false verdict stops the sequence and reports
 * 'cancelled'. Callers thread their own liveness in — the dispatch fallback
 * passes its deliveryLive + lease check, the typed ask its own lease hold.
 *
 * THE RESIDUE, honestly: a cancellation after the paste but before the CR
 * leaves the pasted prompt sitting UNSUBMITTED in the TUI's input box. That
 * text is inert — nothing runs it, and the next real submission at that
 * terminal is the one that would carry it. It is deliberately NOT cleared
 * here: at the live tail an ESC is an agent interrupt in every harness TUI we
 * host (herdr forwards it — see PtySession.wheelExitScrollback), and
 * Ctrl-C/Ctrl-U semantics differ per harness (Claude Code's Ctrl-C doubles as
 * quit), so a "cheap" clear sequence risks interrupting the very owner turn
 * the cancellation yielded to. The residue is visible in the input box and
 * the owner clears or reuses it; the cancelled dispatch's record already
 * carries the honest outcome.
 */
export async function pasteAndSubmit(
  session: PtySession,
  body: string,
  // The dispatch reattach-fallback writes through the SOURCE-TAGGED path so
  // the producer guard can tell its own delivery from an owner keystroke —
  // an untagged fallback write would preempt the very dispatch it serves.
  write: (data: string) => void = (data) => session.write(data),
  stillValid?: () => boolean
): Promise<'submitted' | 'cancelled'> {
  if (stillValid !== undefined && !stillValid()) return 'cancelled'
  write(`${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}`)
  await new Promise((resolve) => setTimeout(resolve, submitDelayMs(body.length)))
  // The check that matters most: cancellation during the delay means the CR
  // is never written — a pasted-but-unsubmitted prompt (see above) instead of
  // a delivered one.
  if (stillValid !== undefined && !stillValid()) return 'cancelled'
  write('\r')
  return 'submitted'
}

/**
 * Send a prompt to a terminal and wait until its output goes quiet, then
 * return the new text produced since the prompt was sent. This mirrors how
 * `cookrew ask` blocks until the target agent finishes responding.
 */
export async function askTerminal(
  session: PtySession,
  prompt: string,
  options: AskOptions = {}
): Promise<string> {
  const quiescenceMs = options.quiescenceMs ?? 2500
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000
  const graceMs = options.graceMs ?? 1500
  const lease = options.lease ?? defaultProducerLease()

  const before = session.fullText()

  // herdr-native ask: the multiplexer submits the prompt (its own paste and
  // submit handling) and blocks until the agent actually finishes — no typed
  // bracketed paste, no tuned submit delay, no quiescence guessing. The reply
  // still comes out of the mirror diff, so the shape callers see is identical.
  const mux = multiplexer()
  if (mux?.capabilities.agentLifecycle && mux.promptAgent) {
    // THE ONE-PRODUCER LEASE, at the submit site (Sol r5 P0-1, hardened into
    // a reservation per r6 P0-1). A native ask submits server-side and never
    // crosses PtySession.write, so this is the only place its bytes can meet
    // the same serialization every other producer meets. Acquiring holds the
    // terminal's submission window for the whole blocking promptAgent — the
    // r5 guard verdict evaporated the moment it was returned, so a dispatch
    // (or a second owner ask) could arm and submit DURING that await; the
    // lease makes them refuse instead. Preemption of an armed dispatch is
    // unchanged (guardOwnerSubmit, inside the acquisition): synchronous, with
    // NO await between verdict and submission.
    const holder = acquireOwnerLease(lease, session, prompt)
    let outcome: 'done' | 'submitted' | 'failed'
    try {
      outcome = await mux.promptAgent(session.sessionName, prompt, timeoutMs)
    } finally {
      // Submission acknowledgement: promptAgent resolved (or threw), so the
      // bytes-in-flight window is over. The TURN keeps running — that is the
      // tracker stamp's job, not the lease's.
      lease.release(session.terminalId, holder)
    }
    if (outcome !== 'failed') {
      // The tracker learns prompts from session.write's input event; a
      // herdr-side submission never passes through write, so announce it —
      // otherwise every herdr-native ask records as a promptless phantom turn.
      session.noteExternalInput(prompt + '\r')
    }
    if (outcome === 'done') {
      return diffOutput(before, session.fullText())
    }
    if (outcome === 'submitted') {
      // The prompt IS in the pane — herdr just could not observe the agent
      // finishing (a stalled detector). Typing again double-submits; measured
      // live as a queued duplicate in the agent's input box. So wait it out
      // by OUTPUT QUIESCENCE — the one completion signal that needs no
      // detector — and skip waitUntilIdle for the same reason the detector
      // stalled: a stuck 'idle' answers instantly and truncates the reply.
      await waitForQuiescence(session, { quiescenceMs, timeoutMs, graceMs })
      return diffOutput(before, session.fullText())
    }
    // 'failed': herdr never delivered it (agent unresolvable, server briefly
    // down) — fall through to the typed path exactly as before this existed.
  }

  // The typed path's writes DO cross PtySession.write and its guard — but
  // that guard refuses by silently dropping the submitting bytes, which here
  // would mean waiting out quiescence over an agent that never received the
  // prompt and returning noise as its "reply". Acquire the lease first so a
  // refused ask is an honest error at the submit site (Sol r5 P0-1, r6 P0-1),
  // and hold it across paste → delay → CR: the split sequence is exactly the
  // window a competing producer used to slip into. The stillValid hook is the
  // ask's own lease hold — a lost hold stops the CR (Sol r6 P0-2).
  const holder = acquireOwnerLease(lease, session, prompt)
  try {
    await pasteAndSubmit(session, prompt, undefined, () =>
      holdsLease(lease, session.terminalId, holder)
    )
  } finally {
    lease.release(session.terminalId, holder)
  }

  await waitForReply(session, { quiescenceMs, timeoutMs, graceMs })

  return diffOutput(before, session.fullText())
}

/** Is `holder` still the one holding this terminal's submission window? */
function holdsLease(lease: ProducerLease, terminalId: string, holder: ProducerHolder): boolean {
  const held = lease.holderOf(terminalId)
  return held !== null && held.kind === 'owner' && holder.kind === 'owner'
    ? held.askId === holder.askId
    : false
}

/**
 * Acquire the terminal's producer lease for one owner submission (Sol r6
 * P0-1), with the r5 preemption flow as its arm:
 *
 * - held by ANOTHER OWNER → refused honestly. Two concurrent owner asks are
 *   two producers; nothing preempts an owner submission mid-flight.
 * - held by a DISPATCH (a delivery is mid-submission) → run the existing
 *   durable preemption (guardOwnerSubmit → the tracker's interrupt path).
 *   Only a COMMITTED preemption displaces the holder; anything else refuses.
 *   The displaced leg's stillValid check stops any byte it has not written.
 * - free → acquired; the armed-but-not-delivering dispatch case is still
 *   guardOwnerSubmit's (the reservation, not the lease, guards that), and a
 *   failed preemption releases before throwing.
 *
 * The returned holder MUST be released (finally) once the submission is
 * acknowledged.
 */
function acquireOwnerLease(
  lease: ProducerLease,
  session: PtySession,
  prompt: string
): ProducerHolder {
  const holder = ownerHolder()
  const terminalId = session.terminalId
  const first = lease.acquire(terminalId, holder)
  if (first === 'held-by-owner') {
    throw new Error('another owner submission is in flight')
  }
  if (first === 'held-by-dispatch') {
    guardOwnerSubmit(session, prompt)
    const seized = lease.acquire(terminalId, holder, { displaceDispatch: true })
    if (seized !== 'acquired') {
      // Another owner slipped in between the committed preemption and the
      // takeover — same honest refusal as a straight owner collision.
      throw new Error('another owner submission is in flight')
    }
    return holder
  }
  try {
    guardOwnerSubmit(session, prompt)
  } catch (error) {
    lease.release(terminalId, holder)
    throw error
  }
  return holder
}

/**
 * Fail-closed owner-producer preemption around an ask's irreversible
 * submission (Sol r5 P0-1): the session's owner-input guard — the exact
 * primitive PtySession.write consults before proc.write — either durably
 * preempts an armed dispatch, allows (nothing armed / already answered), or
 * reports that the preemption could NOT commit. On 'preempt-failed' the ask
 * is REFUSED: submitting anyway would land a second producer's bytes beside
 * an armed dispatch whose interrupt row never became durable. 'refused' (the
 * guard's mid-delivery byte refusal) is equally terminal here — it means a
 * delivery's bytes are in the buffer right now. Unwired guards (tests, plain
 * sessions) allow, matching write()'s own behavior.
 */
function guardOwnerSubmit(session: PtySession, prompt: string): void {
  const verdict = session.beforeOwnerInput?.(session.terminalId, `${prompt}\r`) ?? 'allow'
  if (verdict === 'preempt-failed') {
    throw new Error('agent has a dispatch in flight that could not be preempted')
  }
  if (verdict !== 'allow') {
    throw new Error('a dispatch delivery is mid-submission at this terminal')
  }
}

/**
 * Wait until the agent has finished replying.
 *
 * Prefers ASKING the multiplexer over inferring it. Output quiescence — "silent
 * for 2500ms, therefore done" — is wrong in both directions: an agent pausing
 * mid-turn for a long tool call reads as finished, and an agent that answers
 * instantly still costs the full 2500ms. A backend with `agentLifecycle` knows
 * the real answer and reports it in milliseconds.
 *
 * The heuristic stays as the fallback, unchanged, for tmux and the direct
 * backend — and for a herdr pane whose state herdr cannot report, which
 * `waitUntilIdle` signals by resolving false rather than throwing.
 */
async function waitForReply(
  session: PtySession,
  timing: { quiescenceMs: number; timeoutMs: number; graceMs: number }
): Promise<void> {
  const mux = multiplexer()
  if (mux?.capabilities.agentLifecycle && mux.waitUntilIdle) {
    // The grace period still applies: an agent that has not started working
    // yet is idle, and returning on that would report the PREVIOUS turn's
    // output as this turn's reply.
    await new Promise((resolve) => setTimeout(resolve, timing.graceMs))
    await mux.waitUntilIdle(session.sessionName, timing.timeoutMs)
    // CORROBORATE, never trust alone: the per-pane detector can stick at
    // 'idle' (measured under a live 48s spinner), and a stuck idle resolves
    // this wait instantly — truncating the reply to whatever happened to be
    // on screen. Quiescence returns quickly when the agent genuinely
    // finished, and holds exactly when the detector was lying.
  }
  await waitForQuiescence(session, timing)
}

/** The original heuristic: silence for `quiescenceMs` means finished. */
function waitForQuiescence(
  session: PtySession,
  timing: { quiescenceMs: number; timeoutMs: number; graceMs: number }
): Promise<void> {
  const startedAt = Date.now()
  return new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const elapsed = Date.now() - startedAt
      const quiet = session.idleFor() >= timing.quiescenceMs
      if ((elapsed >= timing.graceMs && quiet) || elapsed >= timing.timeoutMs) {
        clearInterval(timer)
        resolve()
      }
    }, 200)
  })
}

/** Send raw bytes (with escapes already decoded) and return the viewport. */
export async function askRaw(session: PtySession, rawInput: string): Promise<string> {
  const trailingEnter = /[\r\n]+$/.exec(rawInput)
  const body = trailingEnter ? rawInput.slice(0, trailingEnter.index) : rawInput
  if (trailingEnter && body.length > 0) {
    // Text followed by Enter: the same paste-swallow hazard askTerminal
    // guards against — a TUI mid-ingest folds an immediate Enter into the
    // paste and never submits. Deliver as a bracketed paste, then Enter.
    await pasteAndSubmit(session, body)
  } else {
    session.write(rawInput)
  }
  await new Promise((resolve) => setTimeout(resolve, 800))
  return session.viewportText()
}

/**
 * Return the portion of `after` that was appended past `before`.
 * Terminal buffers only ever append lines (scrollback), but the last lines
 * of `before` may have been redrawn — find the longest prefix overlap.
 */
export function diffOutput(before: string, after: string): string {
  if (after.startsWith(before)) {
    return after.slice(before.length).replace(/^\n+/, '')
  }
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  let common = 0
  while (
    common < beforeLines.length &&
    common < afterLines.length &&
    beforeLines[common] === afterLines[common]
  ) {
    common += 1
  }
  return afterLines.slice(common).join('\n').replace(/^\n+/, '')
}

/** Decode CLI escapes: \n \t \e \\ and \xNN byte sequences. */
export function decodeRawEscapes(input: string): string {
  return input
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/\\n/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\e/g, String.fromCharCode(27))
    .replace(/\\\\/g, '\\')
}
