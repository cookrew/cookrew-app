// Attach-free dispatch: give an agent work over HTTP without a terminal.
//
// v4 §3, rebased onto v5 tracking. The protocol already had ~45 routes and two
// SSE streams; the one it lacked was this. `POST /api/agents/:id/dispatch`
// resolves the agent's pane through the multiplexer and submits the prompt
// natively — measured, that reached both background agents (eval P2) where
// HTTP /ask 404s on a detached pane because it needs a live PtySession
// (eval F1).
//
// So NO PtySession appears in this module, by import as well as by intent.
// The single PTY in the design is `reattachFallback`, injected by index.ts and
// reached only after the transcript has PROVEN the prompt never landed.
//
// v5 CHANGE: there is no serviceState and no dormant refusal any more. Any
// resolvable agent is dispatchable — the dispatch itself creates the tracking
// it needs, through `beginWork` (session-file watch + drain pin) at accept
// time and `endWork` (unpin) when the record reaches a terminal state.
//
// THE F2 RULE, which most of this file exists to keep: herdr reports `stalled`
// — "agent prompt produced no observed state change" — for prompts that landed
// perfectly. It did so on BOTH successful dispatches in the eval. `stalled`
// is a statement about the detector, not about delivery. Re-sending on it
// double-submits into a live agent's input box, so every retry here is
// preceded by reading the transcript. Never blind.

import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
// The one-producer lease (Sol r6 P0-1) — pure state, no PTY: the delivery
// legs hold a terminal's submission window across their irreversible writes,
// and every producer (owner asks, the PTY guard) shares the same instance.
import {
  CONTAMINATED_REFUSAL,
  defaultProducerLease,
  type ProducerHolder,
  type ProducerLease
} from './producer-lease'

/**
 * Lifecycle of one dispatch (v4 §3, terminal states per Tinker's herdr-death
 * taxonomy). `submitted` is the reservation; `running` means the prompt is
 * demonstrably in the pane; `interrupted` is infra-stamped and distinct from
 * `failed` — the difference between "we could not deliver this" and "we
 * delivered it and the world fell over", which a consumer treats differently.
 */
export type DispatchState = 'submitted' | 'running' | 'done' | 'failed' | 'interrupted'

/** How the prompt actually reached the agent. */
export type DispatchVia = 'herdr' | 'pty-fallback'

/**
 * What kind of witness beginWork installed for an accepted dispatch.
 * 'native-file' is the settlement-grade observer (durable native finality);
 * 'scrape' is a live-PTY witness whose closure evidence is screen quiescence
 * — owner-grade only (Sol r3 P0-5).
 */
export type ObserverGrade = 'native-file' | 'scrape'

/**
 * How the turn that answered a dispatch actually ENDED, per the parser
 * (Sol r3 P1-7). 'done' is a successful native tail; 'failed' covers native
 * aborted/error/length markers; 'interrupted' is an infrastructure ending.
 * Absent anywhere it could appear means 'done' — the field lands in a
 * parallel lane and this side tolerates its absence.
 */
export type TurnOutcome = 'done' | 'failed' | 'interrupted'

/**
 * PROVENANCE of a terminal intent (Sol r4 P1): who observed the ending.
 * 'parser' is a fact about the turn itself — a durable native record with an
 * outcome; 'infrastructure' is a fact about the machinery around it (backend
 * death, restart, timeout sweep, failed delivery). At equal projected STATE,
 * parser evidence outranks infrastructure: a parser-proven `interrupted`
 * carrying the answering turn's identity must never be replaced by a generic
 * infrastructure interruption that carries nothing.
 */
export type TerminalEvidence = 'parser' | 'infrastructure'

/**
 * A durable FINAL record already answering an open dispatch — what the
 * hasFinalAnswer dep returns (Sol r4 P0-3). No longer a boolean: the sweep
 * needs the record's own outcome and identity so it can commit THAT verdict
 * through the normal completion path instead of converting a proven answer
 * into `interrupted: no outcome within 10 minutes`.
 */
export interface FinalTurnAnswer {
  turnIndex: number
  uuid?: string
  outcome?: TurnOutcome
  reply?: string
}

export interface DispatchRecord {
  id: string
  agentId: string
  agentName: string
  workspaceId: string
  state: DispatchState
  via: DispatchVia | null
  createdAt: number
  updatedAt: number
  idempotencyKey?: string
  /** Idempotency is consumer-scoped; absent for owner calls. */
  consumer?: string
  /**
   * Versioned sha256 of the EXACT request bytes (promptFingerprint). The
   * idempotency key says "this is the same work"; the hash is what lets the
   * service CHECK that claim — one key fronting two different briefs is
   * refused instead of silently replaying whichever brief arrived first.
   * Comparable only within one fingerprint version (fingerprintVerdict);
   * legacy bare-hex rows were lossy, cannot prove sameness against v2, and
   * are refused fail-closed rather than replayed on faith (Sol r5 P0-3).
   */
  promptHash?: string
  /**
   * Did the TRANSCRIPT agree that the prompt landed? Only meaningful for a
   * `submitted`/stalled outcome, where herdr declined to say. Recorded because
   * "we checked and it was there" and "the backend said done" are different
   * grades of evidence and a correlation trace should not blur them.
   */
  confirmed?: boolean
  /** The turn that answered this dispatch (correlated via CompletedTurn). */
  turnIndex?: number
  /**
   * STABLE identity of the answering turn — the harness's own message uuid
   * (Sol r4 P1). `turnIndex` is a display ordinal a rewind or branch switch
   * can reuse for entirely different work; the uuid survives index shifts, so
   * receipts and audits resolve the exchange by THIS when present. Absent for
   * harnesses without durable per-turn ids (scrape-only closures).
   */
  turnUuid?: string
  /**
   * The agent's answer, IN MEMORY ONLY — it is dropped from the persisted row
   * and from the HTTP projection alike (F4/D3). The text lives in the turn
   * ledger, which is where transcripts belong, and `turnIndex` says which turn.
   */
  reply?: string
  /**
   * Did that turn produce a reply? Survives the restart the text does not, so
   * a rehydrated record can still say "there is an answer, ask the turn ledger"
   * instead of implying the agent said nothing.
   */
  hasReply?: boolean
  /**
   * IN MEMORY ONLY, never persisted: a terminal transition was decided but its
   * durable append failed, so the record is held OPEN — reservation kept,
   * terminal state invisible on GET — until the sweep lands the append and
   * releases exactly once. A terminal state that exists only in memory is a
   * settlement S5 could never audit, so it is not allowed to exist at all.
   */
  ledgerFault?: boolean
  error?: string
}

/** What a route hands back: an HTTP status and a body, nothing rendered. */
export interface DispatchResponse {
  status: number
  body: Record<string, unknown>
}

export interface DispatchInput {
  /** A catalog brief. */
  brief?: string
  /** Free text. */
  text?: string
  idempotencyKey?: string
  /**
   * Authenticated caller identity, injected by the route — never accepted
   * from the HTTP body. Scopes the idempotency key so one tenant's retry can
   * never replay (or shadow) another's dispatch. Absent for owner calls.
   */
  consumer?: string
}

/**
 * The GENERATION a delivery fact belongs to (Sol r5 P1): the dispatch that
 * armed it and when. Threaded through every attempted/confirmed/retracted
 * delivery call so the tracker can scope the fact to one exchange — a
 * confirmation returning AFTER that dispatch settled (the blocking native
 * submit outliving a fast scrape/file closure) must be a no-op, never a fresh
 * open-turn fact minted at Date.now() with no future turn to close it.
 */
export interface DispatchGeneration {
  dispatchId: string
  armedAt: number
}

export interface DispatchDeps {
  /** Agent id → identity, across workspaces. Null when nobody owns that id. */
  resolveAgent: (agentId: string) => { name: string; workspaceId: string } | null
  /** The token join: Cookrew's node id → the multiplexer's session name. */
  sessionNameFor: (agentId: string) => string
  sessionExists: (sessionName: string) => boolean
  /** Visible pane transcript, attach-free. Null when the pane is gone. */
  capture: (sessionName: string) => string | null
  /**
   * The same pane, reaching back into scrollback — for "did this prompt ever
   * arrive?", which a viewport-sized capture answers NO for as soon as a long
   * turn has scrolled the echo away (F3).
   *
   * Deliberately NOT used for the context-full check: that reads a status
   * footer, and finding a stale "100% context used" line from before a
   * /compact deep in the scrollback would refuse a perfectly serviceable
   * agent forever. Depth helps one question and lies about the other.
   * Absent = the backend cannot go deeper, and `capture` answers both.
   */
  captureDeep?: (sessionName: string) => string | null
  /**
   * Native submission. Optional exactly as on the Multiplexer: a backend
   * without agent lifecycle cannot dispatch, and saying 503 beats typing into
   * a pane nobody is watching.
   *
   * `signal` is the abort seam (Sol r8 P1): the service fires it when the
   * delivery leg is cancelled — interrupt, release, terminal retirement,
   * backend death — and a wiring that threads it into herdr-agent-wait's
   * execFile TERM-kills the blocking CLI child instead of leaving it (and
   * its pipes, callbacks and promise) alive for the full timeout. A wiring
   * that ignores the parameter still typechecks; it merely keeps the old
   * leak.
   */
  promptAgent?: (
    sessionName: string,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal
  ) => Promise<'done' | 'submitted' | 'failed'>
  /**
   * Native submission that returns at SUBMISSION ACKNOWLEDGEMENT (Sol r9
   * P1-3) — the capability split the owner asks already use. When present,
   * the delivery leg submits through THIS and releases the producer lease
   * the moment the submission is acknowledged, so a minutes-long dispatched
   * turn refuses desktop bytes for milliseconds instead of the whole turn;
   * turn completion is observed OUTSIDE the lease by the transcript
   * correlation and the sweep, exactly as they already do for 'submitted'
   * outcomes. 'submitted' carries the same do-not-retype contract as
   * promptAgent's (ambiguous outcomes included); 'failed' means herdr
   * positively refused, and the ordinary landing evidence (captureDeep) and
   * fallback still apply. Absent = the backend cannot acknowledge without
   * waiting, and deliver keeps the conservative promptAgent full-turn hold.
   * The conductor wires this to mux.submitAgent.
   */
  submitAgent?: (
    sessionName: string,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal
  ) => Promise<'submitted' | 'failed'>
  /**
   * INPUT-BUFFER OWNERSHIP (Sol r8 P0-1): is the OWNER composing in this
   * agent's shared input box right now — meaningful typed bytes in the
   * tracked prompt buffer, or an owner editing reservation/lease held? Wired
   * by the conductor to TurnTracker.ownerComposing. Consulted at admission
   * (refuse 409: the input box is the owner's) AND revalidated by both
   * delivery legs immediately before their irreversible submission — a
   * compose that starts after the 202 cancels the delivery like an
   * interrupt, because a native or pasted submission would append the
   * dispatch's bytes to the owner's half-typed text and submit a combined
   * prompt that is neither producer's work. Absent = cannot say (tests,
   * memory-only services): admission proceeds on the lease alone.
   */
  ownerComposing?: (agentId: string) => boolean
  /**
   * Ask herdr what the agent is doing right now, when the backend can answer.
   * Used as EVIDENCE ONLY — a working agent proves something landed, which is
   * why an unconfirmed prompt must not be re-sent on top of it. Null when the
   * backend has no lifecycle feed (tmux, direct).
   */
  agentStatus?: (sessionName: string) => 'idle' | 'working' | 'blocked' | 'done' | null
  /**
   * Tell the tracker which dispatch the agent's next completed turn answers,
   * and WHAT that dispatch actually said — the tracker demands prompt
   * identity at completion, not just a start time after the arming.
   * Returns FALSE when that agent already carries a live stamp — one turn
   * cannot answer two dispatches, and overwriting the stamp would close the
   * second dispatch with the first one's turn.
   */
  noteDispatch: (agentId: string, dispatchId: string, prompt: string) => boolean
  /**
   * Drop the tracker's stamp for a dispatch that ended without a turn. Without
   * it a failed dispatch leaves its id armed and the agent's next HUMAN turn
   * gets attributed to a dispatch nobody is waiting on.
   */
  clearDispatch?: (agentId: string, dispatchId: string) => void
  /**
   * Native delivery is CONFIRMED (herdr watched it land, or the transcript
   * shows the echo) — or ATTEMPTED without proof of non-delivery (Sol r3
   * P1-9): hand the tracker the EXACT delivered prompt as the live turn's
   * prompt-of-record. The native path never touches the PTY input stream, so
   * without this the scrape closer can only recover the prompt from a
   * rendered echo — which a TUI collapses into "[Pasted text #1 …]" or
   * truncates, leaving prompt identity unprovable and the dispatch open. The
   * fact, not the keystrokes: the prompt is not written a second time. The
   * two grades differ only in confidence (the record's `confirmed` flag keeps
   * the distinction); for prompt-of-record purposes the tracker treats them
   * the same, because the only turn these bytes can open is the dispatched
   * one. Registered at ATTEMPTED grade BEFORE the blocking native submission
   * (Sol r4 P1): herdr `agent prompt` blocks until the agent leaves working,
   * so a fact registered only afterwards can arrive after the scrape already
   * settled the turn — too late to be its prompt-of-record. Re-called at
   * confirmation (done / landed / unproven), which refreshes the fact and
   * lets the tracker replay closure for a turn that settled unprovable.
   *
   * GENERATION-SCOPED (Sol r5 P1): every call carries the arming generation,
   * so the tracker treats a confirmation whose dispatchId no longer holds a
   * stamp as settled history, not as a new delivery. The conductor wires this
   * to TurnTracker.noteDispatchDelivered's (terminalId, prompt, gen)
   * signature; a transitional 2-arg tracker wiring still typechecks (the
   * lambda simply ignores gen) and keeps the pre-generation behavior until
   * the tracker lane lands.
   */
  noteDelivered?: (agentId: string, prompt: string, gen: DispatchGeneration) => void
  /**
   * The attempted-delivery fact registered before submission turned out to be
   * FALSE: non-delivery was positively proven (nonDeliveryProven — the pane
   * never moved, no echo, agent not busy). Wired by the conductor to
   * TurnTracker.retractDispatchDelivered so the fallback's re-send is never
   * correlated against a delivery that never happened. Called ONLY on proven
   * non-delivery — an unproven absence keeps the fact. Generation-scoped like
   * noteDelivered (Sol r5 P1): a retraction takes back its OWN generation's
   * fact, never a successor's.
   */
  retractDelivered?: (agentId: string, prompt: string, gen: DispatchGeneration) => void
  /**
   * The dispatch is accepted: start the tracking it depends on (v5 A4 —
   * tracking follows work). Called once per accepted dispatch, after the
   * agent's slot is reserved and before delivery, so the session-file watch
   * and the drain pin exist before the turn they must observe.
   *
   * Returns the GRADE of observer it installed (Sol r3 P0-5):
   * - 'native-file' — a session-file observer with native finality; the only
   *   grade a non-owner consumer's dispatch may settle on.
   * - 'scrape'      — a live PTY scrape; owner-grade only, since its closure
   *   evidence is screen quiescence, not a durable native row.
   * - false         — no observer at all: a pin with no watch, an acceptance
   *   nothing would ever close. A false return promises the failed attempt
   *   left no state behind (the implementation releases anything it
   *   half-built); the service then rolls its own side back and refuses 503.
   * `true` is the legacy boolean alias and is treated as 'scrape' — the
   * fail-closed reading for consumers — until every wiring reports the grade.
   */
  beginWork: (agentId: string) => 'native-file' | 'scrape' | boolean
  /**
   * The durable FINAL record answering (prompt, armedAt), when one exists for
   * this agent (Sol r3 P0-6, payload per Sol r4 P0-3). The sweep asks it for
   * every stale dispatch: a matching record's own outcome is committed via
   * the normal completion path — timeout-interrupt is reserved for dispatches
   * with NO durable terminal record — and a stuck 'working' status feed
   * cannot outrank parser-proven finality. The conductor wires this to a
   * tracker history scan (TurnTracker.hasFinalAnswer). Absent or null =
   * cannot say, and the working spare / timeout classification stand.
   */
  hasFinalAnswer?: (agentId: string, prompt: string, armedAt: number) => FinalTurnAnswer | null
  /**
   * Has the observer a native-file acceptance was predicated on actually
   * MATERIALIZED (Sol r3 P1-17)? A watchSpec is a path-shaped promise, not a
   * proven observer — a permanently wrong session ref computes a filename
   * that never appears. The conductor wires this to "sessionSync has a
   * verified reconcile for that terminal". The sweep interrupts native-file
   * dispatches still open past OBSERVER_PROBATION_MS whose observer never
   * went live. Absent = no probation (tests, memory-only services).
   */
  observerLive?: (agentId: string) => boolean
  /**
   * The record reached a terminal state — done, failed or interrupted, by any
   * path (turn correlation, failed delivery, sweep, hydrate, app quit). Called
   * exactly once per dispatch: the drain pin is released and the ordinary
   * quiet-clock owns the terminal again.
   */
  endWork: (agentId: string) => void
  /**
   * Append the record to the durable registry. MUST report failure — return
   * false (or throw) — never swallow it: the accept path refuses work it
   * cannot durably record, and transitions that fail must at least be loud.
   */
  persist: (record: DispatchRecord) => boolean
  /**
   * Append a pruned idempotency key's tombstone to the registry. Optional
   * like loadRecords: a memory-only service simply forgets keys at prune.
   */
  persistTombstone?: (tombstone: DispatchTombstone) => boolean
  /**
   * Every persisted transition, for rehydration at boot. Absent = a memory-only
   * service (tests); present = idempotency keys and dispatch history survive a
   * restart instead of treating the caller's retry as new work.
   */
  loadRecords?: () => DispatchRecord[]
  /** Tombstone lines from the registry, for rebuilding the key index at boot. */
  loadTombstones?: () => DispatchTombstone[]
  /**
   * Compact the physical registry file (Sol r4 P1). Called exactly once, at
   * the END of hydrate — after the restart interrupts and prune have landed
   * their rows, so dead weight is measured against the final live set — and
   * NEVER mid-run: the service appends while it runs, and a rewrite racing
   * an append loses rows. The conductor wires this to
   * `compactDispatchRegistry(defaultDispatchRegistry())`; absent = a
   * memory-only service (tests) with no file to bound.
   */
  compactRegistry?: () => void
  /**
   * Cheap backend liveness probe. Used ONLY to classify a failed delivery:
   * promptAgent failing while the server is provably gone is `interrupted`
   * (the world fell over), never `failed` (we could not deliver) — a caller
   * retries `failed` and must not retry an unknown. Absent = cannot say, so
   * the ordinary failed-path evidence rules apply.
   */
  backendAlive?: () => boolean
  /**
   * LAST RESORT: submit through a reattached single pane (the cmdAsk path).
   * The only PTY in the design. Absent = no fallback, and an undeliverable
   * dispatch fails loudly instead of being retried into the dark.
   *
   * `stillValid` (Sol r6 P0-2) is the delivery leg's own liveness — record
   * open, reservation held, lease held — and the wiring MUST thread it into
   * pasteAndSubmit, which consults it before EACH write: the paste and the
   * submitting CR are up to 1.5s apart, and a dispatch cancelled inside that
   * window must not be submitted by the later Enter. A wiring that ignores
   * the argument still typechecks but reopens exactly that hole.
   */
  reattachFallback?: (
    agentId: string,
    prompt: string,
    stillValid?: () => boolean
  ) => Promise<boolean>
  /**
   * The shared producer lease (Sol r6 P0-1). Defaults to the process-wide
   * instance — the only one that actually serializes, since askTerminal and
   * the tracker's PTY guard consult the same default. Injectable for tests.
   */
  lease?: ProducerLease
  newId?: () => string
  now?: () => number
  /** How long the native submission may block before it is a stall. */
  timeoutMs?: number
}

/** Default ceiling for one native submission. */
const DISPATCH_TIMEOUT_MS = 10 * 60 * 1000

/**
 * How long a native-file dispatch may run before its observer must have
 * MATERIALIZED (observerLive) — long enough for a fresh session file's first
 * write, short enough that a misbound session ref is not left for the
 * ten-minute sweep (Sol r3 P1-17).
 */
export const OBSERVER_PROBATION_MS = 60_000

/** Context headroom below which an agent silently swallows work. */
const CONTEXT_FULL_PERCENT = 98

/**
 * Chars of normalized prompt compared against the transcript tail — for the
 * SCREEN LANDING question only ("is the prompt on the pane?"). Short enough
 * to survive the TUI rewrapping its echo, long enough to tell two briefs at
 * the same agent apart. A prompt the TUI collapsed into a "[Pasted text #1 …]"
 * placeholder matches nothing at any length, and reads as unconfirmed — which
 * is the honest answer, not a reason to lengthen it.
 */
const LANDING_MATCH_CHARS = 24

const normalize = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * Normalized-PREFIX key, used by promptLanded and NOTHING else. The prefix
 * exists because the truncation there is physical — a pane echoes a bounded,
 * rewrapped rendering of the prompt, so a full compare against the screen
 * would call every long prompt undelivered. That physical excuse does not
 * extend to CLOSURE: a durable turn record and a delivered prompt both carry
 * the full text, and two briefs sharing their first 24 characters
 * ("Deploy the release after lunch" / "… after tests") must never consume
 * each other's dispatch stamp. Closure uses promptAnswersDispatch below,
 * which is full-identity.
 */
export function dispatchPromptKey(prompt: string): string {
  return normalize(prompt).slice(0, LANDING_MATCH_CHARS)
}

/**
 * Does this completed turn's prompt identify it as the dispatched one?
 *
 * Timestamp order says a turn COULD be the answer; only prompt identity says
 * it IS. A human ask racing the dispatch into the same agent also starts a
 * turn after armedAt, and closing on that turn would bill the caller for
 * somebody else's exchange. An empty dispatched prompt matches nothing —
 * there is no identity to prove.
 *
 * EXACT delivered bytes, no normalization (Sol r3 P0): a case- or
 * whitespace-sensitive brief — code, shell, YAML, a Make recipe — must never
 * collide with a normalized cousin, so the comparison is byte equality
 * against the prompt the dispatch actually delivered. Both closers compare
 * delivered text, never a rendered echo: the file closer reads the harness's
 * durable user record, and the scrape closer's prompt-of-record is the
 * delivered-prompt fact (noteDispatchDelivered) whenever one exists.
 *
 * THE IDENTITY INVARIANT this rests on: every producer at an armed terminal
 * is serialized — the HTTP producers (/input, /ask, /raw) answer 409 while a
 * stamp is armed, and local owner input PREEMPTS the dispatch (the tracker's
 * onOwnerPreempt → interrupt). So at most one turn carrying these exact
 * bytes can open after armedAt, and exact-bytes + the armedAt bound IS the
 * exchange identity. Lossy normalization survives only in promptFingerprint
 * (idempotency "same work" checks) and promptLanded (screen landing), where
 * the fuzz is the point, not a hole.
 */
export function promptAnswersDispatch(turnPrompt: string, dispatchedPrompt: string): boolean {
  if (dispatchedPrompt.length === 0) return false
  return turnPrompt === dispatchedPrompt
}

/**
 * Version marker on every fingerprint this build writes. v1 (the bare-hex
 * legacy) hashed a trimmed/lowercased/whitespace-collapsed prompt, which
 * aliased byte-distinct work — `build:\n\tmake all` and `BUILD: make all`
 * fingerprinted identically (Sol r4 P0-2). v2 hashes the EXACT request bytes.
 */
export const PROMPT_FINGERPRINT_VERSION = 'v2'

/**
 * Request fingerprint for idempotency-key reuse detection: sha256 over the
 * EXACT request bytes — no trim, no case fold, no whitespace collapse
 * (Sol r4 P0-2). Case and indentation are semantic in source, shell, YAML and
 * Make recipes, so one key fronting two byte-distinct briefs must be refused,
 * never silently replayed. Lossy normalization survives ONLY inside screen
 * landing detection (promptLanded), where the fuzz describes a rendering.
 * Stored on the record (and on the key's tombstone), so "same key, different
 * work" stays detectable for as long as the key itself is honored.
 */
export function promptFingerprint(prompt: string): string {
  return `${PROMPT_FINGERPRINT_VERSION}:${createHash('sha256').update(prompt, 'utf8').digest('hex')}`
}

/** A bare-hex legacy hash predates version markers — it is v1 by definition. */
function fingerprintVersion(hash: string): string {
  const colon = hash.indexOf(':')
  return colon === -1 ? 'v1' : hash.slice(0, colon)
}

/**
 * What an idempotency-key hit is allowed to DO, judged by fingerprints alone.
 */
export type FingerprintVerdict = 'replay' | 'conflict' | 'incomparable'

/**
 * Compare the fingerprint a held record (or tombstone) carries against the
 * incoming request's. The idempotency boundary FAILS CLOSED (Sol r5 P0-3):
 *
 * - 'replay'       — equality PROVEN (same version, same hash), or the retry
 *   carries no work bytes at all (an empty/mangled retry replays by the key's
 *   promise — with nothing to run, nothing can be mis-attributed).
 * - 'conflict'     — difference proven under one comparable scheme: the key
 *   fronts different work. 409, as ever.
 * - 'incomparable' — the held row's fingerprint cannot be measured against
 *   the incoming one (a lossy v1 hash vs an exact-bytes v2, any cross-version
 *   pair, or a row that predates fingerprints entirely). Equality is
 *   UNPROVABLE, and unprovable equality must never be treated as equality at
 *   a billing-grade idempotency boundary — the previous policy replayed
 *   another request's dispatch/result here for the whole 90-day migration
 *   window. The caller is told to mint a new key; the honest byte-exact
 *   retries of pre-upgrade work this refuses are the price of never serving
 *   somebody a result for bytes they did not send.
 */
export function fingerprintVerdict(
  held: string | undefined,
  incoming: string | undefined
): FingerprintVerdict {
  if (incoming === undefined) return 'replay'
  if (held === undefined) return 'incomparable'
  if (fingerprintVersion(held) !== fingerprintVersion(incoming)) return 'incomparable'
  return held === incoming ? 'replay' : 'conflict'
}

/**
 * Is this agent out of context?
 *
 * Measured 2026-08-13: a Claude session at 100% context reported herdr
 * `agent_status: "idle"` and swallowed a lane brief whole — exit 0, empty
 * output, no turn, nothing to correlate. The status feed cannot see it; the
 * pane's own footer can, and it is the only place the number appears. Anything
 * at or above CONTEXT_FULL_PERCENT is treated as full, because the last
 * percent buys a prompt that cannot be answered.
 */
export function contextExhausted(paneText: string | null): boolean {
  if (!paneText) return false
  for (const [, percent] of paneText.matchAll(/(\d{1,3})%\s*context\s*used/gi)) {
    if (Number(percent) >= CONTEXT_FULL_PERCENT) return true
  }
  return /context\s*(limit\s*reached|exhausted)/i.test(paneText)
}

/**
 * Does the transcript show the prompt actually arrived?
 *
 * Compared on a NORMALIZED PREFIX, never byte-for-byte: a TUI rewraps,
 * re-indents and truncates the text it echoes, so an exact compare would
 * report every long prompt as undelivered and send it a second time — the
 * precise failure F2 is about. A prefix that survives rewrapping is the
 * strongest claim the screen can actually support.
 */
export function promptLanded(paneText: string | null, prompt: string): boolean {
  if (!paneText) return false
  const needle = dispatchPromptKey(prompt)
  if (needle.length === 0) return false
  return normalize(paneText).includes(needle)
}

/** What the pane looked like either side of one submission attempt. */
export interface DeliveryEvidence {
  /** Capture taken immediately before the prompt went out. */
  before: string | null
  /** Capture taken after the backend reported. */
  after: string | null
  prompt: string
  /**
   * Is the agent NOT working? True = idle/done, false = working/blocked,
   * null = the backend has no lifecycle feed and cannot say.
   */
  idle: boolean | null
}

/**
 * Is there POSITIVE evidence the prompt never reached the agent?
 *
 * The inversion F3 asks for. "The transcript did not show the prompt" is not
 * evidence of non-delivery — a capture is bounded, a long turn scrolls the echo
 * away, and a paste the TUI collapsed into "[Pasted text #1]" was never on the
 * screen to begin with. Re-sending on the absence of proof is how a brief gets
 * submitted twice into a live agent.
 *
 * So a re-send needs all three of: the prompt is not on screen, the pane has
 * not moved since the submission (an agent that produced output did something),
 * and the lifecycle feed does not say the agent is busy. Any signal missing or
 * unreadable means NO re-send — the honest answer is `confirmed: false`.
 */
export function nonDeliveryProven(evidence: DeliveryEvidence): boolean {
  if (promptLanded(evidence.after, evidence.prompt)) return false
  // No view of the pane at all: nothing is proven, so nothing is re-sent.
  if (evidence.after === null || evidence.before === null) return false
  if (evidence.idle === false) return false
  return normalize(evidence.after) === normalize(evidence.before)
}

/**
 * An error that is safe to log.
 *
 * `execFile` builds its message from the full argv, so a failed
 * `herdr agent prompt <pane> <prompt>` carries the caller's ENTIRE brief —
 * frequently confidential text — into the app log and into the record's
 * `error` field, which is served over HTTP. Code, command head and prompt
 * LENGTH answer every operational question the full text would.
 */
export function describeSubmissionError(error: unknown, promptLength: number): string {
  const e = error as { code?: unknown; message?: unknown }
  const first = String(e?.message ?? error).split('\n')[0]
  const redacted = first.startsWith('Command failed:')
    ? `${first.split(/\s+/).slice(0, 5).join(' ')} …[args redacted]`
    : first
  const code = e?.code === undefined ? '' : `code=${String(e.code)} `
  return `${code}${redacted} (promptLength=${promptLength})`
}

/**
 * The `details` string a turn.completed event carries for a dispatched turn.
 * The ID and nothing else — the event log is metadata only, and the brief is
 * the caller's own text.
 */
export function turnDetails(dispatchId: string | undefined): string | undefined {
  return dispatchId === undefined ? undefined : `dispatch=${dispatchId}`
}

// ---- durable registry (~/.cookrew/dispatches.jsonl, append-only) ----

export function defaultDispatchRegistry(): string {
  return path.join(homedir(), '.cookrew', 'dispatches.jsonl')
}

/**
 * What actually goes on disk.
 *
 * The reply is DROPPED, for the reason it is dropped from the HTTP projection
 * (F4): it is the agent's full answer, and the dispatch ledger is a
 * correlation trace, not a second transcript store. `turnIndex` already points
 * at the turn that produced it, and the turn ledger — which is where replies
 * live, with its own retention and its own gate — can be asked. Keeping a copy
 * here meant every answer an API consumer ever received was duplicated into a
 * file with a different lifetime and no reader.
 *
 * `error` stays: it is already redacted of prompt text (describeSubmissionError)
 * and it is the only record of WHY a dispatch produced nothing.
 */
export function persistedRecord(record: DispatchRecord): DispatchRecord {
  // ledgerFault is a statement ABOUT the ledger, not a fact for it — a row
  // carrying it would be a durable copy of "this could not be made durable".
  const { reply, ledgerFault, ...row } = record
  return { ...row, ...(reply !== undefined || row.hasReply ? { hasReply: true } : {}) }
}

/**
 * What survives a pruned idempotency key. Dropping a closed record used to
 * take its key with it, so a caller's retry past the retention window quietly
 * became NEW work — the exact double-run the key exists to prevent. The
 * tombstone keeps only the (scope, key) → dispatchId binding and the prompt
 * fingerprint; everything else about the dispatch is gone by design, and the
 * replay response says so.
 */
export interface DispatchTombstone {
  kind: 'tombstone'
  /** Consumer-scoped idempotency key (idempotencyScope output). */
  scope: string
  dispatchId: string
  /**
   * The ACTUAL terminal state the record closed in. A tombstone that forgets
   * it fabricates outcomes on replay — a pruned `failed` answering `done`
   * tells the caller commissioned work succeeded when it did not. Absent only
   * on legacy lines written before this field existed; those replay as an
   * explicit closed/unknown projection, never as `done`.
   */
  state?: DispatchState
  /** Fingerprint of the original prompt, for key-reuse detection. */
  promptHash?: string
  /** When the record it stands for closed — the TTL clock. */
  closedAt: number
}

/**
 * How long a pruned key stays recognisable as a replay. Far past any sane
 * retry window, bounded so the index cannot grow for the life of the ledger.
 */
export const IDEMPOTENCY_TTL_MS = 90 * 24 * 60 * 60 * 1000

/**
 * One durable line, owner-only. The rows name agents, workspaces and the
 * shape of commissioned work, so the directory is created 0700 and the file
 * 0600 — and an existing file is chmod'ed on every append, because `mode`
 * applies at CREATE time only and this ledger predates the fix on every
 * machine that already ran it. Failure is REPORTED, not swallowed: the accept
 * path refuses work it cannot durably record.
 */
function appendRegistryLine(file: string, line: string): boolean {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const inherited = existsSync(file) ? statSync(file).mode & 0o777 : 0o600
    appendFileSync(file, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
    if (inherited !== 0o600) chmodSync(file, 0o600)
    return true
  } catch (error) {
    console.error('Dispatch registry write failed:', error)
    return false
  }
}

/**
 * Append one transition. Append-only on purpose: a dispatch ledger that
 * rewrites rows cannot answer "what did this look like when it closed",
 * and a crash mid-rewrite would lose the row entirely.
 */
export function appendDispatchRecord(file: string, record: DispatchRecord): boolean {
  return appendRegistryLine(file, JSON.stringify(persistedRecord(record)))
}

/** Append a pruned key's tombstone — same file, same tolerance, same modes. */
export function appendDispatchTombstone(file: string, tombstone: DispatchTombstone): boolean {
  return appendRegistryLine(file, JSON.stringify(tombstone))
}

/** Every persisted transition, oldest first. A torn line is skipped, not fatal. */
export function readDispatchRecords(file: string): DispatchRecord[] {
  return readRegistryLines(file, (parsed) =>
    typeof (parsed as DispatchRecord)?.id === 'string' ? (parsed as DispatchRecord) : null
  )
}

/** Every tombstone line, oldest first — record lines are somebody else's rows. */
export function readDispatchTombstones(file: string): DispatchTombstone[] {
  return readRegistryLines(file, (parsed) => {
    const tombstone = parsed as DispatchTombstone
    return tombstone?.kind === 'tombstone' && typeof tombstone.dispatchId === 'string'
      ? tombstone
      : null
  })
}

function readRegistryLines<T>(file: string, pick: (parsed: unknown) => T | null): T[] {
  try {
    if (!existsSync(file)) return []
    const rows: T[] = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const picked = pick(JSON.parse(line))
        if (picked !== null) rows.push(picked)
      } catch {
        // torn write — the next append lands cleanly after it
      }
    }
    return rows
  } catch (error) {
    console.error('Dispatch registry read failed:', error)
    return []
  }
}

// ---- registry compaction (Sol r4 P1: the physical ledger stays bounded) ----

/**
 * Compact when at least this fraction of the file's parseable lines are dead
 * weight (superseded transitions, buried records, expired tombstones)…
 */
export const REGISTRY_COMPACT_DEAD_FRACTION = 0.5
/** …or when the file has grown past this size with ANY dead weight at all. */
export const REGISTRY_COMPACT_MIN_BYTES = 4 * 1024 * 1024

/**
 * Where the rewrite lands before the atomic rename. Deterministic and in the
 * SAME directory as the registry (rename must not cross filesystems); a crash
 * between temp-write and rename leaves the original registry untouched and
 * the orphaned temp file is simply overwritten by the next compaction.
 */
export function compactionTempPath(file: string): string {
  return `${file}.compacting`
}

export interface RegistryCompaction {
  /** True when the file was actually rewritten. */
  rewritten: boolean
  /** Lines the live set needs (kept on rewrite; measured either way). */
  liveLines: number
  /** Parseable lines the live set does NOT need. */
  droppedLines: number
}

/**
 * Crash-safe compaction of the append-only registry (Sol r4 P1). Every
 * transition, buried record and expired tombstone used to stay in the file
 * forever: prune deleted only in-memory entries, so a commercial workload had
 * unbounded disk growth AND unbounded restart parsing (hydration re-reads the
 * whole file every boot).
 *
 * HYDRATE-TIME ONLY, never mid-run: the service appends while it runs, and a
 * rewrite racing an append would lose the appended row. The single-process
 * boundary at hydrate — before any dispatch is accepted — is the one moment
 * the file has exactly one writer with nothing in flight.
 *
 * PRESERVED, exactly one line each: every OPEN record (a reservation is never
 * dropped, however old), every closed record within RECORD_RETENTION_MS,
 * every closed-but-unburied record that still carries an idempotency key (the
 * key's promise lives on the record until prune lands its tombstone), and the
 * latest unexpired tombstone per scope. DROPPED: superseded transition lines
 * (only the last line per id is a record's current state), records already
 * superseded by an equal-or-newer burial (the tombstone is the survivor —
 * hydration would skip the row anyway), keyless closed records past
 * retention, and tombstones past IDEMPOTENCY_TTL_MS.
 *
 * ATOMIC AND DURABLE (Sol r5 P2): a stale temp from a crashed run is removed
 * before reuse (openSync's mode applies at CREATE only, so truncating an
 * existing permissive temp would keep — and then rename into place — its old
 * mode; fchmod on the open descriptor is the backstop when the remove cannot
 * land). Live lines go to the temp (0600, same directory), fsync'd, then
 * renamed over the registry, and the PARENT DIRECTORY is fsync'd after the
 * rename — without that the rename lives only in the directory's page cache
 * and power loss can resurrect the pre-compaction file. Any failure leaves
 * the original registry byte-identical; the temp file is best-effort unlinked
 * and the error is loud, never fatal.
 */
export function compactDispatchRegistry(
  file: string,
  now: number = Date.now()
): RegistryCompaction {
  const untouched = { rewritten: false, liveLines: 0, droppedLines: 0 }
  try {
    if (!existsSync(file)) return untouched
    const records = readDispatchRecords(file)
    const tombstones = readDispatchTombstones(file)
    const totalLines = records.length + tombstones.length

    // Append-only means the LAST line per id is the record's current state.
    const lastById = new Map<string, { row: DispatchRecord; at: number }>()
    records.forEach((row, at) => lastById.set(row.id, { row, at }))
    // Latest tombstone per scope — an older duplicate says nothing newer.
    const latestByScope = new Map<string, { row: DispatchTombstone; at: number }>()
    tombstones.forEach((row, at) => {
      const held = latestByScope.get(row.scope)
      if (held === undefined || row.closedAt >= held.row.closedAt) {
        latestByScope.set(row.scope, { row, at })
      }
    })

    const retentionCutoff = now - RECORD_RETENTION_MS
    const keptRecords = [...lastById.values()].filter(({ row }) => {
      if (!TERMINAL_STATES.has(row.state)) return true
      const scope =
        row.idempotencyKey !== undefined
          ? idempotencyScope(row.consumer, row.idempotencyKey)
          : null
      const buried = scope !== null ? latestByScope.get(scope)?.row : undefined
      // An equal-or-newer burial supersedes the row entirely (hydration's own
      // rule): the tombstone is the survivor — and when the tombstone has
      // expired too, both are gone and no suppression is needed, because the
      // record no longer exists to be wrongly resurrected.
      if (buried !== undefined && buried.closedAt >= row.updatedAt) return false
      // Closed past retention: droppable only when it carries no key — a
      // keyed record whose burial never landed is still the key's only
      // carrier, and dropping it would silently re-run replayed work.
      if (row.updatedAt < retentionCutoff && scope === null) return false
      return true
    })
    const tombstoneExpiry = now - IDEMPOTENCY_TTL_MS
    const keptTombstones = [...latestByScope.values()].filter(
      ({ row }) => row.closedAt >= tombstoneExpiry
    )

    const liveLines = keptRecords.length + keptTombstones.length
    const droppedLines = totalLines - liveLines
    if (droppedLines <= 0) return { rewritten: false, liveLines, droppedLines: 0 }
    const deadFraction = totalLines === 0 ? 0 : droppedLines / totalLines
    if (
      deadFraction < REGISTRY_COMPACT_DEAD_FRACTION &&
      statSync(file).size < REGISTRY_COMPACT_MIN_BYTES
    ) {
      return { rewritten: false, liveLines, droppedLines }
    }

    // Original file order preserved (by each survivor's last line position):
    // reload semantics are order-sensitive only in that later lines supersede
    // earlier ones, and every survivor now appears exactly once.
    const lines = [
      ...keptRecords.sort((a, b) => a.at - b.at).map(({ row }) => JSON.stringify(row)),
      ...keptTombstones.sort((a, b) => a.at - b.at).map(({ row }) => JSON.stringify(row))
    ]
    const tmp = compactionTempPath(file)
    // Prefer a FRESH temp over reusing a validated-stale one (Sol r5 P2): a
    // crashed run's leftover may carry a permissive mode that `openSync(...,
    // 'w', 0600)` cannot repair — mode applies at create time only.
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp)
      } catch {
        // cannot remove: the fchmod below repairs the inherited mode instead
      }
    }
    const fd = openSync(tmp, 'w', 0o600)
    try {
      // Repair on the DESCRIPTOR, so the mode is right on the very inode the
      // rename will install — a stale temp that survived the unlink above
      // must not become a world-readable registry.
      fchmodSync(fd, 0o600)
      if (lines.length > 0) writeSync(fd, `${lines.join('\n')}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      renameSync(tmp, file)
    } catch (error) {
      // The original registry is still byte-identical — only the temp is
      // stale. Drop it (best effort) and report the failure loudly.
      try {
        unlinkSync(tmp)
      } catch {
        // the orphan is removed (or repaired) by the next compaction attempt
      }
      throw error
    }
    // Durable rename (Sol r5 P2): fsync the PARENT DIRECTORY so the new
    // directory entry survives power loss — the temp's own fsync made the
    // DATA durable, not the name pointing at it. Best-effort and loud: the
    // rewrite itself already succeeded, and reporting it as failed would lie
    // about the registry's (correct) contents.
    try {
      const dirFd = openSync(path.dirname(file), 'r')
      try {
        fsyncSync(dirFd)
      } finally {
        closeSync(dirFd)
      }
    } catch (error) {
      console.error('Dispatch registry directory fsync failed (rename not yet durable):', error)
    }
    return { rewritten: true, liveLines, droppedLines }
  } catch (error) {
    console.error('Dispatch registry compaction failed (registry left as-is):', error)
    return untouched
  }
}

const TERMINAL_STATES: ReadonlySet<DispatchState> = new Set(['done', 'failed', 'interrupted'])

/**
 * State-strength axis of the terminal-intent lattice (Sol r3 P0-3): `done`
 * outranks `failed`, which outranks `interrupted`. Consulted only BETWEEN
 * intents of equal authority — state strength never overrules provenance.
 * Non-terminal states rank below everything, though nothing non-terminal
 * ever reaches the comparison.
 */
const EVIDENCE_STRENGTH: Readonly<Record<DispatchState, number>> = {
  done: 3,
  failed: 2,
  interrupted: 1,
  running: 0,
  submitted: 0
}

/** A terminal intent held while its append fails: the row plus who proved it. */
interface ParkedIntent {
  record: DispatchRecord
  evidence: TerminalEvidence
}

/**
 * Compare two terminal intents — AUTHORITY FIRST (Sol r5 P1). Parser evidence
 * is the durable record's own verdict on how the answering turn ended,
 * carrying that turn's identity; infrastructure evidence describes the
 * machinery around it. Billing-grade authority dominates at ANY state: a
 * parser-proven `interrupted` parked on a ledger fault must survive a later
 * infrastructure `failed`, even though `failed` is the stronger-LOOKING state
 * label — the previous stateStrength-first ranking let exactly that
 * replacement lose the turn's outcome and identity. Only at EQUAL authority
 * does state strength decide; equal authority AND state is a deterministic
 * merge. Positive = the parked intent wins (newcomer discarded); negative =
 * the newcomer wins (intent replaced); zero = the newcomer lands but MERGES
 * the parked intent's metadata (turnIndex/uuid/reply) rather than erasing
 * evidence it does not itself carry.
 */
export function compareTerminalIntents(
  parked: { state: DispatchState; evidence: TerminalEvidence },
  next: { state: DispatchState; evidence: TerminalEvidence }
): number {
  const authority = (evidence: TerminalEvidence): number => (evidence === 'parser' ? 1 : 0)
  const byAuthority = authority(parked.evidence) - authority(next.evidence)
  if (byAuthority !== 0) return byAuthority
  return EVIDENCE_STRENGTH[parked.state] - EVIDENCE_STRENGTH[next.state]
}

/** Equal-evidence merge: keep the parked row's answering-turn identity. */
function mergeTerminalMeta(parked: DispatchRecord, next: DispatchRecord): DispatchRecord {
  return {
    ...next,
    ...(next.turnIndex === undefined && parked.turnIndex !== undefined
      ? { turnIndex: parked.turnIndex }
      : {}),
    ...(next.turnUuid === undefined && parked.turnUuid !== undefined
      ? { turnUuid: parked.turnUuid }
      : {}),
    ...(next.reply === undefined && parked.reply !== undefined ? { reply: parked.reply } : {}),
    ...(next.hasReply === undefined && parked.hasReply !== undefined
      ? { hasReply: parked.hasReply }
      : {})
  }
}

/**
 * How long a CLOSED dispatch stays in memory. Long enough that a caller's
 * retry of a week-old key is still recognised as a replay rather than run
 * again; short enough that the maps do not grow for the life of the process.
 */
const RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Hard ceiling, for a machine that dispatches faster than the window expires. */
const MAX_RECORDS = 5000

function idempotencyScope(consumer: string | undefined, idempotencyKey: string): string {
  return `${consumer ?? ''}\u0000${idempotencyKey}`
}

/**
 * How long a dispatch may sit with no transition before the sweep closes it.
 *
 * The same ceiling one submission is allowed (DISPATCH_TIMEOUT_MS), because it
 * is the same promise: past it, nobody is waiting on this any more. The states
 * this catches are the ones with no other end — `submitted` with the prompt
 * unconfirmed, or `running` whose turn never completed (the agent was killed,
 * the harness rotated, the turn was rewound). Nothing else ever closes them,
 * so the agent's slot stayed held for the life of the process.
 */
const STALE_DISPATCH_MS = DISPATCH_TIMEOUT_MS

export class DispatchService {
  private readonly records = new Map<string, DispatchRecord>()
  /** agentId → the dispatch currently holding that agent's slot. */
  private readonly reserved = new Map<string, string>()
  /** consumer + idempotencyKey → dispatchId, so one tenant cannot shadow another. */
  private readonly byKey = new Map<string, string>()
  /** scope → tombstone: keys whose records are pruned but whose promise is not. */
  private readonly tombstones = new Map<string, DispatchTombstone>()
  /** dispatchId → the async delivery leg, for tests and for shutdown. */
  private readonly inFlight = new Map<string, Promise<void>>()
  /**
   * dispatchIds whose queued delivery was ABORTED (Sol r5 P0-2): an owner
   * preemption, backend death, node removal or sweep settled/parked the
   * record while its delivery leg sat queued on the setImmediate hop or
   * blocked inside promptAgent. The leg revalidates against this (plus record
   * openness and reservation ownership) immediately before every irreversible
   * prompt write; entries live only as long as the leg itself (cleared with
   * inFlight), so the set is bounded by concurrent deliveries.
   */
  private readonly cancelledDeliveries = new Set<string>()
  /**
   * dispatchId → the AbortController for its blocking native submission
   * (Sol r8 P1). cancelDelivery fires it alongside the token above: the
   * token stops writes that have not happened yet, the abort KILLS the CLI
   * child already blocking inside promptAgent — interrupt, release, terminal
   * retirement and backend death all reach both through the same choke
   * point. Bounded by in-flight legs: set immediately before promptAgent,
   * deleted in its finally.
   */
  private readonly deliveryAborts = new Map<string, AbortController>()
  /**
   * dispatchId → the terminal row whose durable append failed (commitTerminal)
   * plus the PROVENANCE that decided it (Sol r4 P1). The record it belongs to
   * is held open with a ledgerFault mark; every sweep pass retries the append,
   * and the release fires when — and only when — a row lands.
   */
  private readonly ledgerFaults = new Map<string, ParkedIntent>()
  /**
   * dispatchId → in-memory facts about an OPEN dispatch that never touch the
   * ledger: the exact delivered prompt (privacy — rows carry only its hash),
   * the arming time, and the observer grade beginWork installed. The sweep
   * needs all three (hasFinalAnswer, observer probation); cleared on release.
   * A hydrated open record has no entry — hydration interrupts it anyway.
   */
  private readonly openMeta = new Map<
    string,
    { prompt: string; armedAt: number; grade: ObserverGrade }
  >()

  /**
   * The per-terminal producer lease the delivery legs hold across their
   * irreversible submissions (Sol r6 P0-1) — shared with every other
   * producer via the process-wide default.
   */
  private readonly lease: ProducerLease

  constructor(private readonly deps: DispatchDeps) {
    this.lease = deps.lease ?? defaultProducerLease()
    this.hydrate()
  }

  /**
   * Rebuild state from the ledger (F5).
   *
   * Memory-only records made every restart an amnesia event: the same
   * idempotencyKey minted a SECOND dispatch, and a caller polling for the
   * answer to commissioned work got a 404. The ledger is append-only, so the
   * last row for an id is its current state.
   *
   * Anything still open belonged to a process that no longer exists — nothing
   * is watching that turn and no correlation can arrive. That is `interrupted`
   * by its own definition ("we delivered it and the world fell over"), never
   * `failed`, because the agent may well have done the work. Routed through
   * update() so the close releases like every other terminal transition —
   * endWork included, which unpin tolerates for a pin the dead process held.
   */
  private hydrate(): void {
    // Tombstones first, records second: a scope that somehow has both is
    // answered from the LIVE record, which still knows its state and turn.
    const expired = this.now() - IDEMPOTENCY_TTL_MS
    const buried = new Map<string, number>()
    for (const tombstone of this.deps.loadTombstones?.() ?? []) {
      // The SUPPRESSION view keeps every line, expired included (Sol r3
      // P1-13): a record already superseded by a tombstone must never be
      // re-loaded as live and re-buried — that appended a duplicate tombstone
      // per restart and re-parsed the full commercial history forever. The
      // REPLAY view below stays TTL-bounded as before.
      buried.set(
        tombstone.scope,
        Math.max(buried.get(tombstone.scope) ?? -Infinity, tombstone.closedAt)
      )
      if (tombstone.closedAt < expired) continue
      this.tombstones.set(tombstone.scope, tombstone)
    }
    const rows = this.deps.loadRecords?.() ?? []
    for (const row of rows) {
      if (typeof row?.id !== 'string') continue
      if (row.idempotencyKey !== undefined) {
        const scope = idempotencyScope(row.consumer, row.idempotencyKey)
        // An equal-or-newer tombstone for this scope supersedes the row
        // entirely (bury stamps closedAt = the record's own updatedAt, so
        // equality is the normal case): the record was pruned and buried by
        // an earlier life, and reloading it would only re-bury it.
        const closedAt = buried.get(scope)
        if (closedAt !== undefined && closedAt >= row.updatedAt) continue
        this.byKey.set(scope, row.id)
      }
      this.records.set(row.id, row)
    }
    for (const record of [...this.records.values()]) {
      if (TERMINAL_STATES.has(record.state)) continue
      // Reserve BEFORE attempting the interrupt transition (Sol r3 P0-4): if
      // the append fails, commitTerminal holds the record open with a ledger
      // fault — and a fail-closed fault must not admit new work beside it,
      // so the agent answers 409 busy until the terminal row durably lands
      // (release() is what drops this reservation, exactly then).
      this.reserved.set(record.agentId, record.id)
      this.update(record.id, {
        state: 'interrupted',
        error: 'interrupted: the app restarted while this dispatch was open'
      })
    }
    // Belt to that brace: the loop above closes everything a restart left
    // open, so this finds nothing today — but the sweep is the contract for
    // "an open record too old to still be real", and hydrate is the one moment
    // the process has a full view of them.
    this.sweep()
    this.prune()
    // Registry compaction LAST (Sol r4 P1): the interrupts and burials above
    // have appended their rows, so the file now holds the full live set plus
    // every line it no longer needs — the one safe, single-writer moment to
    // rewrite it. A failing dep must not take hydration down with it.
    try {
      this.deps.compactRegistry?.()
    } catch (error) {
      console.error('Dispatch registry compaction hook failed:', error)
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  get(dispatchId: string): DispatchRecord | undefined {
    return this.records.get(dispatchId)
  }

  /**
   * GET /api/dispatches/:id — the lifecycle, WITHOUT the reply (F4).
   *
   * The reply is the agent's full answer. It reaches its owner through the
   * turn ledger, which is behind the same pairing gate as everything else that
   * carries agent output; re-serving it from a dispatch id turned one leaked id
   * into a transcript read. `hasReply` keeps the poll useful without the text.
   *
   * `requester` is the principal the ROUTE derived from its auth (never from
   * the caller's body). 'owner' sees everything — including in-process callers,
   * which default to it; any other principal sees only its own records, and a
   * foreign id answers 404, not 403: confirming that somebody else's dispatch
   * id EXISTS is itself a disclosure.
   */
  lookup(dispatchId: string, requester: string = 'owner'): DispatchResponse {
    const record = this.records.get(dispatchId)
    if (!record) return { status: 404, body: { error: 'no such dispatch' } }
    if (requester !== 'owner' && record.consumer !== requester) {
      return { status: 404, body: { error: 'no such dispatch' } }
    }
    const { reply, ...projection } = record
    return {
      status: 200,
      // `hasReply` outlives the text: after a restart the reply is gone from
      // memory and was never on disk, but the turn that produced it still is.
      body: { ...projection, hasReply: reply !== undefined || record.hasReply === true }
    }
  }

  /** Resolves when the delivery leg for this dispatch has settled. */
  async settled(dispatchId: string): Promise<void> {
    await this.inFlight.get(dispatchId)
  }

  /**
   * POST /api/agents/:id/dispatch — reserve, then deliver out of band.
   *
   * Returns 202 as soon as the slot is held, because the native submission
   * blocks for the whole turn and an HTTP request must not. The dispatch id is
   * the handle: GET /api/dispatches/:id is where the answer shows up.
   */
  async dispatch(agentId: string, input: DispatchInput): Promise<DispatchResponse> {
    // The caller's EXACT bytes, delivered as sent (Sol r4 P0-2): trimming
    // before delivery meant the ledger fingerprinted (and the agent received)
    // something other than the request — indentation and edges are semantic
    // in code, shell and Make briefs. Emptiness is still judged on substance.
    const prompt = input.text ?? input.brief ?? ''
    // Fingerprinted before any refusal: the replay lookup needs it, and it
    // exists only when there is a prompt to fingerprint — an empty retry can
    // still replay by key, it just cannot prove or disprove sameness.
    const promptHash = prompt.trim().length > 0 ? promptFingerprint(prompt) : undefined

    // A REPLAY outruns EVERY refusal below — busy, 404 and 400 included. The
    // retry a flaky network produces can arrive while the original is still
    // in flight, after the agent was deleted, or with a mangled empty body,
    // and the honest answer is still "that work exists, here is its id" — an
    // error would tell the caller to re-send its own work.
    const key = input.idempotencyKey
    const scopedKey = key === undefined ? undefined : idempotencyScope(input.consumer, key)
    if (scopedKey !== undefined) {
      const reused = { error: 'idempotency key reused for different work' }
      // Cross-version/pre-fingerprint rows FAIL CLOSED (Sol r5 P0-3): a
      // replay is a claim of proven equality, and a lossy v1 hash cannot
      // prove a v2 exact-bytes request is the same work — refusing with a
      // clear instruction beats silently answering with another request's
      // dispatch.
      const stale = { error: 'idempotency key predates exact-byte fingerprints — use a new key' }
      const existing = this.byKey.get(scopedKey)
      if (existing !== undefined) {
        const held = this.records.get(existing)
        // Same key fronting a DIFFERENT brief is a caller bug: replaying
        // would hand back a result for a prompt this caller did not send, and
        // running it would break the key's promise. Same-version equality
        // replays; same-version difference is 409; anything UNPROVABLE
        // (pre-upgrade rows, missing or lossy-v1 — fingerprintVerdict) is
        // refused rather than replayed on faith.
        const verdict = fingerprintVerdict(held?.promptHash, promptHash)
        if (verdict === 'conflict') return { status: 409, body: reused }
        if (verdict === 'incomparable') return { status: 409, body: stale }
        return { status: 200, body: { dispatchId: existing, replay: true } }
      }
      const tombstone = this.tombstones.get(scopedKey)
      if (tombstone !== undefined) {
        const verdict = fingerprintVerdict(tombstone.promptHash, promptHash)
        if (verdict === 'conflict') return { status: 409, body: reused }
        if (verdict === 'incomparable') return { status: 409, body: stale }
        // The record itself is pruned: the id, how it closed and "it closed"
        // are ALL that is still known — turnIndex, agent, timings went with
        // the record, and `tombstone: true` says so instead of faking a
        // fuller answer. The STATE is replayed exactly as buried: a pruned
        // `failed` must never replay as success. A legacy tombstone that
        // predates the state field cannot know, and says so — closed with an
        // unknown outcome — rather than fabricating `done`.
        return {
          status: 200,
          body: {
            dispatchId: tombstone.dispatchId,
            ...(tombstone.state !== undefined
              ? { state: tombstone.state }
              : { state: 'closed', outcome: 'unknown' }),
            replay: true,
            tombstone: true
          }
        }
      }
    }

    const agent = this.deps.resolveAgent(agentId)
    if (!agent) return { status: 404, body: { error: 'no such agent' } }
    if (prompt.trim().length === 0) {
      return { status: 400, body: { error: 'dispatch needs a brief or text' } }
    }

    const held = this.reserved.get(agentId)
    if (held !== undefined) {
      return { status: 409, body: { error: 'busy', dispatchId: held } }
    }

    // INPUT-BUFFER OWNERSHIP at admission (Sol r8 P0-1): the owner has
    // meaningful typed bytes sitting in the shared input box. Admitting now
    // and delivering later would paste the brief BESIDE that half-typed text
    // — the eventual submit carries both, destroying prompt identity for
    // both producers. Refused before anything is recorded; the caller
    // retries once the owner submits or clears.
    if (this.deps.ownerComposing?.(agentId) === true) {
      return { status: 409, body: { error: 'owner is composing — the input box is theirs' } }
    }

    // The ONLY backend question admission asks (Sol r3 P1-15): existence. The
    // conductor answers it from a cached inventory, never a synchronous fork.
    // The context-full check moved to the deliver() leg — it needs a pane
    // capture, and a capture on the accept path made every 202 wait on a CLI
    // process. Context-full is therefore a prompt-DELIVERY failure now
    // (state 'failed', reason 'context-full'), not a sync 503.
    const sessionName = this.deps.sessionNameFor(agentId)
    if (!this.deps.sessionExists(sessionName)) {
      return { status: 503, body: { error: 'unreachable' } }
    }
    if (!this.deps.promptAgent && !this.deps.submitAgent) {
      return { status: 503, body: { error: 'backend cannot dispatch' } }
    }

    const id = (this.deps.newId ?? randomUUID)()
    // Stamp the correlation BEFORE the record exists, let alone the prompt: a
    // fast agent can finish its turn inside the submission call, and a dispatch
    // id applied afterwards would miss its own turn. A refusal here means the
    // tracker still holds a LIVE stamp for this agent — a dispatch we have no
    // reservation for — so this one is refused before anything is recorded.
    if (!this.deps.noteDispatch(agentId, id, prompt)) {
      return { status: 409, body: { error: 'busy' } }
    }

    const at = this.now()
    const record: DispatchRecord = {
      id,
      agentId,
      agentName: agent.name,
      workspaceId: agent.workspaceId,
      state: 'submitted',
      via: null,
      createdAt: at,
      updatedAt: at,
      ...(key !== undefined ? { idempotencyKey: key } : {}),
      ...(input.consumer !== undefined ? { consumer: input.consumer } : {}),
      ...(promptHash !== undefined ? { promptHash } : {})
    }
    this.reserved.set(agentId, record.id)
    // Accepted only if OBSERVABLE: bring the tracking up BEFORE the prompt
    // goes out (v5 A4) — the session-file watch and the drain pin must exist
    // before the turn they are there to observe, or a fast agent's answer
    // lands in an unwatched file. And when NO observer can be installed at
    // all, refuse rather than accept: a pin with no watch is a dispatch only
    // the ten-minute sweep would ever close, which is a timeout pretending to
    // be an answer. Roll back completely — no reservation, no stamp, no row.
    const installed = this.deps.beginWork(agentId)
    if (installed === false) {
      this.reserved.delete(agentId)
      this.deps.clearDispatch?.(agentId, id)
      return { status: 503, body: { error: 'agent has no durable observer' } }
    }
    // Legacy boolean wirings read as 'scrape' — the fail-closed grade: an
    // owner dispatch proceeds, a consumer's is refused until the wiring
    // reports what it actually installed.
    const grade: ObserverGrade = installed === true ? 'scrape' : installed
    // Sol r3 P0-5: a non-owner consumer's settlement needs durable native
    // finality. A scrape-grade acceptance closes on screen quiescence, which
    // is owner-grade evidence — good enough for the person at the keyboard,
    // never for billing a third party. Refuse BEFORE any row exists, and
    // unwind what beginWork installed (endWork, exactly once).
    if (input.consumer !== undefined && input.consumer !== 'owner' && grade !== 'native-file') {
      this.reserved.delete(agentId)
      this.deps.clearDispatch?.(agentId, id)
      this.deps.endWork(agentId)
      return { status: 503, body: { error: 'consumer dispatch needs native file finality' } }
    }
    // Durability before delivery: the submitted row must be ON DISK before
    // the prompt can go out, or a crash in the gap runs work the ledger never
    // heard of and a replayed key re-runs it. On failure, unwind everything —
    // beginWork's effects via endWork, exactly once — and refuse.
    this.records.set(record.id, record)
    if (!this.persistRecord(record)) {
      this.records.delete(record.id)
      this.reserved.delete(agentId)
      this.deps.clearDispatch?.(agentId, id)
      this.deps.endWork(agentId)
      return { status: 503, body: { error: 'dispatch ledger unavailable' } }
    }
    if (scopedKey !== undefined) this.byKey.set(scopedKey, record.id)
    this.openMeta.set(record.id, { prompt, armedAt: at, grade })

    // The reservation is NOT released here (F6). Submission settles
    // milliseconds after the prompt goes out and the agent then works for
    // minutes; a second dispatch accepted in that window overwrites the
    // tracker's stamp, so B closes with A's turn and A never closes at all.
    // The slot is held until the record reaches a terminal state.
    //
    // Started on a setImmediate, not inline: deliver()'s first act is a deep
    // capture and the backend implements captures with synchronous CLI calls,
    // so an inline start made the 202 wait on pane reads it does not need.
    // The macrotask hop lets the response leave first; the admission reads
    // above (sessionExists, the context-full capture) are still synchronous —
    // that is the conductor's caching seam, not this one.
    this.inFlight.set(
      record.id,
      new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => this.deliver(record.id, agentId, sessionName, prompt, at))
        .finally(() => {
          this.inFlight.delete(record.id)
          // The abort token dies with its leg — the set stays bounded by
          // whatever is actually in flight (Sol r5 P0-2).
          this.cancelledDeliveries.delete(record.id)
        })
    )

    return {
      status: 202,
      body: { dispatchId: record.id, state: 'submitted' }
    }
  }

  /**
   * Deliver, then decide what the outcome actually means.
   *
   * TWO SUBMISSION MODES (Sol r9 P1-3). With `submitAgent` wired, the leg
   * submits at ACKNOWLEDGEMENT grade: the lease covers only the
   * bytes-in-flight window, 'submitted' closes the delivery phase
   * immediately (the record runs; transcript correlation and the sweep
   * observe the turn's end outside any lease), and only 'failed' — herdr
   * positively refused — falls through to the landing evidence below.
   * Without it, `promptAgent --wait` remains: `done` is herdr watching the
   * turn end — the strongest answer available — and EVERY other outcome,
   * `failed` included, is read against the transcript first (F2): herdr
   * submits and THEN waits, so a wait that times out or a server that dies
   * mid-wait both report a failure over a prompt that is already sitting in
   * the agent's input box. Only `done` skips the check, because only `done`
   * cannot be improved on.
   */
  private async deliver(
    dispatchId: string,
    agentId: string,
    sessionName: string,
    prompt: string,
    armedAt: number
  ): Promise<void> {
    const submitAgent = this.deps.submitAgent
    const promptAgent = this.deps.promptAgent
    if (submitAgent === undefined && promptAgent === undefined) return
    // Every delivery fact carries its arming generation (Sol r5 P1), so the
    // tracker can tell THIS exchange's confirmation from a stale echo of a
    // settled one.
    const gen: DispatchGeneration = { dispatchId, armedAt }
    // Cancelled while still queued (Sol r5 P0-2)? The interrupt/release that
    // aborted this leg already owns the record's outcome — assert NOTHING,
    // not even context-full: a 'failed' from a cancelled leg would challenge
    // the canceller's parked intent on the lattice.
    if (!this.deliveryLive(dispatchId, agentId)) return
    // Context-full is checked HERE, not at admission (Sol r3 P1-15): it needs
    // a pane capture, and captures are synchronous CLI forks the 202 must not
    // wait on. A full agent swallows prompts whole (measured 2026-08-13:
    // herdr said idle, the brief vanished), so refusing to deliver is the
    // honest outcome — a delivery FAILURE the caller can act on, using the
    // plain screen capture on purpose (a deep one can dredge up a stale
    // "100% context used" footer from before a /compact).
    if (contextExhausted(this.deps.capture(sessionName))) {
      this.update(dispatchId, { state: 'failed', error: 'context-full' })
      return
    }
    // The pre-submission screen, so "did anything happen after we submitted?"
    // is answerable later. Taken here rather than in dispatch() so it is the
    // last look before the prompt goes out — and taken ONCE: this capture and
    // the single post-submission one below are the only pane reads this leg
    // makes, reused by every question that follows.
    const before = this.deepCapture(sessionName)
    // The ATTEMPTED-delivery fact goes to the tracker BEFORE the blocking
    // native submission (Sol r4 P1): herdr `agent prompt` blocks until the
    // agent leaves working, so a fact registered only on return can arrive
    // after an attached scrape already opened AND settled the turn — whose
    // collapsed/absent echo then left its prompt-of-record unprovable and the
    // dispatch stranded. Registered against the armed generation; retracted
    // below only on POSITIVE proof of non-delivery.
    this.deps.noteDelivered?.(agentId, prompt, gen)
    // THE PRODUCER LEASE (Sol r6 P0-1), acquired BEFORE the first
    // irreversible byte and held through submission acknowledgement
    // (promptAgent resolving). The r5 deliveryLive check saw only dispatch
    // state; an owner ask already inside its own blocking promptAgent was
    // invisible to it, and this leg would have submitted a second producer's
    // bytes beside the owner's. An owner-held lease refuses the delivery
    // honestly — 'failed', so the caller knows the prompt never went out and
    // may retry once the owner's submission settles.
    //
    // A CONTAMINATED input buffer (Sol r7 P0-1) refuses the delivery the
    // same way: a cancelled producer's paste is stranded in the shared input
    // box, and a native submission — herdr types into that same box — would
    // carry it. The dispatch fails honestly until the owner clears the box.
    const holder: ProducerHolder = { kind: 'dispatch', dispatchId }
    if (this.lease.isContaminated(agentId)) {
      this.deps.retractDelivered?.(agentId, prompt, gen)
      this.update(dispatchId, {
        state: 'failed',
        error: CONTAMINATED_REFUSAL
      })
      return
    }
    if (this.lease.acquire(agentId, holder) !== 'acquired') {
      this.deps.retractDelivered?.(agentId, prompt, gen)
      this.update(dispatchId, {
        state: 'failed',
        error: 'an owner submission was in flight at delivery time'
      })
      return
    }
    // The LAST revalidation before the irreversible submission (Sol r5 P0-2),
    // in the same synchronous stretch as the write itself — no await sits
    // between this check and promptAgent, so nothing can settle the record in
    // between. A leg that lost its record, its reservation or its token here
    // retracts ONLY its own attempted fact and writes no prompt.
    if (!this.deliveryLive(dispatchId, agentId)) {
      this.lease.release(agentId, holder)
      this.deps.retractDelivered?.(agentId, prompt, gen)
      return
    }
    // OWNER COMPOSING, revalidated in the same synchronous stretch (Sol r8
    // P0-1): admission answered 202 with a clean box, but a compose that
    // started since would make this submission append the brief to the
    // owner's half-typed text. That cancels the delivery like an interrupt —
    // the attempted fact is retracted (nothing went out) and the record
    // closes 'interrupted', never 'failed': re-sending on top of a composing
    // owner is the exact combined-submit this guard exists to prevent.
    if (this.deps.ownerComposing?.(agentId) === true) {
      this.lease.release(agentId, holder)
      this.deps.retractDelivered?.(agentId, prompt, gen)
      this.update(dispatchId, {
        state: 'interrupted',
        error: 'interrupted: owner took the input box'
      })
      return
    }
    // The abort seam (Sol r8 P1): cancellation paths — interrupt, release,
    // retirement, backend death — fire this controller via cancelDelivery,
    // and a wiring that threads the signal into execFile kills the blocking
    // CLI child NOW instead of at the ten-minute timeout. Bounded by
    // in-flight legs: the entry dies in the finally below.
    const abort = new AbortController()
    this.deliveryAborts.set(dispatchId, abort)
    let outcome: 'done' | 'submitted' | 'failed'
    try {
      // The ack mode when the backend has it (Sol r9 P1-3): the await under
      // this lease hold ends at submission acknowledgement, not at turn
      // completion — the lease refuses desktop bytes for milliseconds.
      outcome =
        submitAgent !== undefined
          ? await submitAgent(
              sessionName,
              prompt,
              this.deps.timeoutMs ?? DISPATCH_TIMEOUT_MS,
              abort.signal
            )
          : await promptAgent!(
              sessionName,
              prompt,
              this.deps.timeoutMs ?? DISPATCH_TIMEOUT_MS,
              abort.signal
            )
    } catch (error) {
      outcome = 'failed'
      // An aborted child is the canceller's doing, not a submission fault —
      // the generation/liveness checks below own what happens next, and the
      // error log would only smear a deliberate kill as a failure.
      if (!abort.signal.aborted) {
        console.error('Dispatch submission threw:', describeSubmissionError(error, prompt.length))
      }
    } finally {
      this.deliveryAborts.delete(dispatchId)
      // Submission acknowledged (or the attempt settled): the bytes-in-flight
      // window is over, and the TURN the submission opened is guarded by the
      // reservation, not the lease. A hold seized mid-flight by a committed
      // owner preemption makes this a holder-mismatch no-op.
      this.lease.release(agentId, holder)
    }

    if (!this.deliveryLive(dispatchId, agentId)) {
      // The record settled (or parked a terminal intent) while promptAgent
      // blocked — whoever settled it owns the outcome. The submission DID
      // happen, so on a positive `done` the delivered fact is still true and
      // is confirmed under its generation (the tracker no-ops a settled
      // generation — Sol r5 P1); everything else this leg could say is a
      // weaker observation about an exchange that is already history, and a
      // fallback re-send here would type a cancelled brief beside the owner's
      // work.
      if (outcome === 'done') this.deps.noteDelivered?.(agentId, prompt, gen)
      return
    }

    if (outcome === 'done') {
      // Delivered and observed. The turn correlation still closes the record —
      // `done` from the backend says the agent stopped, not what it produced.
      // Confirmed delivery = the tracker learns the exact delivered text, so
      // scrape closure can prove prompt identity without trusting the echo.
      this.deps.noteDelivered?.(agentId, prompt, gen)
      this.update(dispatchId, { state: 'running', via: 'herdr', confirmed: true })
      return
    }

    if (submitAgent !== undefined && outcome === 'submitted') {
      // Acknowledged submission (Sol r9 P1-3): the delivery phase is OVER —
      // the lease was released in the finally above, and the turn now runs
      // with no producer hold at the terminal. The delivered-prompt fact is
      // reaffirmed and the record moves to 'running'; transcript correlation
      // closes it (or the sweep, on the do-not-retype ambiguous outcomes
      // this 'submitted' also covers). confirmed stays false honestly: the
      // ack says herdr took the prompt, not that anyone watched it land.
      this.deps.noteDelivered?.(agentId, prompt, gen)
      this.update(dispatchId, { state: 'running', via: 'herdr', confirmed: false })
      return
    }

    if (outcome === 'failed' && this.deps.backendAlive?.() === false) {
      // The submission did not fail — the world under it did. A dead server
      // is `interrupted`, never `failed`: the prompt may well be sitting in a
      // pane the restarted server will resurrect, and `failed` invites the
      // caller to re-send it on top.
      this.update(dispatchId, {
        state: 'interrupted',
        error: 'interrupted: the backend died during delivery'
      })
      return
    }

    const after = this.deepCapture(sessionName)
    if (promptLanded(after, prompt)) {
      // F2: the prompt IS in the pane and herdr simply could not watch it
      // arrive. Stop here. Re-sending would queue a duplicate in a live
      // agent's input box — measured, on a dispatch that had worked.
      // Landing is confirmation too — the delivered-prompt fact goes to the
      // tracker for the same reason as on `done`.
      this.deps.noteDelivered?.(agentId, prompt, gen)
      this.update(dispatchId, { state: 'running', via: 'herdr', confirmed: true })
      return
    }

    if (!nonDeliveryProven({ before, after, prompt, idle: this.idleSignal(sessionName) })) {
      // F3: unconfirmed is not undelivered. The capture is bounded and the TUI
      // collapses long pastes, so "not on screen" is routinely true of a prompt
      // that landed perfectly. Record the weaker grade of evidence and let the
      // turn correlation close the dispatch; a re-send here is the double-send.
      //
      // Sol r3 P1-9: the ATTEMPTED prompt is still a prompt fact. This is the
      // common "submission probably landed but the echo is collapsed" path —
      // the real turn can open and finish here, and without the exact bytes
      // the closer would be left recovering identity from a collapsed TUI
      // echo. Registered whenever non-delivery is NOT proven; the confidence
      // distinction lives in `confirmed`, not in the fact.
      this.deps.noteDelivered?.(agentId, prompt, gen)
      this.update(dispatchId, { via: 'herdr', confirmed: false })
      return
    }

    // Non-delivery is PROVEN: the attempted-delivery fact registered before
    // the submission is false — retract it, or the fallback's re-send below
    // would be correlated against a delivery that never happened.
    this.deps.retractDelivered?.(agentId, prompt, gen)
    await this.fallback(
      dispatchId,
      agentId,
      prompt,
      outcome === 'failed'
        ? 'herdr could not deliver the prompt'
        : 'the pane never moved and the prompt never appeared'
    )
  }

  /**
   * Is this dispatch's delivery leg still entitled to write its prompt
   * (Sol r5 P0-2)? Consulted IMMEDIATELY before every irreversible
   * submission — native and reattach-fallback alike. Three things must all
   * hold: the token is unaborted, the record is still open with NO parked
   * terminal intent (a ledger fault means the outcome is already decided,
   * merely not yet durable), and the record still owns the agent's
   * reservation. Losing any of them — owner preemption, backend death, node
   * removal, hydrate/sweep interrupt, endWork-via-release — cancels the
   * write, not the bookkeeping around it.
   */
  private deliveryLive(dispatchId: string, agentId: string): boolean {
    if (this.cancelledDeliveries.has(dispatchId)) return false
    const record = this.records.get(dispatchId)
    if (!record || TERMINAL_STATES.has(record.state)) return false
    if (record.ledgerFault === true) return false
    return this.reserved.get(agentId) === dispatchId
  }

  /**
   * Abort a queued/in-flight delivery leg (Sol r5 P0-2). A no-op when no leg
   * is in flight — the token exists to stop a prompt write that has not
   * happened yet, and a leg that already settled has nothing to stop. The
   * abort controller (Sol r8 P1) covers the other half: a write that already
   * STARTED — the blocking CLI child inside promptAgent — is TERM-killed so
   * its process, pipes and promise settle now instead of at the timeout.
   */
  private cancelDelivery(dispatchId: string): void {
    if (this.inFlight.has(dispatchId)) this.cancelledDeliveries.add(dispatchId)
    this.deliveryAborts.get(dispatchId)?.abort()
  }

  /** Scrollback where the backend has it, the plain screen where it does not. */
  private deepCapture(sessionName: string): string | null {
    return this.deps.captureDeep?.(sessionName) ?? this.deps.capture(sessionName)
  }

  /** True = the agent is not working, false = it is, null = nobody can say. */
  private idleSignal(sessionName: string): boolean | null {
    const status = this.deps.agentStatus?.(sessionName)
    if (status === undefined || status === null) return null
    // `blocked` counts as busy on purpose: an agent sitting on a permission
    // prompt is mid-turn, and a second brief typed underneath it is the exact
    // duplicate this guard exists to prevent.
    return status === 'idle' || status === 'done'
  }

  /** The one PTY in the design, and only ever after the evidence. */
  private async fallback(
    dispatchId: string,
    agentId: string,
    prompt: string,
    why: string
  ): Promise<void> {
    // Revalidated immediately before the OTHER irreversible submission
    // (Sol r5 P0-2): the reattach types the brief into a live pane, and a leg
    // cancelled while promptAgent blocked must not deliver it beside the
    // owner's work. The attempted fact was already retracted on the proven
    // non-delivery that routed here; the canceller owns the record's outcome,
    // so this asserts nothing.
    if (!this.deliveryLive(dispatchId, agentId)) return
    const record = this.records.get(dispatchId)
    const reattach = this.deps.reattachFallback
    if (!reattach || !record) {
      this.update(dispatchId, { state: 'failed', confirmed: false, error: why })
      return
    }
    // The lease again, for the OTHER irreversible submission (Sol r6 P0-1):
    // the native hold was released when promptAgent settled, and an owner may
    // have taken the terminal in between. Held across the fallback's whole
    // paste → delay → CR, so an owner write inside that window is refused at
    // the PTY guard rather than interleaved with a partial paste.
    //
    // Contamination refuses the fallback too (Sol r7 P0-1): typing a fresh
    // brief into a box that still holds a cancelled paste submits both.
    const holder: ProducerHolder = { kind: 'dispatch', dispatchId }
    if (this.lease.isContaminated(agentId)) {
      this.update(dispatchId, {
        state: 'failed',
        confirmed: false,
        error: `${why}; ${CONTAMINATED_REFUSAL}`
      })
      return
    }
    // OWNER COMPOSING, revalidated before the OTHER irreversible submission
    // (Sol r8 P0-1): the reattach types the brief into the same input box the
    // owner is typing in — the paste would land beside their half-typed text
    // and the eventual CR submits both. Cancelled like an interrupt, exactly
    // as on the native leg.
    if (this.deps.ownerComposing?.(agentId) === true) {
      this.update(dispatchId, {
        state: 'interrupted',
        error: 'interrupted: owner took the input box'
      })
      return
    }
    if (this.lease.acquire(agentId, holder) !== 'acquired') {
      this.update(dispatchId, {
        state: 'failed',
        confirmed: false,
        error: `${why}; an owner submission was in flight at fallback time`
      })
      return
    }
    try {
      // Cancellation-aware (Sol r6 P0-2): consulted before EACH fallback
      // write. Interrupt, release, backend death or sweep kills deliveryLive;
      // a committed owner preemption seizes the lease — either way the paste
      // sequence stops (in particular: no CR after a cancelled paste; the
      // pasted residue stays inert in the input box — see pasteAndSubmit).
      const stillValid = (): boolean =>
        this.deliveryLive(dispatchId, agentId) && this.holdsLease(agentId, dispatchId)
      const delivered = await reattach(record.agentId, prompt, stillValid)
      this.update(
        dispatchId,
        delivered
          ? { state: 'running', via: 'pty-fallback', confirmed: false }
          : { state: 'failed', confirmed: false, error: why }
      )
    } catch (error) {
      this.update(dispatchId, {
        state: 'failed',
        confirmed: false,
        error: `${why}; fallback threw: ${describeSubmissionError(error, prompt.length)}`
      })
    } finally {
      this.lease.release(agentId, holder)
    }
  }

  /** Does this dispatch's leg still hold the terminal's submission window? */
  private holdsLease(agentId: string, dispatchId: string): boolean {
    const holder = this.lease.holderOf(agentId)
    return holder !== null && holder.kind === 'dispatch' && holder.dispatchId === dispatchId
  }

  /**
   * The turn that answered this dispatch finished (CompletedTurn correlation).
   *
   * `outcome` is the parser's native verdict on how that turn ENDED (Sol r3
   * P1-7): absent or 'done' closes the record done; 'failed' (a native
   * aborted/error/length marker) closes it failed — the agent stopped
   * unsuccessfully, which is an answer, not a strand for the sweep;
   * 'interrupted' routes to the infrastructure ending. An EMPTY reply is a
   * valid final turn (tool/artifact-only — Sol r3 P1-8): the record closes
   * with hasReply absent rather than pretending an empty string is an answer.
   */
  completeTurn(
    dispatchId: string,
    result: { turnIndex: number; uuid?: string; reply?: string; outcome?: TurnOutcome }
  ): void {
    const record = this.records.get(dispatchId)
    if (!record || TERMINAL_STATES.has(record.state)) return
    const reply =
      result.reply !== undefined && result.reply.length > 0 ? { reply: result.reply } : {}
    // The answering turn's STABLE identity rides every terminal projection
    // (Sol r4 P1): a rewind can reuse turnIndex for different work, the
    // harness uuid cannot be reused.
    const identity = {
      turnIndex: result.turnIndex,
      ...(result.uuid !== undefined ? { turnUuid: result.uuid } : {})
    }
    const outcome = result.outcome ?? 'done'
    // Every branch here is PARSER evidence: the verdict comes from the
    // answering record itself, interrupted included (Sol r4 P1) — it must
    // outrank any equal-state infrastructure guess parked beside it.
    if (outcome === 'interrupted') {
      this.update(
        dispatchId,
        { state: 'interrupted', ...identity, error: 'interrupted: the agent turn was interrupted' },
        'parser'
      )
      return
    }
    if (outcome === 'failed') {
      this.update(
        dispatchId,
        { state: 'failed', ...identity, error: 'agent aborted/errored', ...reply },
        'parser'
      )
      return
    }
    this.update(dispatchId, { state: 'done', ...identity, ...reply }, 'parser')
  }

  /**
   * Infra stamped this one out — a herdr death, an app quit mid-turn. Distinct
   * from `failed`: the work may well have happened, so it is not a delivery
   * failure to be retried, it is an unknown to be reported.
   */
  interrupt(dispatchId: string, why: string): void {
    const record = this.records.get(dispatchId)
    if (!record || TERMINAL_STATES.has(record.state)) return
    // Abort the queued delivery FIRST (Sol r5 P0-2): the interrupt's intent
    // is decided here whether or not its append commits below (a failed
    // append parks it fail-closed), and a delivery leg still sitting on its
    // setImmediate hop — or blocked inside promptAgent with the fallback
    // ahead of it — must not write the cancelled brief into the pane.
    this.cancelDelivery(dispatchId)
    this.update(dispatchId, { state: 'interrupted', error: why })
  }

  /** Every dispatch still holding a slot — app quit stamps these interrupted. */
  openDispatchIds(): string[] {
    return [...this.reserved.values()]
  }

  /**
   * Is any dispatch still OPEN against this agent — reservation held or
   * record non-terminal (a parked ledger fault keeps both)? The owner
   * preemption wiring threads this back as its success signal (Sol r4 P0-1d):
   * after interruptAgent, `!hasOpenDispatch(id)` means the interrupt row
   * durably committed and the owner's write may proceed; anything still open
   * means the transition parked fail-closed and the write must be refused.
   */
  hasOpenDispatch(agentId: string): boolean {
    if (this.reserved.has(agentId)) return true
    return this.openIdsWhere((record) => record.agentId === agentId).length > 0
  }

  /**
   * Close out the dispatches nothing will ever close (D1).
   *
   * `release()` frees the agent's slot on the terminal edge — but only two
   * things reach that edge: a completed turn and an app quit. A dispatch whose
   * turn simply never arrives has no trigger at all, so it held its agent's
   * slot (and answered 409 busy to every later dispatch) until the process
   * ended. This is that trigger.
   *
   * A WORKING agent is spared, however old the record: that is positive
   * evidence the turn is still alive, and it is the same rule the delivery path
   * uses — never act on the absence of evidence when presence is available. It
   * gets swept on a later pass once the agent stops.
   *
   * Returns the ids it stamped, so a caller can log what it closed.
   */
  sweep(): string[] {
    // Ledger faults first: a record held open by a failed terminal append
    // already HAS its outcome — the sweep's job for it is to land the row and
    // release, not to invent a fresh interrupt over the decided state.
    this.retryLedgerFaults()
    // Observer probation (Sol r3 P1-17): a native-file acceptance was
    // predicated on a watchSpec, which is a path-shaped promise. If the
    // observer never MATERIALIZED (no verified reconcile) within the
    // probation window, no closure can ever arrive for this dispatch —
    // interrupt it promptly instead of leaving it to the ten-minute sweep.
    const probation = this.now() - OBSERVER_PROBATION_MS
    const unobserved =
      this.deps.observerLive === undefined
        ? []
        : [...this.records.values()].filter(
            (record) =>
              !TERMINAL_STATES.has(record.state) &&
              !this.ledgerFaults.has(record.id) &&
              record.createdAt <= probation &&
              this.openMeta.get(record.id)?.grade === 'native-file' &&
              this.deps.observerLive?.(record.agentId) === false
          )
    const probationStamped = this.interruptEach(
      unobserved.map((record) => record.id),
      'interrupted: observer never materialized'
    )
    const cutoff = this.now() - STALE_DISPATCH_MS
    const stale = [...this.records.values()].filter(
      (record) =>
        !TERMINAL_STATES.has(record.state) &&
        record.updatedAt <= cutoff &&
        !this.ledgerFaults.has(record.id)
    )
    // A durable final record answering the dispatch OUTRANKS the timeout
    // (Sol r4 P0-3): the parser already proved how this turn ended, so the
    // sweep commits THAT outcome through the normal completion path —
    // done/failed/interrupted from the record, with its turn identity —
    // never `interrupted: no outcome within 10 minutes`. It also ends the
    // working-status veto (Sol r3 P0-6): a feed stuck at 'working' cannot
    // outrank parser-proven finality forever.
    const completed: string[] = []
    const abandoned: DispatchRecord[] = []
    for (const record of stale) {
      const meta = this.openMeta.get(record.id)
      const final =
        meta !== undefined
          ? (this.deps.hasFinalAnswer?.(record.agentId, meta.prompt, meta.armedAt) ?? null)
          : null
      if (final !== null) {
        this.completeTurn(record.id, {
          turnIndex: final.turnIndex,
          ...(final.uuid !== undefined ? { uuid: final.uuid } : {}),
          ...(final.reply !== undefined ? { reply: final.reply } : {}),
          ...(final.outcome !== undefined ? { outcome: final.outcome } : {})
        })
        if (TERMINAL_STATES.has(this.records.get(record.id)?.state ?? record.state)) {
          completed.push(record.id)
        }
        continue
      }
      // No durable terminal record: a WORKING agent is spared, however old
      // the row — positive evidence the turn is still alive. Everything else
      // is genuinely abandoned and gets the honest timeout interrupt.
      if (this.idleSignal(this.deps.sessionNameFor(record.agentId)) === false) continue
      abandoned.push(record)
    }
    const stamped = this.interruptEach(
      abandoned.map((record) => record.id),
      `interrupted: no outcome within ${Math.round(STALE_DISPATCH_MS / 60_000)} minutes`
    )
    // Retry cadence for failed burials too: a record retained because its
    // tombstone could not be appended gets another prune pass every sweep,
    // not only when some other dispatch happens to release.
    this.prune()
    return [...probationStamped, ...completed, ...stamped]
  }

  /**
   * Stamp every open dispatch interrupted (app quit). Called from before-quit:
   * a dispatch left `submitted` forever is a request with no outcome, and on
   * the next boot hydration cannot tell it from work still in flight.
   */
  interruptAll(why: string): string[] {
    return this.interruptEach(this.openDispatchIds(), why)
  }

  /**
   * The backend died under every open dispatch at once (herdr supervisor).
   * Interrupted — never failed — through the same release choke point as
   * every other terminal transition: the agents may have done the work, and
   * nothing that outlives the server can watch their turns end. Sweeps ALL
   * non-terminal records, not just the reserved ones, so nothing is stranded
   * waiting on a correlation that can no longer arrive.
   */
  onBackendDeath(why: string): string[] {
    return this.interruptEach(this.openIdsWhere(() => true), why)
  }

  /**
   * One agent left the world (node removal, harness rebind): its open
   * dispatches are interrupted, not failed — the delivery already happened,
   * only the witness is gone. Exposed for the call sites that retire agents.
   */
  interruptAgent(agentId: string, why: string): string[] {
    return this.interruptEach(
      this.openIdsWhere((record) => record.agentId === agentId),
      why
    )
  }

  private openIdsWhere(keep: (record: DispatchRecord) => boolean): string[] {
    return [...this.records.values()]
      .filter((record) => !TERMINAL_STATES.has(record.state) && keep(record))
      .map((record) => record.id)
  }

  private interruptEach(ids: readonly string[], why: string): string[] {
    // Snapshot first: interrupt() mutates the reservation map it came from.
    const stamped: string[] = []
    for (const id of ids) {
      const before = this.records.get(id)?.state
      this.interrupt(id, why)
      if (before !== this.records.get(id)?.state) stamped.push(id)
    }
    return stamped
  }

  private update(
    dispatchId: string,
    patch: Partial<DispatchRecord>,
    evidence: TerminalEvidence = 'infrastructure'
  ): void {
    const record = this.records.get(dispatchId)
    // Async delivery can settle after turn correlation has already closed the
    // dispatch. Terminal states are immutable: a late `running` observation
    // must never regress done → running and erase the completed lifecycle.
    if (!record || TERMINAL_STATES.has(record.state)) return
    const next = { ...record, ...patch, updatedAt: this.now() }
    if (TERMINAL_STATES.has(next.state)) {
      this.commitTerminal(record, next, evidence)
      return
    }
    this.write(next)
  }

  /**
   * A terminal transition is DURABLE BEFORE IT IS TRUE (Sol r2 P0). The old
   * order — advance memory, release the reservation, then try the append —
   * meant a failed append left GET reporting `done`, the agent's slot free
   * and a restart reloading the older open row: a settlement nobody could
   * audit. Now the append (one retry) gates everything: only a landed row
   * makes the terminal state visible and releases the reservation, exactly
   * once. On failure the record stays OPEN in memory with a `ledgerFault`
   * mark, the reservation is kept, and the sweep retries the append each
   * pass until it lands.
   */
  private commitTerminal(
    open: DispatchRecord,
    next: DispatchRecord,
    evidence: TerminalEvidence
  ): void {
    // The lattice gate, BEFORE any append attempt (Sol r3 P0-3; authority
    // first per Sol r5 P1): a parked stronger fact must not be overwritten by
    // a weaker later event even when the ledger has recovered in between — a
    // parser-proven `done` whose append failed, followed by onBackendDeath,
    // must retry as done, never land as interrupted. AUTHORITY decides first:
    // parser evidence (the answering turn's own durable verdict, with its
    // identity) dominates infrastructure at any state, so a parser-proven
    // `interrupted` survives an infrastructure `failed`. At equal authority,
    // state strength decides; equal authority AND state lands the newcomer
    // but merges the parked intent's turn identity/metadata rather than
    // replacing evidence with nothing.
    let intent = next
    const parked = this.ledgerFaults.get(next.id)
    if (parked) {
      const order = compareTerminalIntents(
        { state: parked.record.state, evidence: parked.evidence },
        { state: next.state, evidence }
      )
      if (order > 0) return
      if (order === 0) intent = mergeTerminalMeta(parked.record, next)
    }
    const { ledgerFault, ...intended } = intent
    if (this.persistRecord(intended) || this.persistRecord(intended)) {
      this.ledgerFaults.delete(intended.id)
      this.records.set(intended.id, intended)
      this.release(intended)
      return
    }
    // Fail CLOSED: memory does not advance, nothing is released, and the
    // caller-visible state remains the open one. The intended terminal row is
    // parked for the sweep; a later transition replaces the intent only per
    // the evidence lattice above (a turn completing over a pending interrupt
    // upgrades it; the reverse is discarded), and the release still fires
    // exactly once, when an append finally lands.
    this.ledgerFaults.set(intended.id, { record: intended, evidence })
    this.records.set(intended.id, { ...open, ledgerFault: true })
    console.error(
      `Dispatch ledger append failed for ${intended.id} (state=${intended.state}) — held open with a ledger fault; the sweep retries until it lands`
    )
  }

  /** Sweep pass: land every parked terminal row whose append failed. */
  private retryLedgerFaults(): void {
    for (const [id, { record: intended }] of [...this.ledgerFaults]) {
      if (!this.persistRecord(intended)) continue
      this.ledgerFaults.delete(id)
      const current = this.records.get(id)
      // The record can only still be open (commitTerminal is the one path to
      // terminal and it goes through this map) — but stay defensive: a row
      // somehow already terminal must not be released a second time.
      if (!current || TERMINAL_STATES.has(current.state)) continue
      this.records.set(id, intended)
      this.release(intended)
    }
  }

  /**
   * The dispatch is over: free the agent's slot, disarm the tracker (F8) and
   * hand the terminal back to the ordinary drain clock (endWork). Clearing the
   * stamp matters most for the outcomes that produce NO turn — a failed
   * delivery would otherwise leave the id armed and attribute the agent's next
   * human turn to a dispatch nobody is waiting on. This is the ONLY exit from
   * an open dispatch, so endWork fires exactly once per record.
   */
  private release(record: DispatchRecord): void {
    // Terminal by ANY path — turn correlation, sweep, hydrate, quit — ends
    // the delivery leg's licence to write (Sol r5 P0-2): a completion racing
    // the queued delivery must not be followed by the brief it answered.
    this.cancelDelivery(record.id)
    if (this.reserved.get(record.agentId) === record.id) this.reserved.delete(record.agentId)
    this.openMeta.delete(record.id)
    this.deps.clearDispatch?.(record.agentId, record.id)
    this.deps.endWork(record.agentId)
    this.prune()
  }

  /**
   * Keep the in-memory maps bounded (F17). Only CLOSED dispatches are
   * droppable, and an open dispatch is never pruned however old it is.
   * Dropping a record no longer drops its idempotency key: the key's promise
   * outlives the record as a tombstone, for IDEMPOTENCY_TTL_MS — a caller's
   * retry of an old key must replay, never silently re-run.
   */
  private prune(): void {
    const cutoff = this.now() - RECORD_RETENTION_MS
    const overflow = Math.max(0, this.records.size - MAX_RECORDS)
    const closed = [...this.records.values()]
      .filter((record) => TERMINAL_STATES.has(record.state))
      .sort((a, b) => a.updatedAt - b.updatedAt)
    closed.forEach((record, index) => {
      if (index >= overflow && record.updatedAt >= cutoff) return
      // Burial BEFORE deletion, and only if it lands (Sol r2 P1): the record
      // is the richer source the tombstone is built from, and deleting it
      // first turns a failed append into data loss the moment ledger
      // compaction removes the old rows. A record whose burial fails is
      // RETAINED — key and all — and this prune pass simply retries on the
      // next one.
      if (record.idempotencyKey !== undefined) {
        const key = idempotencyScope(record.consumer, record.idempotencyKey)
        if (this.byKey.get(key) === record.id) {
          if (!this.bury(key, record)) return
          this.byKey.delete(key)
        }
      }
      this.records.delete(record.id)
    })
    // Tombstones expire too — after the TTL, not never.
    const expired = this.now() - IDEMPOTENCY_TTL_MS
    for (const [scope, tombstone] of [...this.tombstones]) {
      if (tombstone.closedAt < expired) this.tombstones.delete(scope)
    }
  }

  /**
   * The key survives its record: persist the tombstone DURABLY, then install
   * it. Returns false — and installs nothing — when the append fails, so the
   * caller keeps the source record and retries next pass. A memory-only
   * service (no persistTombstone dep) buries in memory alone, which is all
   * the durability it ever promised.
   */
  private bury(scope: string, record: DispatchRecord): boolean {
    const tombstone: DispatchTombstone = {
      kind: 'tombstone',
      scope,
      dispatchId: record.id,
      state: record.state,
      ...(record.promptHash !== undefined ? { promptHash: record.promptHash } : {}),
      closedAt: record.updatedAt
    }
    let appended = false
    try {
      appended = this.deps.persistTombstone?.(tombstone) !== false
    } catch {
      appended = false
    }
    if (!appended) {
      console.error(
        `Dispatch tombstone append failed for ${record.id} — record retained; burial retries next prune`
      )
      return false
    }
    this.tombstones.set(scope, tombstone)
    return true
  }

  /** One durable append; a throw counts as a failure — the dep may do either. */
  private persistRecord(record: DispatchRecord): boolean {
    try {
      return this.deps.persist(record) !== false
    } catch (error) {
      console.error('Dispatch ledger append threw:', error)
      return false
    }
  }

  /**
   * NON-terminal transitions only (submitted → running, confirmed flips):
   * memory advances and a failed append is loud but not blocking — `running`
   * is an observation, not a settlement, and the terminal row that follows
   * carries the same facts. Terminal transitions go through commitTerminal,
   * which fails CLOSED instead.
   */
  private write(record: DispatchRecord): void {
    this.records.set(record.id, record)
    if (this.persistRecord(record) || this.persistRecord(record)) return
    console.error(
      `Dispatch ledger append failed for ${record.id} (state=${record.state}) — memory advanced, disk did not`
    )
  }
}
