import { feedPromptBuffer } from '../shared/turn'
import { multiplexer, type PtySession } from './pty'
import type { Multiplexer } from './multiplexer'
import {
  CONTAMINATED_REFUSAL,
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
 * THE RESIDUE (Sol r7 P0-1, fail-closed per Sol r8 P0-2): a cancellation
 * after the paste but before the CR leaves the pasted prompt sitting
 * UNSUBMITTED in the TUI's input box, where the terminal's NEXT submission —
 * any producer's — would carry it. That is no longer left as folklore: the
 * terminal is marked CONTAMINATED on the shared producer lease, and every
 * submit-capable write refuses until the terminal is RESTARTED (a generation
 * reset — producer-lease.retire, wired at retireTerminal/backend death). The
 * residue is deliberately NOT auto-cleared, and no observed control byte
 * clears the flag either: at the live tail an ESC is an agent interrupt in
 * every harness TUI we host, and Ctrl-C/Ctrl-U semantics differ per harness
 * (Claude Code's Ctrl-C doubles as quit; a kill-line only provably clears ONE
 * line of a multi-line paste), so no control sequence this code could send OR
 * observe is PROOF of a clean buffer. Marking is generation-scoped: a
 * terminal retired mid-cancellation reboots with a fresh input box and must
 * not inherit the flag.
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
  // WRITE-AHEAD provenance (Sol r10 P0-1): the dirty fact lands durably
  // BEFORE the paste crosses the pane boundary. The pane outlives this
  // process, so if we die between the paste and the CR the NEXT process must
  // find the fact and adopt the box fail-closed; a crash between this mark
  // and the write costs only a false-dirty the normal clears resolve. The
  // real PTY write paths mark too — this covers duck-typed `write` callbacks
  // and keeps the ordering guarantee at the primitive that owns the window.
  if (typeof session.terminalId === 'string') {
    lease.noteBytesEntering(session.terminalId)
  }
  write(`${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}`)
  await new Promise((resolve) => setTimeout(resolve, submitDelayMs(body.length)))
  // The check that matters most: cancellation during the delay means the CR
  // is never written — and the paste ALREADY went out, so the input box now
  // holds a cancelled producer's text: contaminated (see above).
  if (stillValid !== undefined && !stillValid()) {
    if (typeof session.terminalId === 'string') {
      // Durable through the lease (Sol r10 P0-1): a provenance-wired lease
      // upgrades the write-ahead dirty fact to 'contaminated' on disk, so a
      // restart adopts the stranded paste instead of calling the box clean.
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
  // submit handling) — no typed bracketed paste, no tuned submit delay. The
  // reply still comes out of the mirror diff, so the shape callers see is
  // identical. Null = herdr could not deliver at all; fall through to the
  // typed path exactly as before this existed.
  const mux = multiplexer()
  if (mux?.capabilities.agentLifecycle && (mux.submitAgent ?? mux.promptAgent) !== undefined) {
    const native = await nativeAsk(session, prompt, { quiescenceMs, timeoutMs, graceMs }, lease, mux)
    if (native !== null) return diffOutput(before, native)
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

/**
 * SHUTDOWN CANCELLATION (Sol r10 P1): every native ask registers its
 * AbortController here for the app's before-quit. Retirement already aborts a
 * single terminal's asks via lease.onRetire, but app quit neither retires the
 * surviving terminals nor otherwise reaches an ask blocked inside a
 * `herdr agent prompt/wait` child — which could outlive Electron until its
 * ten-minute timeout. The registry is bounded by in-flight asks: each entry is
 * added on entry to nativeAsk and settled/removed in its `finally`.
 */
interface ActiveAsk {
  readonly abort: AbortController
  readonly settled: Promise<void>
  readonly settle: () => void
}

const activeAsks = new Set<ActiveAsk>()

/** Total time cancelAllAsks waits for TERM→KILL settlements before quitting anyway. */
const CANCEL_ALL_ASKS_CAP_MS = 3000

function registerActiveAsk(abort: AbortController): ActiveAsk {
  let settle: () => void = () => undefined
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  const entry: ActiveAsk = { abort, settled, settle }
  activeAsks.add(entry)
  return entry
}

/** In-flight native asks right now — diagnostics and the shutdown gate. */
export function activeAskCount(): number {
  return activeAsks.size
}

/**
 * THE before-quit primitive (Sol r10 P1), called by the conductor before the
 * final app.quit: fire every active ask's AbortController — each abort
 * TERM-kills its CLI child, with the runner's own 2s SIGKILL fallback behind
 * it — and await the bounded settlements, capped at CANCEL_ALL_ASKS_CAP_MS so
 * a child that ignores everything cannot hold the quit hostage. The panes
 * (and the agents in them) stay alive for the next launch; what this proves
 * is that NO herdr CLI child of ours survives the Electron process. Safe to
 * call with nothing in flight, and more than once.
 */
export async function cancelAllAsks(capMs = CANCEL_ALL_ASKS_CAP_MS): Promise<void> {
  const entries = [...activeAsks]
  for (const entry of entries) entry.abort.abort()
  if (entries.length === 0) return
  await Promise.race([
    Promise.all(entries.map((entry) => entry.settled)).then(() => undefined),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, capMs)
      timer.unref?.()
    })
  ])
}

/**
 * The backend-native leg of an ask. Returns the post-turn full text for the
 * caller's diff, or null when herdr never delivered the prompt (agent
 * unresolvable, server briefly down) and the typed path should run instead.
 *
 * THE ONE-PRODUCER LEASE, at the submit site (Sol r5 P0-1, a reservation per
 * r6 P0-1): a native ask submits server-side and never crosses
 * PtySession.write, so this is the only place its bytes can meet the same
 * serialization every other producer meets. Preemption of an armed dispatch
 * is unchanged (guardOwnerBytes, inside the acquisition): synchronous, with
 * NO await between verdict and submission. The guard sees the SUBMITTING
 * bytes — prompt plus Enter, the exact shape a typed submit would have.
 *
 * THE LEASE WINDOW (Sol r8 P1): with a backend that acknowledges submission
 * (`submitAgent` — herdr's `agent prompt` without `--wait`), the lease is
 * held only across that acknowledgement and the reply-wait runs OUTSIDE it,
 * so owner input at the desktop is refused for milliseconds instead of the
 * whole turn. Without the mode, `promptAgent` keeps the CONSERVATIVE hold —
 * acquired before the blocking call, released when it settles — because the
 * only acknowledgement that backend offers IS turn completion; the refusal
 * surfacing (PtySession.write verdicts, TurnTracker.refusalReason) is what
 * makes that long hold visible instead of silent.
 *
 * THE ABORT SEAM (Sol r8 P1, extended past the ack per r9 P1-4): the
 * terminal retiring mid-await fires an AbortController threaded into the
 * backend call — killing the CLI child — AND into the post-acknowledgement
 * reply-wait (waitUntilIdle, the quiescence interval, even the grace sleep),
 * so retirement cancels every phase of the ask, not just the submission. The
 * generation captured at entry is re-checked after EVERY awaited phase
 * before any session output is read: a retired ask throws honestly rather
 * than falling through to type into — or return output rendered by — the
 * reborn terminal.
 */
async function nativeAsk(
  session: PtySession,
  prompt: string,
  timing: { quiescenceMs: number; timeoutMs: number; graceMs: number },
  lease: ProducerLease,
  mux: Multiplexer
): Promise<string | null> {
  const terminalId = session.terminalId
  const generation = lease.generationOf(terminalId)
  const abort = new AbortController()
  // Registered for app shutdown (Sol r10 P1): cancelAllAsks fires this same
  // controller, so quit reaches the blocked CLI child exactly as retirement
  // does. Settled in the finally — the registry is bounded by in-flight work.
  const active = registerActiveAsk(abort)
  const unsubscribe = lease.onRetire((retired) => {
    if (retired === terminalId) abort.abort()
  })
  // Every awaited phase ends with this: retirement throws the honest
  // 'retired' error, and a shutdown abort (generation intact, signal fired)
  // its own — never falling through to read the session as a reply.
  const assertLive = (): void => {
    assertGeneration(lease, terminalId, generation)
    if (abort.signal.aborted) throw new Error('the ask was cancelled at app shutdown')
  }
  try {
    const holder = acquireOwnerLease(lease, session, `${prompt}\r`)
    let outcome: 'done' | 'submitted' | 'failed'
    try {
      outcome =
        mux.submitAgent !== undefined
          ? await mux.submitAgent(session.sessionName, prompt, timing.timeoutMs, abort.signal)
          : await mux.promptAgent!(session.sessionName, prompt, timing.timeoutMs, abort.signal)
    } catch (error) {
      // A rejection from a killed child is the RETIREMENT (or the shutdown)
      // speaking, not a submission fault — name which instead of leaking an
      // AbortError. Generation mismatch distinguishes them: retirement bumps
      // it, a shutdown abort does not.
      if (lease.generationOf(terminalId) !== generation) {
        throw new Error('the terminal was retired mid-ask')
      }
      if (abort.signal.aborted) {
        throw new Error('the ask was cancelled at app shutdown')
      }
      throw error
    } finally {
      // Submission acknowledgement (or the attempt settled): the
      // bytes-in-flight window is over. The TURN keeps running — that is the
      // tracker stamp's job, not the lease's.
      lease.release(terminalId, holder)
    }
    // Retired or shutdown-cancelled mid-await (the abort fired, or the call
    // settled first by luck). The dead leg must not fall through and type
    // into the reborn terminal's input box.
    assertLive()
    if (outcome === 'failed') return null
    // The tracker learns prompts from session.write's input event; a
    // herdr-side submission never passes through write, so announce it —
    // otherwise every herdr-native ask records as a promptless phantom turn.
    session.noteExternalInput(prompt + '\r')
    if (outcome === 'done') return session.fullText()
    if (mux.submitAgent !== undefined) {
      // Acknowledged submission, reply pending: the ordinary reply-wait —
      // waitUntilIdle where the backend answers, quiescence corroborating —
      // runs with the lease already free. The retirement signal rides along
      // (Sol r9 P1-4): a terminal retiring AFTER the ack must cancel this
      // wait's child and timers, not leave them running out the timeout —
      // and the generation is re-checked before any session read, so the
      // dead leg never returns output rendered by the REBORN terminal.
      await waitForReply(session, timing, abort.signal)
      assertLive()
      return session.fullText()
    }
    // promptAgent 'submitted': the prompt IS in the pane — herdr just could
    // not observe the agent finishing (a stalled detector). Typing again
    // double-submits; measured live as a queued duplicate in the agent's
    // input box. So wait it out by OUTPUT QUIESCENCE — the one completion
    // signal that needs no detector — and skip waitUntilIdle for the same
    // reason the detector stalled: a stuck 'idle' answers instantly and
    // truncates the reply. Abortable and generation-checked like the
    // reply-wait above (Sol r9 P1-4).
    await waitForQuiescence(session, timing, abort.signal)
    assertLive()
    return session.fullText()
  } finally {
    unsubscribe()
    activeAsks.delete(active)
    active.settle()
  }
}

/**
 * The generation re-check EVERY awaited reply phase ends with (Sol r9 P1-4):
 * an ask whose terminal retired mid-wait throws honestly instead of reading —
 * and returning — session output that now belongs to the reborn generation.
 */
function assertGeneration(lease: ProducerLease, terminalId: string, generation: number): void {
  if (lease.generationOf(terminalId) !== generation) {
    throw new Error('the terminal was retired mid-ask')
  }
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
 * - CONTAMINATED input buffer → refused until the terminal is restarted (a
 *   generation reset — see pasteAndSubmit's residue note; Sol r8 P0-2).
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
    throw new Error(CONTAMINATED_REFUSAL)
  }
  guardOwnerBytes(session, bytes)
  const holder = ownerHolder()
  if (lease.acquire(terminalId, holder) !== 'acquired') {
    // Unreachable in a single-threaded stretch; kept as an honest belt.
    throw new Error('another owner submission is in flight')
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
  timing: { quiescenceMs: number; timeoutMs: number; graceMs: number },
  signal?: AbortSignal
): Promise<void> {
  const mux = multiplexer()
  if (mux?.capabilities.agentLifecycle && mux.waitUntilIdle) {
    // The grace period still applies: an agent that has not started working
    // yet is idle, and returning on that would report the PREVIOUS turn's
    // output as this turn's reply. Abortable (Sol r9 P1-4): retirement must
    // not sit out even the grace sleep.
    await abortableSleep(timing.graceMs, signal)
    if (signal?.aborted !== true) {
      // The signal reaches the backend wait itself, so a retirement kills
      // its blocking CLI child now. An implementation that ignores the
      // parameter still settles by its own timeout; the caller's generation
      // re-check owns correctness either way.
      await mux.waitUntilIdle(session.sessionName, timing.timeoutMs, signal)
    }
    // CORROBORATE, never trust alone: the per-pane detector can stick at
    // 'idle' (measured under a live 48s spinner), and a stuck idle resolves
    // this wait instantly — truncating the reply to whatever happened to be
    // on screen. Quiescence returns quickly when the agent genuinely
    // finished, and holds exactly when the detector was lying.
  }
  await waitForQuiescence(session, timing, signal)
}

/**
 * The original heuristic: silence for `quiescenceMs` means finished. The
 * abort seam (Sol r9 P1-4) resolves it EARLY — never rejects — because the
 * caller's own generation re-check is the honest thrower; rejecting here
 * would leak AbortErrors through the typed path that never passes a signal.
 */
function waitForQuiescence(
  session: PtySession,
  timing: { quiescenceMs: number; timeoutMs: number; graceMs: number },
  signal?: AbortSignal
): Promise<void> {
  const startedAt = Date.now()
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const settle = (): void => {
      clearInterval(timer)
      signal?.removeEventListener('abort', settle)
      resolve()
    }
    const timer = setInterval(() => {
      const elapsed = Date.now() - startedAt
      const quiet = session.idleFor() >= timing.quiescenceMs
      if ((elapsed >= timing.graceMs && quiet) || elapsed >= timing.timeoutMs) settle()
    }, 200)
    signal?.addEventListener('abort', settle, { once: true })
  })
}

/** A sleep the retirement signal can cut short (resolves, never rejects). */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const settle = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', settle)
      resolve()
    }
    const timer = setTimeout(settle, ms)
    signal?.addEventListener('abort', settle, { once: true })
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
