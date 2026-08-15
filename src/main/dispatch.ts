// Attach-free dispatch: give an agent work over HTTP without a terminal.
//
// v4 §3. The protocol already had ~45 routes and two SSE streams; the one it
// lacked was this. `POST /api/agents/:id/dispatch` resolves the agent's pane
// through the multiplexer and submits the prompt natively — measured, that
// reached both background agents (eval P2) where HTTP /ask 404s on a detached
// pane because it needs a live PtySession (eval F1).
//
// So NO PtySession appears in this module, by import as well as by intent.
// The single PTY in the design is `reattachFallback`, injected by index.ts and
// reached only after the transcript has PROVEN the prompt never landed.
//
// THE F2 RULE, which most of this file exists to keep: herdr reports `stalled`
// — "agent prompt produced no observed state change" — for prompts that landed
// perfectly. It did so on BOTH successful dispatches in the eval. `stalled`
// is a statement about the detector, not about delivery. Re-sending on it
// double-submits into a live agent's input box, so every retry here is
// preceded by reading the transcript. Never blind.

import { randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * Lifecycle of one dispatch (v4 §3, terminal states per Tinker's herdr-death
 * taxonomy). `submitted` is the reservation; `running` means the prompt is
 * demonstrably in the pane; `interrupted` is infra-stamped and distinct from
 * `failed` — the difference between "we could not deliver this" and "we
 * delivered it and the world fell over", which a consumer bills differently.
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
  /**
   * Did the TRANSCRIPT agree that the prompt landed? Only meaningful for a
   * `submitted`/stalled outcome, where herdr declined to say. Recorded because
   * "we checked and it was there" and "the backend said done" are different
   * grades of evidence and a billing trace should not blur them.
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
  /** A catalog brief. `briefRef` + server-side resolution is wave B (§4.3). */
  brief?: string
  /** Free text. Requires free-text rights once the gate lands (§4.3). */
  text?: string
  idempotencyKey?: string
}

export interface DispatchDeps {
  /** Agent id → identity, across workspaces. Null when nobody owns that id. */
  resolveAgent: (agentId: string) => { name: string; workspaceId: string } | null
  /**
   * Is this workspace SERVICEABLE (Sol's serviceState === 'hot')? A dormant
   * workspace has no tracker registration, so a turn there would complete
   * unobserved and the dispatch could never be correlated or billed. Refusing
   * is honest; dispatching blind is not.
   */
  isHot: (workspaceId: string) => boolean
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
   * Tell the tracker which dispatch the agent's next completed turn answers.
   * Returns FALSE when that agent already carries a live stamp — one turn
   * cannot answer two dispatches, and overwriting the stamp would close the
   * second dispatch with the first one's turn (and bill both for one answer).
   */
  noteDispatch: (agentId: string, dispatchId: string) => boolean
  /**
   * Drop the tracker's stamp for a dispatch that ended without a turn. Without
   * it a failed dispatch leaves its id armed and the agent's next HUMAN turn
   * gets attributed — and billed — to a dispatch nobody is waiting on.
   */
  clearDispatch?: (agentId: string, dispatchId: string) => void
  /** Append the record to the durable registry. */
  persist: (record: DispatchRecord) => void
  /**
   * Every persisted transition, for rehydration at boot. Absent = a memory-only
   * service (tests); present = idempotency keys and paid history survive a
   * restart instead of billing the caller's retry as new work.
   */
  loadRecords?: () => DispatchRecord[]
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
  const needle = normalize(prompt).slice(0, LANDING_MATCH_CHARS)
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
 * submitted twice into a live agent and billed twice.
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
 * `herdr agent prompt <pane> <prompt>` carries the consumer's ENTIRE brief —
 * paid, frequently confidential text — into the app log and into the record's
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
 * the consumer's own text.
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
 * (F4): it is the agent's full answer, and the dispatch ledger is a billing and
 * correlation trace, not a second transcript store. `turnIndex` already points
 * at the turn that produced it, and the turn ledger — which is where replies
 * live, with its own retention and its own gate — can be asked. Keeping a copy
 * here meant every answer an API consumer ever received was duplicated into a
 * file with a different lifetime and no reader.
 *
 * `error` stays: it is already redacted of prompt text (describeSubmissionError)
 * and it is the only record of WHY a paid dispatch produced nothing.
 */
export function persistedRecord(record: DispatchRecord): DispatchRecord {
  const { reply, ...row } = record
  return { ...row, ...(reply !== undefined || row.hasReply ? { hasReply: true } : {}) }
}

/**
 * Append one transition. Append-only on purpose: a dispatch ledger that
 * rewrites rows cannot answer "what did this look like when it was billed",
 * and a crash mid-rewrite would lose the row entirely.
 *
 * OWNER-ONLY on disk. The rows name agents, workspaces and the shape of paid
 * work, so the directory is created 0700 and the file 0600 — and an existing
 * file is chmod'ed on every append, because `mode` applies at CREATE time only
 * and this ledger predates the fix on every machine that already ran it.
 */
export function appendDispatchRecord(file: string, record: DispatchRecord): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const inherited = existsSync(file) ? statSync(file).mode & 0o777 : 0o600
    appendFileSync(file, `${JSON.stringify(persistedRecord(record))}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    if (inherited !== 0o600) chmodSync(file, 0o600)
  } catch (error) {
    console.error('Dispatch registry write failed:', error)
  }
}

/** Every persisted transition, oldest first. A torn line is skipped, not fatal. */
export function readDispatchRecords(file: string): DispatchRecord[] {
  try {
    if (!existsSync(file)) return []
    const rows: DispatchRecord[] = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const parsed = JSON.parse(line) as DispatchRecord
        if (typeof parsed?.id === 'string') rows.push(parsed)
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
 * How long a CLOSED dispatch stays in memory. Long enough that a consumer's
 * retry of a week-old key is still recognised as a replay rather than billed
 * again; short enough that the maps do not grow for the life of the process.
 */
const RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Hard ceiling, for a machine that dispatches faster than the window expires. */
const MAX_RECORDS = 5000

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
  /** idempotencyKey → dispatchId, so a replayed request is the same dispatch. */
  private readonly byKey = new Map<string, string>()
  /** dispatchId → the async delivery leg, for tests and for shutdown. */
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(private readonly deps: DispatchDeps) {
    this.hydrate()
  }

  /**
   * Rebuild state from the ledger (F5).
   *
   * Memory-only records made every restart a billing event: the same
   * idempotencyKey minted a SECOND dispatch, and a consumer polling for the
   * answer to paid work got a 404. The ledger is append-only, so the last row
   * for an id is its current state.
   *
   * Anything still open belonged to a process that no longer exists — nothing
   * is watching that turn and no correlation can arrive. That is `interrupted`
   * by its own definition ("we delivered it and the world fell over"), never
   * `failed`, because the agent may well have done the work.
   */
  private hydrate(): void {
    const rows = this.deps.loadRecords?.() ?? []
    for (const row of rows) {
      if (typeof row?.id !== 'string') continue
      this.records.set(row.id, row)
      if (row.idempotencyKey !== undefined) this.byKey.set(row.idempotencyKey, row.id)
    }
    for (const record of [...this.records.values()]) {
      if (TERMINAL_STATES.has(record.state)) continue
      this.write({
        ...record,
        state: 'interrupted',
        error: 'interrupted: the app restarted while this dispatch was open',
        updatedAt: this.now()
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
   */
  lookup(dispatchId: string): DispatchResponse {
    const record = this.records.get(dispatchId)
    if (!record) return { status: 404, body: { error: 'no such dispatch' } }
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
    const agent = this.deps.resolveAgent(agentId)
    if (!agent) return { status: 404, body: { error: 'no such agent' } }

    const prompt = (input.text ?? input.brief ?? '').trim()
    if (prompt.length === 0) {
      return { status: 400, body: { error: 'dispatch needs a brief or text' } }
    }

    // A REPLAY outruns every refusal below, including busy: the retry a flaky
    // network produces arrives while the original is still in flight, and
    // answering 409 there would tell a caller to back off from its own work.
    const key = input.idempotencyKey
    if (key !== undefined) {
      const existing = this.byKey.get(key)
      if (existing !== undefined) {
        return { status: 200, body: { dispatchId: existing, replay: true } }
      }
    }

    const held = this.reserved.get(agentId)
    if (held !== undefined) {
      return { status: 409, body: { error: 'busy', dispatchId: held } }
    }
    if (!this.deps.isHot(agent.workspaceId)) {
      // Not a failure — a statement about the workspace. It becomes
      // serviceable when its service state does (v4 §1, Sol's step 2).
      return { status: 409, body: { error: 'dormant', workspaceId: agent.workspaceId } }
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
    // reservation for — so this one is refused before anything is billed.
    if (!this.deps.noteDispatch(agentId, id)) {
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
      ...(key !== undefined ? { idempotencyKey: key } : {})
    }
    this.write(record)
    this.reserved.set(agentId, record.id)
    if (key !== undefined) this.byKey.set(key, record.id)

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

    return { status: 202, body: { dispatchId: record.id, state: 'submitted' } }
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
   * `release()` frees the agent's slot on the terminal edge — but only three
   * things reach that edge: a completed turn, an app quit, and a workspace
   * leaving HOT. A dispatch whose turn simply never arrives has no trigger at
   * all, so it held its agent's slot (and answered 409 busy to every later
   * dispatch) until the process ended. This is that trigger.
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
   * a dispatch left `submitted` forever is a paid request with no outcome, and
   * on the next boot hydration cannot tell it from work still in flight.
   */
  interruptAll(why: string): string[] {
    return this.interruptEach(this.openDispatchIds(), why)
  }

  /**
   * Stamp the open dispatches of one workspace interrupted — hot → dormant or
   * parked. That transition untracks the terminals and kills or detaches their
   * panes, so no turn can ever close these; leaving them open would hold the
   * agent's slot against every future dispatch.
   */
  interruptWorkspace(workspaceId: string, why: string): string[] {
    const ids = this.openDispatchIds().filter(
      (id) => this.records.get(id)?.workspaceId === workspaceId
    )
    return this.interruptEach(ids, why)
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
   * The dispatch is over: free the agent's slot and disarm the tracker (F8).
   * Clearing the stamp matters most for the outcomes that produce NO turn —
   * a failed delivery would otherwise leave the id armed and attribute the
   * agent's next human turn to a dispatch nobody is waiting on.
   */
  private release(record: DispatchRecord): void {
    if (this.reserved.get(record.agentId) === record.id) this.reserved.delete(record.agentId)
    this.deps.clearDispatch?.(record.agentId, record.id)
    this.prune()
  }

  /**
   * Keep the in-memory maps bounded (F17). Only CLOSED dispatches are
   * droppable, and dropping one takes its idempotency key with it — so the
   * window is a week rather than a handful, and an open dispatch is never
   * pruned however old it is.
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
      if (record.idempotencyKey !== undefined && this.byKey.get(record.idempotencyKey) === record.id) {
        this.byKey.delete(record.idempotencyKey)
      }
    })
  }

  private write(record: DispatchRecord): void {
    this.records.set(record.id, record)
    this.deps.persist(record)
  }
}
