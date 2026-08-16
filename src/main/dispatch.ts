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
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

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
   * sha256 of the normalized prompt (promptFingerprint). The idempotency key
   * says "this is the same work"; the hash is what lets the service CHECK
   * that claim — one key fronting two different briefs is refused instead of
   * silently replaying whichever brief arrived first.
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
   */
  promptAgent?: (
    sessionName: string,
    prompt: string,
    timeoutMs: number
  ) => Promise<'done' | 'submitted' | 'failed'>
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
   * The dispatch is accepted: start the tracking it depends on (v5 A4 —
   * tracking follows work). Called once per accepted dispatch, after the
   * agent's slot is reserved and before delivery, so the session-file watch
   * and the drain pin exist before the turn they must observe.
   *
   * Returns FALSE when no durable observer could be installed AND the agent
   * is not scrape-tracked — a pin with no watch, which is an acceptance
   * nothing would ever close. A false return promises the failed attempt
   * left no state behind (the implementation releases anything it
   * half-built); the service then rolls its own side back and refuses 503.
   */
  beginWork: (agentId: string) => boolean
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
   */
  reattachFallback?: (agentId: string, prompt: string) => Promise<boolean>
  newId?: () => string
  now?: () => number
  /** How long the native submission may block before it is a stall. */
  timeoutMs?: number
}

/** Default ceiling for one native submission. */
const DISPATCH_TIMEOUT_MS = 10 * 60 * 1000

/** Context headroom below which an agent silently swallows work. */
const CONTEXT_FULL_PERCENT = 98

/**
 * Chars of normalized prompt compared against the transcript tail. Short
 * enough to survive the TUI rewrapping its echo, long enough to tell two
 * briefs at the same agent apart. A prompt the TUI collapsed into a
 * "[Pasted text #1 …]" placeholder matches nothing at any length, and reads
 * as unconfirmed — which is the honest answer, not a reason to lengthen it.
 */
const LANDING_MATCH_CHARS = 24

const normalize = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * The ONE normalized-prefix key every dispatch-correlation question uses —
 * "is the prompt on the pane?" (promptLanded) and "is this completed turn the
 * dispatched one?" (promptAnswersDispatch). One normalization on purpose: with
 * two rules a prompt could land under one and complete under the other, and
 * the dispatch would never close.
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
 */
export function promptAnswersDispatch(turnPrompt: string, dispatchedPrompt: string): boolean {
  const key = dispatchPromptKey(dispatchedPrompt)
  if (key.length === 0) return false
  return dispatchPromptKey(turnPrompt) === key
}

/**
 * Request fingerprint for idempotency-key reuse detection: sha256 over the
 * same normalization as everything else here. Stored on the record (and on
 * the key's tombstone), so "same key, different work" stays detectable for as
 * long as the key itself is honored.
 */
export function promptFingerprint(prompt: string): string {
  return createHash('sha256').update(normalize(prompt)).digest('hex')
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
  const { reply, ...row } = record
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

const TERMINAL_STATES: ReadonlySet<DispatchState> = new Set(['done', 'failed', 'interrupted'])

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

  constructor(private readonly deps: DispatchDeps) {
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
    for (const tombstone of this.deps.loadTombstones?.() ?? []) {
      if (tombstone.closedAt < expired) continue
      this.tombstones.set(tombstone.scope, tombstone)
    }
    const rows = this.deps.loadRecords?.() ?? []
    for (const row of rows) {
      if (typeof row?.id !== 'string') continue
      this.records.set(row.id, row)
      if (row.idempotencyKey !== undefined) {
        this.byKey.set(idempotencyScope(row.consumer, row.idempotencyKey), row.id)
      }
    }
    for (const record of [...this.records.values()]) {
      if (TERMINAL_STATES.has(record.state)) continue
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
    const prompt = (input.text ?? input.brief ?? '').trim()
    // Fingerprinted before any refusal: the replay lookup needs it, and it
    // exists only when there is a prompt to fingerprint — an empty retry can
    // still replay by key, it just cannot prove or disprove sameness.
    const promptHash = prompt.length > 0 ? promptFingerprint(prompt) : undefined

    // A REPLAY outruns EVERY refusal below — busy, 404 and 400 included. The
    // retry a flaky network produces can arrive while the original is still
    // in flight, after the agent was deleted, or with a mangled empty body,
    // and the honest answer is still "that work exists, here is its id" — an
    // error would tell the caller to re-send its own work.
    const key = input.idempotencyKey
    const scopedKey = key === undefined ? undefined : idempotencyScope(input.consumer, key)
    if (scopedKey !== undefined) {
      const reused = { error: 'idempotency key reused for different work' }
      const existing = this.byKey.get(scopedKey)
      if (existing !== undefined) {
        const held = this.records.get(existing)
        // Same key fronting a DIFFERENT brief is a caller bug: replaying
        // would hand back a result for a prompt this caller did not send, and
        // running it would break the key's promise. Checkable only when both
        // sides carry a fingerprint (pre-upgrade rows do not).
        if (
          promptHash !== undefined &&
          held?.promptHash !== undefined &&
          held.promptHash !== promptHash
        ) {
          return { status: 409, body: reused }
        }
        return { status: 200, body: { dispatchId: existing, replay: true } }
      }
      const tombstone = this.tombstones.get(scopedKey)
      if (tombstone !== undefined) {
        if (
          promptHash !== undefined &&
          tombstone.promptHash !== undefined &&
          tombstone.promptHash !== promptHash
        ) {
          return { status: 409, body: reused }
        }
        // The record itself is pruned: the id and "it closed" are ALL that is
        // still known — turnIndex, agent, timings went with the record, and
        // `tombstone: true` says so instead of faking a fuller answer.
        return {
          status: 200,
          body: { dispatchId: tombstone.dispatchId, state: 'done', replay: true, tombstone: true }
        }
      }
    }

    const agent = this.deps.resolveAgent(agentId)
    if (!agent) return { status: 404, body: { error: 'no such agent' } }
    if (prompt.length === 0) {
      return { status: 400, body: { error: 'dispatch needs a brief or text' } }
    }

    const held = this.reserved.get(agentId)
    if (held !== undefined) {
      return { status: 409, body: { error: 'busy', dispatchId: held } }
    }

    const sessionName = this.deps.sessionNameFor(agentId)
    if (!this.deps.sessionExists(sessionName)) {
      return { status: 503, body: { error: 'unreachable' } }
    }
    if (contextExhausted(this.deps.capture(sessionName))) {
      return { status: 503, body: { error: 'context-full' } }
    }
    if (!this.deps.promptAgent) {
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
    if (!this.deps.beginWork(agentId)) {
      this.reserved.delete(agentId)
      this.deps.clearDispatch?.(agentId, id)
      return { status: 503, body: { error: 'agent has no durable observer' } }
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

    // The reservation is NOT released here (F6). Submission settles
    // milliseconds after the prompt goes out and the agent then works for
    // minutes; a second dispatch accepted in that window overwrites the
    // tracker's stamp, so B closes with A's turn and A never closes at all.
    // The slot is held until the record reaches a terminal state.
    this.inFlight.set(
      record.id,
      this.deliver(record.id, sessionName, prompt).finally(() =>
        this.inFlight.delete(record.id)
      )
    )

    return {
      status: 202,
      body: { dispatchId: record.id, state: 'submitted' }
    }
  }

  /**
   * Deliver, then decide what the outcome actually means.
   *
   * `done` is herdr watching the turn end — the strongest answer available.
   * EVERY other outcome, `failed` included, is read against the transcript
   * first (F2): herdr submits and THEN waits, so a wait that times out or a
   * server that dies mid-wait both report a failure over a prompt that is
   * already sitting in the agent's input box. Only `done` skips the check,
   * because only `done` cannot be improved on.
   */
  private async deliver(dispatchId: string, sessionName: string, prompt: string): Promise<void> {
    const promptAgent = this.deps.promptAgent
    if (!promptAgent) return
    // The pre-submission screen, so "did anything happen after we submitted?"
    // is answerable later. Taken here rather than in dispatch() so it is the
    // last look before the prompt goes out.
    const before = this.deepCapture(sessionName)
    let outcome: 'done' | 'submitted' | 'failed'
    try {
      outcome = await promptAgent(sessionName, prompt, this.deps.timeoutMs ?? DISPATCH_TIMEOUT_MS)
    } catch (error) {
      outcome = 'failed'
      console.error('Dispatch submission threw:', describeSubmissionError(error, prompt.length))
    }

    if (outcome === 'done') {
      // Delivered and observed. The turn correlation still closes the record —
      // `done` from the backend says the agent stopped, not what it produced.
      this.update(dispatchId, { state: 'running', via: 'herdr', confirmed: true })
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
      this.update(dispatchId, { state: 'running', via: 'herdr', confirmed: true })
      return
    }

    if (!nonDeliveryProven({ before, after, prompt, idle: this.idleSignal(sessionName) })) {
      // F3: unconfirmed is not undelivered. The capture is bounded and the TUI
      // collapses long pastes, so "not on screen" is routinely true of a prompt
      // that landed perfectly. Record the weaker grade of evidence and let the
      // turn correlation close the dispatch; a re-send here is the double-send.
      this.update(dispatchId, { via: 'herdr', confirmed: false })
      return
    }

    await this.fallback(
      dispatchId,
      prompt,
      outcome === 'failed'
        ? 'herdr could not deliver the prompt'
        : 'the pane never moved and the prompt never appeared'
    )
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
  private async fallback(dispatchId: string, prompt: string, why: string): Promise<void> {
    const record = this.records.get(dispatchId)
    const reattach = this.deps.reattachFallback
    if (!reattach || !record) {
      this.update(dispatchId, { state: 'failed', confirmed: false, error: why })
      return
    }
    try {
      const delivered = await reattach(record.agentId, prompt)
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
    }
  }

  /** The turn that answered this dispatch finished (CompletedTurn correlation). */
  completeTurn(dispatchId: string, result: { turnIndex: number; reply?: string }): void {
    const record = this.records.get(dispatchId)
    if (!record || TERMINAL_STATES.has(record.state)) return
    this.update(dispatchId, {
      state: 'done',
      turnIndex: result.turnIndex,
      ...(result.reply !== undefined ? { reply: result.reply } : {})
    })
  }

  /**
   * Infra stamped this one out — a herdr death, an app quit mid-turn. Distinct
   * from `failed`: the work may well have happened, so it is not a delivery
   * failure to be retried, it is an unknown to be reported.
   */
  interrupt(dispatchId: string, why: string): void {
    const record = this.records.get(dispatchId)
    if (!record || TERMINAL_STATES.has(record.state)) return
    this.update(dispatchId, { state: 'interrupted', error: why })
  }

  /** Every dispatch still holding a slot — app quit stamps these interrupted. */
  openDispatchIds(): string[] {
    return [...this.reserved.values()]
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
    const cutoff = this.now() - STALE_DISPATCH_MS
    const stale = [...this.records.values()].filter(
      (record) => !TERMINAL_STATES.has(record.state) && record.updatedAt <= cutoff
    )
    const abandoned = stale.filter(
      (record) => this.idleSignal(this.deps.sessionNameFor(record.agentId)) !== false
    )
    return this.interruptEach(
      abandoned.map((record) => record.id),
      `interrupted: no outcome within ${Math.round(STALE_DISPATCH_MS / 60_000)} minutes`
    )
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

  private update(dispatchId: string, patch: Partial<DispatchRecord>): void {
    const record = this.records.get(dispatchId)
    // Async delivery can settle after turn correlation has already closed the
    // dispatch. Terminal states are immutable: a late `running` observation
    // must never regress done → running and erase the completed lifecycle.
    if (!record || TERMINAL_STATES.has(record.state)) return
    const next = { ...record, ...patch, updatedAt: this.now() }
    this.write(next)
    if (!TERMINAL_STATES.has(record.state) && TERMINAL_STATES.has(next.state)) this.release(next)
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
    if (this.reserved.get(record.agentId) === record.id) this.reserved.delete(record.agentId)
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
      this.records.delete(record.id)
      if (record.idempotencyKey !== undefined) {
        const key = idempotencyScope(record.consumer, record.idempotencyKey)
        if (this.byKey.get(key) === record.id) {
          this.byKey.delete(key)
          this.bury(key, record)
        }
      }
    })
    // Tombstones expire too — after the TTL, not never.
    const expired = this.now() - IDEMPOTENCY_TTL_MS
    for (const [scope, tombstone] of [...this.tombstones]) {
      if (tombstone.closedAt < expired) this.tombstones.delete(scope)
    }
  }

  /** The key survives its record: install and persist the tombstone. */
  private bury(scope: string, record: DispatchRecord): void {
    const tombstone: DispatchTombstone = {
      kind: 'tombstone',
      scope,
      dispatchId: record.id,
      ...(record.promptHash !== undefined ? { promptHash: record.promptHash } : {}),
      closedAt: record.updatedAt
    }
    this.tombstones.set(scope, tombstone)
    let appended = false
    try {
      appended = this.deps.persistTombstone?.(tombstone) !== false
    } catch {
      appended = false
    }
    if (!appended) {
      console.error(
        `Dispatch tombstone append failed for ${record.id} — a replay of its key will not survive a restart`
      )
    }
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

  private write(record: DispatchRecord): void {
    this.records.set(record.id, record)
    // Transition appends retry once, then fail LOUDLY with the id: memory has
    // already advanced (a state machine cannot un-happen the turn it just
    // observed), so the fault must at least be visible instead of silently
    // forking disk from memory.
    if (this.persistRecord(record) || this.persistRecord(record)) return
    console.error(
      `Dispatch ledger append failed for ${record.id} (state=${record.state}) — memory advanced, disk did not`
    )
  }
}
