import { feedPromptBuffer } from '../shared/turn'
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
 * passes its deliveryLive + lease check, the owner submit its own lease hold.
 *
 * THE RESIDUE (Sol r7 P0-1): a cancellation after the paste but before the CR
 * leaves the pasted prompt sitting UNSUBMITTED in the TUI's input box, where
 * the terminal's NEXT submission — any producer's — would carry it. That is
 * no longer left as folklore: the terminal is marked CONTAMINATED on the
 * shared producer lease, and every submit-capable write refuses until the
 * owner clears the input box (see TurnTracker.handleInput for the
 * acknowledgment). The residue is deliberately NOT auto-cleared here: at the
 * live tail an ESC is an agent interrupt in every harness TUI we host, and
 * Ctrl-C/Ctrl-U semantics differ per harness (Claude Code's Ctrl-C doubles as
 * quit; a kill-line only provably clears ONE line of a multi-line paste), so
 * no control sequence this code could send is PROOF of a clean buffer.
 * Marking is generation-scoped: a terminal retired mid-cancellation reboots
 * with a fresh input box and must not inherit the flag.
 */
export async function pasteAndSubmit(
  session: PtySession,
  body: string,
  // The dispatch reattach-fallback writes through the SOURCE-TAGGED path so
  // the producer guard can tell its own delivery from an owner keystroke —
  // an untagged fallback write would preempt the very dispatch it serves.
  write: (data: string) => void = (data) => session.write(data),
  stillValid?: () => boolean,
  lease: ProducerLease = defaultProducerLease()
): Promise<'submitted' | 'cancelled'> {
  const generation = lease.generationOf(session.terminalId)
  if (stillValid !== undefined && !stillValid()) return 'cancelled'
  write(`${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}`)
  await new Promise((resolve) => setTimeout(resolve, submitDelayMs(body.length)))
  // The check that matters most: cancellation during the delay means the CR
  // is never written — and the paste ALREADY went out, so the input box now
  // holds a cancelled producer's text: contaminated (see above).
  if (stillValid !== undefined && !stillValid()) {
    if (typeof session.terminalId === 'string') {
      lease.markContaminated(session.terminalId, generation)
    }
    return 'cancelled'
  }
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
    // unchanged (guardOwnerBytes, inside the acquisition): synchronous, with
    // NO await between verdict and submission. The guard sees the SUBMITTING
    // bytes — prompt plus Enter, the exact shape a typed submit would have.
    const holder = acquireOwnerLease(lease, session, `${prompt}\r`)
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

  // The typed path routes through THE submit primitive (Sol r7 P0-2):
  // ownerSubmit classifies, acquires the lease, runs the armed-dispatch
  // preemption, holds across paste → delay → CR through the owner-tagged
  // write path, and releases — the same door every other PTY producer now
  // uses. A refusal is an honest error at the submit site, never a silent
  // byte drop followed by quiescence over an agent that got nothing.
  const verdict = await ownerSubmit(session, `${prompt}\r`, { lease })
  if (!verdict.ok) throw new Error(verdict.reason)

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
 * P0-1, conservative per r7 P0-1 — NO displacement):
 *
 * - held by ANOTHER OWNER → refused honestly. Two concurrent owner asks are
 *   two producers; nothing preempts an owner submission mid-flight.
 * - held by a DISPATCH → refused: 'a dispatch is being delivered — retry in
 *   a moment'. Once a dispatch holds the window its bytes are (or may
 *   already be) irreversibly in flight; a ledger interrupt cannot un-send
 *   them, so the owner waits instead of submitting beside them. A dispatch
 *   that is merely ARMED (stamped, no hold) is still preempted exactly as
 *   before, by guardOwnerSubmit below — that path never crosses the
 *   boundary.
 * - CONTAMINATED input buffer → refused until the owner clears the box (see
 *   pasteAndSubmit's residue note).
 * - free → guardOwnerSubmit (armed-dispatch preemption, fail-closed), then
 *   acquired. Guard and acquire share one synchronous stretch, so nothing
 *   can take the window between the verdict and the hold.
 *
 * The returned holder MUST be released (finally) once the submission is
 * acknowledged.
 */
function acquireOwnerLease(
  lease: ProducerLease,
  session: PtySession,
  bytes: string
): ProducerHolder {
  const terminalId = session.terminalId
  const held = lease.holderOf(terminalId)
  if (held?.kind === 'dispatch') {
    throw new Error('a dispatch is being delivered — retry in a moment')
  }
  if (held?.kind === 'owner') {
    throw new Error('another owner submission is in flight')
  }
  if (lease.isContaminated(terminalId)) {
    throw new Error(CONTAMINATED_REASON)
  }
  guardOwnerBytes(session, bytes)
  const holder = ownerHolder()
  if (lease.acquire(terminalId, holder) !== 'acquired') {
    // Unreachable in a single-threaded stretch; kept as an honest belt.
    throw new Error('another owner submission is in flight')
  }
  return holder
}

/** The named refusal every producer sees while the buffer is dirty. */
const CONTAMINATED_REASON =
  'the input box holds a cancelled delivery — clear it (Ctrl-U/Ctrl-C) and retry'

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
function guardOwnerBytes(session: PtySession, bytes: string): void {
  const verdict = session.beforeOwnerInput?.(session.terminalId, bytes) ?? 'allow'
  if (verdict === 'preempt-failed') {
    throw new Error('agent has a dispatch in flight that could not be preempted')
  }
  if (verdict !== 'allow') {
    throw new Error('a dispatch delivery is mid-submission at this terminal')
  }
}

export interface OwnerSubmitOptions {
  /** Injectable for tests; production shares the process-wide default. */
  lease?: ProducerLease
}

/** What became of one owner submission attempt. Refusals carry their name. */
export type OwnerSubmitResult =
  | { ok: true; submitted: boolean }
  | { ok: false; reason: string }

/**
 * THE owner submit primitive (Sol r7 P0-2): every PTY producer that is not
 * the dispatch engine routes its bytes through here — askTerminal's typed
 * path, askRaw (CLI `--raw`), the mobile /input and /raw handlers, routines,
 * and fork context injection. It classifies the bytes with the SAME
 * feedPromptBuffer model the tracker uses, and:
 *
 * - NON-submitting bytes (typing, arrows, control sequences without an
 *   unbracketed CR) go through the ordinary guarded PtySession.write; the
 *   guard's verdict is surfaced, so a refusal is an answer, never a silent
 *   drop.
 * - SUBMIT-capable bytes acquire the lease as ONE owner holder, run the
 *   armed-dispatch preemption, deliver — a `body + Enter` payload as a
 *   bracketed paste plus a delayed CR (the paste-swallow hazard), anything
 *   else (a bare Enter, raw sequences with embedded CRs) as one synchronous
 *   write — and release in a finally. The hold spans the whole multi-write
 *   sequence, so no other producer's bytes can interleave with the paste and
 *   its CR; the bytes themselves travel writeFromOwner, the tagged path the
 *   guard exempts (the holder must not refuse itself).
 *
 * Refusals: dispatch-held ('a dispatch is being delivered — retry in a
 * moment'), owner-held, contaminated buffer, failed/refused preemption, and
 * a mid-flight cancellation (terminal retired between paste and CR).
 */
export async function ownerSubmit(
  session: PtySession,
  bytes: string,
  options: OwnerSubmitOptions = {}
): Promise<OwnerSubmitResult> {
  const lease = options.lease ?? defaultProducerLease()
  const terminalId = session.terminalId
  if (feedPromptBuffer('', bytes).submitted.length === 0) {
    // Not submit-capable. The guard still arbitrates (it refuses ALL untagged
    // bytes while any producer holds the window); a void-returning legacy
    // fake reads as allow, matching the unwired-guard convention.
    const verdict = session.write(bytes) as ReturnType<PtySession['write']> | undefined
    return verdict === undefined || verdict === 'allow'
      ? { ok: true, submitted: false }
      : { ok: false, reason: refusalReason(verdict) }
  }
  let holder: ProducerHolder
  try {
    holder = acquireOwnerLease(lease, session, bytes)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  // The holder's own bytes travel the TAGGED path the guard exempts — a
  // real PtySession always has it. Duck-typed sessions (tests, embedders)
  // without one degrade to plain write, which their unwired guards allow.
  const writeOwner = (data: string): void => {
    if (typeof session.writeFromOwner === 'function') session.writeFromOwner(data)
    else session.write(data)
  }
  try {
    const trailing = /[\r\n]+$/.exec(bytes)
    const body = trailing ? bytes.slice(0, trailing.index) : bytes
    if (trailing !== null && body.length > 0) {
      const outcome = await pasteAndSubmit(
        session,
        body,
        writeOwner,
        () => holdsLease(lease, terminalId, holder),
        lease
      )
      return outcome === 'submitted'
        ? { ok: true, submitted: true }
        : { ok: false, reason: 'the submission was cancelled mid-delivery (terminal retired)' }
    }
    // A bare Enter or raw bytes with embedded CRs: one synchronous write
    // under the hold — acquire, submit, release, no async window.
    writeOwner(bytes)
    return { ok: true, submitted: true }
  } finally {
    lease.release(terminalId, holder)
  }
}

/** Name a guard refusal for callers that surface it (HTTP 409, CLI error). */
function refusalReason(verdict: 'preempt-failed' | 'refused'): string {
  return verdict === 'preempt-failed'
    ? 'agent has a dispatch in flight that could not be preempted'
    : 'another producer holds the submission window at this terminal'
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
export async function askRaw(
  session: PtySession,
  rawInput: string,
  options: OwnerSubmitOptions = {}
): Promise<string> {
  // One primitive for every shape of raw input (Sol r7 P0-2): text followed
  // by Enter becomes a leased bracketed paste plus delayed CR (the same
  // paste-swallow hazard askTerminal guards against), a bare Enter or control
  // sequence a single guarded/leased write. A refusal — another producer's
  // submission in flight, a contaminated buffer — is thrown, not silently
  // dropped and answered with a stale viewport.
  const verdict = await ownerSubmit(session, rawInput, options)
  if (!verdict.ok) throw new Error(verdict.reason)
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
