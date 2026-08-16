import { EventEmitter } from 'node:events'
import type { PtySession } from './pty'
import { sessionNameFor } from './pty'
import { diffOutput } from './ask'
// The dispatch engine's own prompt-identity rule, reused verbatim: ONE
// normalization decides both "did the prompt land?" and "is this turn the
// dispatched one?" — two rules would let a prompt land under one and never
// complete under the other.
import { promptAnswersDispatch } from './dispatch'
import { agentStatus } from './herdr-agent-status'
import { summarizeTurn, TurnSummarizer } from './sous'
import type { TurnStore } from './turn-store'
import {
  RECOVERED_PROMPT_LABEL,
  TerminalActivity,
  TurnPhase,
  TurnRecord,
  appendTurnRecord,
  cleanTurnLines,
  dedupePhantomEchoes,
  detectAgentActivity,
  isCommandPrompt,
  detectAttention,
  detectLiveWork,
  extractPromptEcho,
  feedPromptBuffer,
  isLiveStatus,
  latestTailLines,
  parseAgentGlance,
  scrollLineOf,
  tailLines
} from '../shared/turn'

/** Output silence that counts as "the agent finished its turn". */
const QUIESCENCE_MS = 2500
/**
 * How long a herdr 'working' report holds a turn open with NO output at all.
 * Long enough for slow silent tool calls, short enough that a detector stuck
 * at 'working' cannot pin a turn open for the rest of the run.
 */
const WORKING_TRUST_MS = 60_000
/**
 * An Enter that started no turn counts as "pending input" for this long —
 * agent output arriving within the window re-enters 'thinking' (self-heal).
 */
const RESUME_WINDOW_MS = 30_000
/** Min gap between rendered-screen scans in the self-heal path. */
const HEAL_SCAN_MS = 1000
/**
 * Paced Sous title-backfill: one record per tick so a burst never trips the
 * summarizer's down-cooldown (which would null out a whole sequential pass).
 */
const BACKFILL_TICK_MS = 2000
/** Cooldown before retrying the SAME record — lets a bad/slow one not starve the rest. */
const BACKFILL_RETRY_MS = 60_000
/** Minimum turn duration before quiescence may end it (agent spin-up). */
const GRACE_MS = 1500
const POLL_MS = 400
const PUSH_THROTTLE_MS = 250
const SUMMARY_TAIL = 14
const REPLY_TAIL = 60
/**
 * First Sous title request fires almost immediately — the prompt alone is
 * enough for a first title, and many real turns finish within seconds.
 */
const TITLE_FIRST_MS = 800
/** While the turn keeps running, refresh the Sous title at this cadence. */
const TITLE_REFRESH_MS = 15_000

/** Tolerance between tracker turn start and the session prompt entry time. */
const IN_FLIGHT_STAMP_SLACK_MS = 5000

/** Normalized-prefix prompt equality for carrying titles across reconciles. */
const PROMPT_MATCH_CHARS = 48

function promptsMatch(scraped: string, exact: string): boolean {
  if (scraped.length === 0 || scraped === RECOVERED_PROMPT_LABEL) return true
  const key = (s: string): string =>
    s.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, PROMPT_MATCH_CHARS)
  return key(scraped) === key(exact)
}

/**
 * Find the prior record that is the SAME exchange as `record`, for carrying
 * over the Sous title / read marker on reconcile:
 * - exact message-uuid match wins (survives an index shift from a rewind);
 * - otherwise fall back to same index + matching prompt, which MIGRATES a
 *   legacy titled record (persisted before uuid-stamping, so it has no uuid)
 *   onto its now-uuid-bearing successor — but NOT across a genuine rewind,
 *   where the prior at that index carries a different uuid.
 */
function matchPrior(
  record: TurnRecord,
  byUuid: Map<string | undefined, TurnRecord>,
  byIndex: Map<number, TurnRecord>
): TurnRecord | undefined {
  if (record.uuid && byUuid.has(record.uuid)) return byUuid.get(record.uuid)
  const at = byIndex.get(record.index)
  if (!at) return undefined
  if (record.uuid && at.uuid && at.uuid !== record.uuid) return undefined
  return promptsMatch(at.prompt, record.prompt) ? at : undefined
}

interface TrackedTerminal {
  session: PtySession
  agent: boolean
  phase: TurnPhase
  promptBuffer: string
  /** Open bracketed paste spanning input chunks (feedPromptBuffer state). */
  inPaste: boolean
  /** Partial paste marker withheld between input chunks (feedPromptBuffer). */
  heldInput: string
  /** Epoch ms of the last Enter that did NOT start or answer a turn; 0 when consumed. */
  lastSubmitAt: number
  /**
   * Sticky per-turn flag: has the CURRENT turn seen any user input since it
   * opened? Set on typing/submit; reset only when a turn opens from NON-input
   * (a boot-noise self-heal). Unlike lastSubmitAt (which resumeThinking
   * resets to 0), this survives a resume, so a first ask that merges into a
   * boot phantom is never mistaken for input-less boot noise at finalize.
   */
  sawInputThisTurn: boolean
  /** Epoch ms of the last self-heal viewport scan (throttle). */
  lastHealScanAt: number
  prompt: string | null
  snapshot: string
  /** Scrollback line where the current turn began (checkpoint mapping). */
  turnStartLine: number | null
  reply: string | null
  /** Latest Sous (local model) summary of the current turn. */
  title: string | null
  /** Bumped on every turn start so stale summaries are dropped. */
  titleGen: number
  turnStartedAt: number
  pushTimer: NodeJS.Timeout | null
  pollTimer: NodeJS.Timeout | null
  titleTimer: NodeJS.Timeout | null
  onInput: (data: string) => void
  onData: (data: string) => void
  onExit: () => void
}

/**
 * A dispatch waiting for this terminal's next completed turn (v4 §3). The
 * stamp is set by the dispatch service just before the prompt goes out and
 * consumed by the first turn to finish, so the correlation cannot leak onto a
 * later turn the caller never asked for.
 */
interface PendingDispatch {
  id: string
  /**
   * What the dispatch actually asked. Completion demands prompt IDENTITY, not
   * just a start time after the arming — a human ask racing the dispatch into
   * the same agent also starts a turn after armedAt, and a stamp consumed by
   * timestamp alone would bill the caller for that stranger's exchange.
   */
  prompt: string
  /** Prevents a dispatch from claiming a turn already in flight when it armed. */
  armedAt: number
}

/**
 * Payload of the tracker's 'turn' event: one real exchange finished, and how
 * long the agent took over it. Deliberately just the two facts — the terminal
 * to attribute it to and the milliseconds — so nothing about the conversation
 * can ride out to the event log on it.
 */
export interface CompletedTurn {
  terminalId: string
  /** Milliseconds from the turn opening ('thinking') to 'replied'. */
  durationMs: number
  /**
   * The dispatch this turn answers (v4 §3), when the work arrived over the
   * API rather than from a human at the keyboard. Absent otherwise — an
   * agent's own next turn is nobody's dispatch, and correlating it to one
   * would invent an attribution.
   */
  dispatchId?: string
}

/**
 * Watches every PTY and derives per-terminal turn state for the summary
 * cards: Enter starts a turn ('thinking', streaming the new-output tail as a
 * live thinking chain), output quiescence ends it ('replied', exposing the
 * cleaned reply). Shell terminals just stream a viewport tail.
 */
export class TurnTracker extends EventEmitter {
  private tracked = new Map<string, TrackedTerminal>()

  /** Both injectable for tests; store null = in-memory only. */
  constructor(
    private summarize: TurnSummarizer = summarizeTurn,
    private store: TurnStore | null = null
  ) {
    super()
  }

  /**
   * Completed turns per terminal. Kept OUTSIDE `tracked` so history survives
   * untrack/re-track cycles (workspace switches reattach the same tmux
   * session). It is NOT dropped on kill (the R2 recovery net keeps it as a
   * session-matching signal); clearHistory remains for explicit purges only.
   * Backed by TurnStore files (~/.cookrew/turns) so restarts keep it too —
   * terminal ids are stable across runs.
   */
  private histories = new Map<string, TurnRecord[]>()

  /**
   * Terminals whose DURABLE history is written by the session file, not by
   * this tracker (step 4: narrow the scrape). SessionTurnSync owns this flag
   * and sets it only after a reconcile has actually landed — never from the
   * harness declaration alone.
   *
   * That distinction is the whole safety property. Between spawn and the
   * first session-file write there is a real window in which the file cannot
   * record anything yet; a terminal flagged on its harness's say-so would
   * record NOTHING in that window and lose those turns silently. Default is
   * scrape, so the only way to switch a terminal off the scrape is for
   * something to have proven the file path works for it.
   */
  private fileBacked = new Set<string>()

  /**
   * terminalId → the dispatch its NEXT completed turn answers (v4 §3). Set by
   * the dispatch service just before the prompt goes out and consumed on the
   * first eligible turn end.
   */
  private pendingDispatch = new Map<string, PendingDispatch>()

  /** Paced Sous title-backfill pump for historical untitled records. */
  private backfillTimer: NodeJS.Timeout | null = null
  private backfillInFlight = false
  /** Last backfill attempt per record ("terminalId:index" → epoch ms). */
  private backfillAttempt = new Map<string, number>()

  /** Completed turns for a terminal, oldest first (lazy-loaded from disk). */
  history(terminalId: string): TurnRecord[] {
    const cached = this.histories.get(terminalId)
    if (cached) return cached
    const loaded = this.store?.load(terminalId) ?? []
    this.histories.set(terminalId, loaded)
    return loaded
  }

  /**
   * Session-file reconcile (SessionTurnSync): replace a terminal's history
   * with records derived from its Claude session JSONL — the source of truth
   * for session-bound terminals. Sous titles and the acknowledge-on-view
   * marker carry over per the EXACT SAME EXCHANGE: by message uuid when the
   * record has one (survives an index shift when a mid-history turn is
   * rewound; a reused index with a new uuid does NOT inherit), else by
   * index + prompt for legacy records without a uuid. Shrinking is expected:
   * after /rewind the rewound turns disappear so counts match reality.
   */
  replaceHistory(terminalId: string, records: TurnRecord[]): void {
    const previous = this.history(terminalId)
    const byUuid = new Map(previous.filter((r) => r.uuid).map((r) => [r.uuid, r]))
    const byIndex = new Map(previous.map((r) => [r.index, r]))
    const merged = records.map((record) => {
      const prior = matchPrior(record, byUuid, byIndex)
      if (!prior) return record
      // Same exchange: carry over what the reconcile source can't know —
      // the Sous title and the acknowledge-on-view read marker.
      return {
        ...record,
        ...(prior.title !== undefined ? { title: prior.title } : {}),
        ...(prior.seenAt !== undefined ? { seenAt: prior.seenAt } : {}),
        // Screen offsets exist only on live-scraped records — the session
        // file has no screen coordinates, so the reconcile must keep them.
        ...(prior.scrollLine !== undefined ? { scrollLine: prior.scrollLine } : {})
      }
    })
    const stamped = this.stampInFlightScrollLine(terminalId, merged)
    // No cap. History used to be trimmed because every save rewrote the whole
    // file; the store appends now, so keeping all of it costs one line per
    // turn. Conductor had 220 checkpoints trimmed away under the old limit.
    const deduped = dedupePhantomEchoes(stamped)
    this.histories.set(terminalId, deduped)
    this.store?.scheduleSave(terminalId, deduped)
    const t = this.tracked.get(terminalId)
    if (t) this.push(t)
    this.ensureBackfillPump()
  }

  /**
   * Regenerate Sous titles for records that reconciled in without one — the
   * historical turns whose title was lost from disk before carryover existed,
   * and any turn Sous never got to title. Carryover keeps the records that DID
   * hold a title; this fills only genuine gaps.
   *
   * PACED, not burst: one record per tick, single-flight. A tight sequential
   * loop over dozens of records trips the summarizer's down-cooldown on the
   * first slow/failed call and nulls out the whole rest of the pass — this
   * pump instead attempts one record every BACKFILL_TICK_MS, so a cooldown
   * only costs the next tick. Oldest untitled first (Conductor T1 before its
   * later turns); a per-record retry cooldown keeps one unfittable or
   * down-Sous record from starving the others. Independent of reconcile, so
   * idle agents' histories backfill too. Stops itself when nothing is left.
   */
  private ensureBackfillPump(): void {
    if (this.backfillTimer || !this.hasUntitled()) return
    this.backfillTimer = setInterval(() => void this.backfillTick(), BACKFILL_TICK_MS)
    this.backfillTimer.unref?.()
  }

  private stopBackfillPump(): void {
    if (this.backfillTimer) clearInterval(this.backfillTimer)
    this.backfillTimer = null
  }

  private hasUntitled(): boolean {
    for (const records of this.histories.values()) {
      if (records.some((r) => r.title === undefined && (r.reply.length > 0 || r.prompt.length > 0))) {
        return true
      }
    }
    return false
  }

  /** Oldest untitled record not attempted within the retry cooldown. */
  private nextBackfill(): { terminalId: string; record: TurnRecord; key: string } | null {
    const now = Date.now()
    for (const [terminalId, records] of this.histories) {
      for (const record of records) {
        if (record.title !== undefined) continue
        if (record.reply.length === 0 && record.prompt.length === 0) continue
        const key = `${terminalId}:${record.index}`
        if (now - (this.backfillAttempt.get(key) ?? 0) < BACKFILL_RETRY_MS) continue
        return { terminalId, record, key }
      }
    }
    return null
  }

  private async backfillTick(): Promise<void> {
    if (this.backfillInFlight) return
    if (!this.hasUntitled()) {
      this.stopBackfillPump()
      return
    }
    const next = this.nextBackfill()
    if (!next) return // all untitled are in cooldown — a later tick retries
    this.backfillInFlight = true
    this.backfillAttempt.set(next.key, Date.now())
    try {
      const title = await this.summarize({
        prompt: next.record.prompt,
        tools: [],
        lines: next.record.reply.split('\n')
      })
      if (title === null) return // Sous down / cooldown; retried after BACKFILL_RETRY_MS
      const current = this.histories.get(next.terminalId)
      const live = current?.find((r) => r.index === next.record.index)
      // Skip if the turn was rewound / already titled while we summarized.
      if (!current || !live || live.title !== undefined) return
      if (live.uuid !== next.record.uuid || live.prompt !== next.record.prompt) return
      const updated = current.map((r) => (r.index === next.record.index ? { ...r, title } : r))
      this.histories.set(next.terminalId, updated)
      this.store?.scheduleSave(next.terminalId, updated)
      const t = this.tracked.get(next.terminalId)
      if (t) this.push(t)
    } finally {
      this.backfillInFlight = false
    }
  }

  /**
   * scrollLine for the LIVE turn (Magpie E2 gap): Claude writes the prompt
   * entry the moment a turn starts, so the reconcile usually replaces
   * history BEFORE the scraped record — the scrollLine carrier — exists,
   * and the scrape's later append is dropped as a phantom echo. While a
   * turn is in flight, stamp the incoming record that covers it straight
   * from the tracker's live turnStartLine. Guards: only the NEWEST record,
   * only when its prompt matches the live one and its start time is not
   * older than the live turn (a reconcile from a pre-turn write must never
   * inherit the new turn's offset).
   */
  private stampInFlightScrollLine(terminalId: string, records: TurnRecord[]): TurnRecord[] {
    const t = this.tracked.get(terminalId)
    const inFlight = t && (t.phase === 'thinking' || t.phase === 'waiting')
    if (!t || !inFlight || t.turnStartLine === null || records.length === 0) return records
    const last = records[records.length - 1]
    const covers =
      last.scrollLine === undefined &&
      promptsMatch(t.prompt ?? '', last.prompt) &&
      last.startedAt >= t.turnStartedAt - IN_FLIGHT_STAMP_SLACK_MS
    if (!covers) return records
    return [...records.slice(0, -1), { ...last, scrollLine: t.turnStartLine }]
  }

  /**
   * Acknowledge-on-view: 'replied' (TURN COMPLETE) means UNREAD, and it
   * demotes to 'idle' exactly when the user views the result — the terminal
   * overlay mounts (desktop zoom / phone popout) or the next prompt starts a
   * new turn. Prompt, reply and title stay untouched so READY keeps showing
   * the exchange; only the fresh-result emphasis drops. Never a TTL — unread
   * results must not silently expire — and never from any other phase (a
   * glance must not end a live or waiting turn).
   */
  seen(terminalId: string): void {
    const t = this.tracked.get(terminalId)
    if (!t || t.phase !== 'replied') return
    t.phase = 'idle'
    this.markLastRecordSeen(terminalId)
    this.push(t)
  }

  /** Persist the read marker so unread state survives restarts/switches. */
  private markLastRecordSeen(terminalId: string): void {
    const history = this.history(terminalId)
    const last = history[history.length - 1]
    if (!last || last.seenAt !== undefined) return
    const updated = [...history.slice(0, -1), { ...last, seenAt: Date.now() }]
    this.histories.set(terminalId, updated)
    this.store?.scheduleSave(terminalId, updated)
  }

  /**
   * Declare where a terminal's durable history comes from. Called by
   * SessionTurnSync: 'file' after a reconcile lands, 'scrape' when the watch
   * starts or rebinds (a new session file has to prove itself again) and when
   * it stops. Everything else — plain shells, scrape-only harnesses, and any
   * file harness whose session file has not appeared — stays on 'scrape',
   * which is the default and needs no call.
   */
  setHistorySource(terminalId: string, source: 'file' | 'scrape'): void {
    if (source === 'file') this.fileBacked.add(terminalId)
    else this.fileBacked.delete(terminalId)
  }

  /**
   * Attribute this terminal's next completed turn to a dispatch (v4 §3).
   *
   * Stamped BEFORE the prompt is submitted, because a fast agent can finish
   * inside the submission call and a correlation applied afterwards would miss
   * its own turn. One dispatch, one turn: the stamp is consumed on use.
   *
   * REFUSES to overwrite a live stamp, returning false. A terminal carries at
   * most one pending dispatch because it produces one turn at a time; taking
   * the second would close the newcomer with the incumbent's turn and leave
   * the incumbent open forever — two dispatches, one answer.
   */
  noteDispatch(terminalId: string, dispatchId: string, prompt: string): boolean {
    const held = this.pendingDispatch.get(terminalId)
    if (held !== undefined) return held.id === dispatchId
    this.pendingDispatch.set(terminalId, { id: dispatchId, prompt, armedAt: Date.now() })
    return true
  }

  /**
   * Is a dispatch stamp armed on this terminal? The HTTP input producers
   * (/input, /ask) serialize on this: a second producer typing into an agent
   * mid-dispatch would interleave two principals' work in one input box AND
   * poison the prompt-identity correlation for both. Local canvas typing is
   * deliberately not gated — the owner at the keyboard outranks the machinery.
   */
  hasArmedDispatch(terminalId: string): boolean {
    return this.pendingDispatch.has(terminalId)
  }

  /**
   * Is a live PTY scrape-tracking this terminal right now? Dispatch
   * acceptance asks this: an agent with neither a file observer nor a scrape
   * has nobody to witness its turn, and accepting work for it would pin a
   * watch on nothing.
   */
  isTracked(terminalId: string): boolean {
    return this.tracked.has(terminalId)
  }

  /**
   * Does the tracker believe a turn is running here? Live scrape phase when a
   * PTY is attached; detached, the only witnesses are herdr's push feed (a
   * positive working/blocked claim) and an armed dispatch (work this app
   * itself submitted). Gates the staleness report — a quiet file under an
   * agent nobody believes is working is rest, not rotation.
   */
  inTurn(terminalId: string): boolean {
    const t = this.tracked.get(terminalId)
    if (t) return t.phase === 'thinking' || t.phase === 'waiting'
    if (this.pendingDispatch.has(terminalId)) return true
    const reported = agentStatus(sessionNameFor(terminalId))
    return reported === 'working' || reported === 'blocked'
  }

  /**
   * Drop a stamp whose dispatch ended without producing a turn (failed
   * delivery, interrupt). Matched on the id so a dispatch that has already
   * been superseded cannot disarm its successor.
   */
  clearDispatch(terminalId: string, dispatchId: string): void {
    if (this.pendingDispatch.get(terminalId)?.id !== dispatchId) return
    this.pendingDispatch.delete(terminalId)
  }

  /**
   * File-observer dispatch closure (v5 A2): for a FILE-BACKED terminal the
   * durable history the session-file reconcile maintains is the only witness
   * that counts, so this is the ONE closer for its dispatches — the scrape,
   * even when a live PTY exists, only reports latency (emitCompletedTurn
   * stands down from the stamp). One authority, one closer: two closers
   * racing was how a dispatch got billed against a history tail the
   * reconcile had not written yet.
   *
   * Called by the sync on quiet polls. Closing takes ALL of:
   * - file authority (`writesFromFile`) — closure must read the durable row
   *   it bills against; a scrape-only terminal has no such row and its own
   *   path closes it;
   * - a tail record with a reply AND `final === true` — finality, not quiet,
   *   is the evidence: an assistant text block followed by a tool call looks
   *   exactly like a finished reply until the tool result lands, and the
   *   parser stamps `final` only on positive end-of-turn evidence (absent
   *   means "maybe still running", which for billing-grade closure means NO);
   * - the armedAt guard — a turn that opened before the dispatch armed is
   *   somebody else's exchange;
   * - prompt identity — timestamp order is eligibility, the prompt is proof.
   */
  completeFromHistory(terminalId: string): void {
    const pending = this.pendingDispatch.get(terminalId)
    if (pending === undefined || !this.writesFromFile(terminalId)) return
    const records = this.histories.get(terminalId)
    const last = records?.[records.length - 1]
    if (!last || last.reply.length === 0) return
    if (last.final !== true) return
    if (last.startedAt < pending.armedAt) return
    if (!promptAnswersDispatch(last.prompt, pending.prompt)) return
    this.pendingDispatch.delete(terminalId)
    this.emit('turn', {
      terminalId,
      durationMs: Math.max(0, last.endedAt - last.startedAt),
      dispatchId: pending.id
    } satisfies CompletedTurn)
  }

  /**
   * Announce a finished exchange (the latency sample rides this for every
   * terminal), consuming the pending-dispatch stamp ONLY where the scrape is
   * the closing authority — a scrape-only terminal. A file-backed terminal's
   * stamp belongs to completeFromHistory: consuming it here, at
   * screen-settled time, let the correlation close against a history tail
   * the reconcile had not written yet. Where the scrape does own closure it
   * demands the same two proofs as the file path: the turn opened after the
   * dispatch armed (a human turn already in flight when the dispatch arrived
   * is somebody else's exchange) and the live turn's prompt matches the
   * dispatched one.
   */
  private emitCompletedTurn(
    terminalId: string,
    durationMs: number,
    startedAt: number,
    prompt: string | null
  ): void {
    const pending = this.writesFromFile(terminalId)
      ? undefined
      : this.pendingDispatch.get(terminalId)
    const owns =
      pending !== undefined &&
      startedAt >= pending.armedAt &&
      prompt !== null &&
      promptAnswersDispatch(prompt, pending.prompt)
    if (owns) this.pendingDispatch.delete(terminalId)
    this.emit('turn', {
      terminalId,
      durationMs,
      ...(owns ? { dispatchId: pending.id } : {})
    } satisfies CompletedTurn)
  }

  /** True when the session file owns this terminal's durable history. */
  private writesFromFile(terminalId: string): boolean {
    return this.fileBacked.has(terminalId)
  }

  /** Forget a removed terminal's turns (node deletion, not detach). */
  clearHistory(terminalId: string): void {
    this.histories.delete(terminalId)
    this.store?.remove(terminalId)
    this.fileBacked.delete(terminalId)
  }

  /** Write out pending history saves now (app quit). */
  flushHistories(): void {
    this.store?.flushAll()
  }

  track(session: PtySession, agent: boolean): void {
    if (this.tracked.has(session.terminalId)) return
    const t: TrackedTerminal = {
      session,
      agent,
      phase: 'idle',
      promptBuffer: '',
      inPaste: false,
      heldInput: '',
      lastSubmitAt: 0,
      sawInputThisTurn: false,
      lastHealScanAt: 0,
      prompt: null,
      snapshot: '',
      turnStartLine: null,
      reply: null,
      title: null,
      titleGen: 0,
      turnStartedAt: 0,
      pushTimer: null,
      pollTimer: null,
      titleTimer: null,
      onInput: (data) => this.handleInput(session.terminalId, data),
      onData: (data) => this.handleData(session.terminalId, data),
      onExit: () => this.handleExit(session.terminalId)
    }
    // Restore the last exchange across restarts and workspace switches:
    // cards render ask+reply from tracker state, which would otherwise come
    // back blank-idle even though history survived on disk. An unread last
    // turn returns as 'replied' (TURN COMPLETE) — a restart must not count
    // as acknowledgement. A mid-turn agent self-heals to 'thinking' from its
    // live spinner output moments later.
    if (agent) {
      const history = this.history(session.terminalId)
      const last = history[history.length - 1]
      if (last) {
        t.prompt = last.prompt
        t.reply = last.reply
        t.title = last.title ?? null
        t.phase = last.seenAt === undefined ? 'replied' : 'idle'
      }
    }
    session.on('input', t.onInput)
    session.on('data', t.onData)
    session.on('exit', t.onExit)
    this.tracked.set(session.terminalId, t)
  }

  /**
   * On process exit, broadcast a final idle activity so cards don't freeze
   * mid-'thinking' — without touching the (possibly disposed) screen buffer.
   */
  private handleExit(terminalId: string): void {
    const t = this.tracked.get(terminalId)
    if (t) {
      this.emit('activity', {
        terminalId,
        agent: t.agent,
        phase: 'idle',
        prompt: t.prompt,
        pendingInput: null,
        lines: ['— process exited —'],
        reply: t.reply,
        glance: null,
        title: t.title,
        turnCount: this.history(terminalId).length,
        turnStartedAt: null,
        turnStartLine: null,
        scrollRow: null,
        scrollBase: null,
        tailLines: null,
        updatedAt: Date.now()
      } satisfies TerminalActivity)
    }
    this.untrack(terminalId)
  }

  untrack(terminalId: string): void {
    const t = this.tracked.get(terminalId)
    if (!t) return
    if (t.pushTimer) clearTimeout(t.pushTimer)
    if (t.pollTimer) clearInterval(t.pollTimer)
    if (t.titleTimer) clearTimeout(t.titleTimer)
    t.session.removeListener('input', t.onInput)
    t.session.removeListener('data', t.onData)
    t.session.removeListener('exit', t.onExit)
    this.tracked.delete(terminalId)
  }

  list(): TerminalActivity[] {
    return [...this.tracked.keys()].map((id) => this.activityOf(id)).filter(
      (a): a is TerminalActivity => a !== null
    )
  }

  disposeAll(): void {
    this.stopBackfillPump()
    for (const id of [...this.tracked.keys()]) this.untrack(id)
    // Deliberately NOT cleared by untrack: a workspace switch detaches the
    // view while the agent keeps working, and the stamp must survive to meet
    // the turn when the terminal is re-tracked. Only full teardown drops it —
    // the dispatch side (clearDispatch) handles every per-dispatch ending.
    this.pendingDispatch.clear()
  }

  private handleInput(terminalId: string, data: string): void {
    const t = this.tracked.get(terminalId)
    if (!t) return
    const fed = feedPromptBuffer(t.promptBuffer, data, t.inPaste, t.heldInput)
    t.promptBuffer = fed.buffer
    t.inPaste = fed.inPaste
    t.heldInput = fed.held
    if (!t.agent) return
    if (fed.submitted.length > 0) t.lastSubmitAt = Date.now()
    if (fed.submitted.length > 0 || fed.buffer.trim().length > 0) t.sawInputThisTurn = true
    if (t.phase === 'waiting' && fed.submitted.length > 0 && t.prompt !== null) {
      // Enter on an approval/question menu answers the SAME real turn — resume
      // thinking with the original prompt and snapshot intact. A PROMPTLESS
      // 'waiting' turn is a self-heal boot phantom (e.g. a fresh Codex whose
      // boot screen tripped attention detection), NOT a menu to answer — the
      // submitted text is the real first prompt, so fall through to startTurn.
      t.phase = 'thinking'
      t.lastSubmitAt = 0
      this.push(t)
      return
    }
    const prompt = fed.submitted.filter((s) => s.length > 0).pop()
    if (prompt !== undefined) {
      this.startTurn(t, prompt)
      return
    }
    // No submit: the input box content changed (typing, paste) — surface it
    // as pendingInput on the next throttled push.
    this.schedulePush(terminalId)
  }

  private startTurn(t: TrackedTerminal, prompt: string): void {
    t.snapshot = t.session.fullText()
    // Monotonic tmux anchor when available; the screen-derived count is the
    // non-tmux fallback only (under tmux it saturates at pane rows).
    t.turnStartLine = t.session.scrollAnchor?.() ?? scrollLineOf(t.snapshot)
    t.phase = 'thinking'
    t.lastSubmitAt = 0
    t.sawInputThisTurn = true
    t.prompt = prompt
    t.reply = null
    t.title = null
    t.titleGen += 1
    t.turnStartedAt = Date.now()
    if (!t.pollTimer) {
      t.pollTimer = setInterval(() => this.poll(t), POLL_MS)
    }
    this.scheduleTitle(t, TITLE_FIRST_MS)
    this.push(t)
  }

  private scheduleTitle(t: TrackedTerminal, delay: number): void {
    if (t.titleTimer) clearTimeout(t.titleTimer)
    t.titleTimer = setTimeout(() => {
      t.titleTimer = null
      void this.refreshTitle(t)
    }, delay)
  }

  /**
   * Ask the local model (Sous) what the running turn is doing and surface it
   * as the card title. Best effort: a summarizer returning null (no Ollama,
   * timeout) leaves the title untouched, and a generation bump — a new turn
   * started while the request was in flight — discards the stale result.
   */
  private async refreshTitle(t: TrackedTerminal): Promise<void> {
    if (t.phase !== 'thinking' && t.phase !== 'waiting') return
    const gen = t.titleGen
    const delta = diffOutput(t.snapshot, t.session.fullText())
    const title = await this.summarize({
      prompt: t.prompt ?? '',
      tools: parseAgentGlance(delta).tools,
      lines: cleanTurnLines(delta)
    })
    if (this.tracked.get(t.session.terminalId) !== t || t.titleGen !== gen) return
    if (t.phase !== 'thinking' && t.phase !== 'waiting') return
    if (title !== null && title !== t.title) {
      t.title = title
      this.push(t)
    }
    this.scheduleTitle(t, TITLE_REFRESH_MS)
  }

  /**
   * New output while 'waiting' means the human answered (or the agent moved
   * on) — resume 'thinking' so quiescence re-evaluates. Menu redraws flip
   * back and forth harmlessly: quiet + question tail lands on 'waiting'
   * again.
   *
   * Agent output while 'replied'/'idle' is a tracker desync (missed turn
   * start, premature quiescence, tmux reattach mid-turn) — self-heal so a
   * working agent can never stay stuck on a green or idle card.
   */
  private handleData(terminalId: string, data: string): void {
    const t = this.tracked.get(terminalId)
    if (!t) return
    if (t.phase === 'waiting') {
      t.phase = 'thinking'
    } else if (
      t.agent &&
      (t.phase === 'replied' || t.phase === 'idle') &&
      this.shouldSelfHeal(t, data)
    ) {
      this.resumeThinking(t)
    }
    this.schedulePush(terminalId)
  }

  /**
   * Desync signals, in order:
   * - input the tracker saw but never turned into a turn (buffered/pasted
   *   text, or a recent Enter that started nothing) followed by any
   *   agent-transcript output, or
   * - a live spinner in the chunk itself — covers reattach cases where this
   *   tracker never saw the prompt at all, or
   * - a live spinner on the RENDERED screen. tmux repaints changed cells
   *   with cursor addressing, so the spinner line almost never arrives
   *   intact in one chunk; the screen is the reliable source. Throttled —
   *   serializing the viewport on every chunk would be wasteful.
   */
  private shouldSelfHeal(t: TrackedTerminal, chunk: string): boolean {
    if (this.hasPendingInput(t) && detectAgentActivity(chunk)) return true
    if (detectLiveWork(chunk)) return true
    const now = Date.now()
    if (now - t.lastHealScanAt < HEAL_SCAN_MS) return false
    t.lastHealScanAt = now
    return detectLiveWork(t.session.viewportText())
  }

  private hasPendingInput(t: TrackedTerminal): boolean {
    if (t.promptBuffer.trim().length > 0) return true
    return t.lastSubmitAt !== 0 && Date.now() - t.lastSubmitAt < RESUME_WINDOW_MS
  }

  /**
   * Re-enter 'thinking'. From 'replied' this resumes the existing turn
   * context (prompt, snapshot, start time) so the eventual re-completion
   * records the full exchange; from a cold 'idle' (no prior turn) it opens
   * an unlabeled turn anchored at the current buffer state.
   */
  private resumeThinking(t: TrackedTerminal): void {
    if (t.turnStartedAt === 0) {
      t.snapshot = t.session.fullText()
      t.turnStartLine = t.session.scrollAnchor?.() ?? scrollLineOf(t.snapshot)
      t.turnStartedAt = Date.now()
      // The prompt was typed before this tracker existed (reattach) — the
      // TUI's own echo of it is still on screen. Recover it so the card and
      // the eventual TurnRecord show the real prompt, not a synthetic label.
      // Fall back to the still-buffered input: a fresh Codex terminal whose
      // ask pasted the prompt (Enter not yet submitted) has no "> prompt"
      // echo on its boot screen, so recover the prompt we actually captured
      // instead of labelling the first turn '(recovered turn)'.
      t.prompt = extractPromptEcho(cleanTurnLines(t.snapshot)) ?? (t.promptBuffer.trim() || null)
      // Boot-noise until proven otherwise: only mark input-seen if the ask
      // had already buffered a prompt when this phantom opened.
      t.sawInputThisTurn = t.promptBuffer.trim().length > 0
    }
    t.phase = 'thinking'
    t.reply = null
    t.lastSubmitAt = 0
    if (!t.pollTimer) {
      t.pollTimer = setInterval(() => this.poll(t), POLL_MS)
    }
    this.scheduleTitle(t, TITLE_FIRST_MS)
    this.push(t)
  }

  private poll(t: TrackedTerminal): void {
    if (t.phase !== 'thinking') return
    const elapsed = Date.now() - t.turnStartedAt
    if (elapsed < GRACE_MS) return

    // Three questions decide whether this turn is over: is the agent still
    // working, is it blocked on the human, and has it gone quiet.
    //
    // herdr's answer is used ASYMMETRICALLY, and the asymmetry is the fix for
    // a live bug: its per-pane detector can STICK (measured: 'idle' seq 1
    // under a 48s spinner, while a neighbouring pane tracked fine). A stuck
    // 'idle' that is trusted outright bypasses both the quiescence gate and
    // the spinner hold — the turn falsely ends, a checkpoint is minted, output
    // keeps flowing, self-heal reopens the turn, and the card flaps
    // READY → WORKING → endpoint-saved in a loop that spams phantom
    // checkpoints (the user watched it happen).
    //
    // So: a POSITIVE herdr signal ('working', 'blocked') may hold a turn open
    // or mark it waiting — worst case is a late turn end. A NEGATIVE one
    // ('idle') may never end a turn on its own — ending needs the observable
    // corroboration (output quiet AND no live spinner) that was always
    // required before herdr existed. Cheap to check, immune to a stuck feed.
    const reported = agentStatus(t.session.sessionName)
    // Hold while herdr says working — this survives long silent tool calls,
    // which is the feed's real value — but not FOREVER: a detector stuck at
    // 'working' would otherwise pin the turn open for the rest of the run.
    if (reported === 'working' && t.session.idleFor() < WORKING_TRUST_MS) return
    if (t.session.idleFor() < QUIESCENCE_MS) return

    const delta = diffOutput(t.snapshot, t.session.fullText())
    // Agents pause well past quiescence mid-turn (long tool calls, slow
    // output). While the tail still shows an in-flight spinner the turn is
    // NOT over — hold it open, REGARDLESS of what the feed claims: the screen
    // is the corroboration a stuck 'idle' cannot fake.
    const glanceStatus = parseAgentGlance(delta).status
    if (glanceStatus !== null && isLiveStatus(glanceStatus)) return
    const lines = cleanTurnLines(delta).filter((l) => !this.isPromptEcho(l, t.prompt))
    if (reported === 'blocked' || detectAttention(lines)) {
      // Blocked on the human — keep the poll alive; handleData resumes
      // 'thinking' when output flows again.
      t.phase = 'waiting'
      this.push(t)
      return
    }
    // Prefer the parsed final assistant message over the raw tail — the tail
    // includes tool-call noise (Bash(...) / ⎿ result lines).
    const finalMessage = parseAgentGlance(delta).message
    t.reply = finalMessage ?? tailLines(lines, REPLY_TAIL).join('\n').trim()
    t.phase = 'replied'
    const id = t.session.terminalId
    this.stopTurnTimers(t)
    // A promptless self-heal turn that ALSO never saw user input is boot
    // noise — a fresh agent's boot screen (e.g. Codex) tripping self-heal,
    // not an exchange. Recording it as '(recovered turn)' would mint a
    // phantom checkpoint and shift every later index, so discard it (boot
    // output in the reply is not a real turn). A promptless turn that DID see
    // input keeps the synthetic label; session-bound agents additionally get
    // the real turn from the session-file reconcile.
    // Use the STICKY per-turn flag, not lastSubmitAt: resumeThinking resets
    // lastSubmitAt to 0, so a first ask that merged into a boot phantom would
    // otherwise finalize looking input-less and be discarded (the Codex
    // first-ask drop). sawInputThisTurn survives the resume.
    if (t.prompt === null && !t.sawInputThisTurn) {
      this.push(t)
      return
    }
    // A typed slash command (/rewind, /clear …) is a UI action, not an
    // exchange — the session file records it as a command, not a user
    // message, so a scrape checkpoint here would break the 1:1 with the
    // session list. Discard it; a real '/…' prompt is re-added on reconcile.
    if (t.prompt !== null && isCommandPrompt(t.prompt)) {
      this.push(t)
      return
    }
    // A real exchange just ended: announce how long it took (latency spec
    // p95-p98). Emitted HERE, past the two discards above, so the samples are
    // turns somebody actually waited on — never a boot screen tripping
    // self-heal, never a typed slash command. It rides ahead of the two
    // recording paths below because it is true of both: a turn whose durable
    // record belongs to the session file still happened, and still took time.
    //
    // The tracker does not reach the event log itself — index.ts translates
    // this into store.recordEvent, so latency enters through the same
    // choke-point as every other event and cannot diverge from it.
    if (t.turnStartedAt > 0) {
      this.emitCompletedTurn(id, Date.now() - t.turnStartedAt, t.turnStartedAt, t.prompt)
    }
    // STEP 4: the session file is this terminal's record. Appending here would
    // be a second writer of the same exchange — historically it landed a
    // uuid-less duplicate that dedupePhantomEchoes then had to throw away.
    // The live turn above (phase, glance, reply, pendingInput) is still ours;
    // only the durable write belongs to the file. The Sous title does NOT get
    // dropped: it lands on the record the reconcile already created for this
    // turn, and if that record has not arrived yet the backfill pump fills it.
    if (this.writesFromFile(id)) {
      this.push(t)
      const reconciled = this.liveTurnRecordIndex(t)
      if (reconciled !== null) void this.finalizeTitle(t, reconciled)
      return
    }
    const appended = appendTurnRecord(this.history(id), {
      prompt: t.prompt ?? RECOVERED_PROMPT_LABEL,
      reply: t.reply,
      ...(t.title !== null ? { title: t.title } : {}),
      ...(t.turnStartLine !== null ? { scrollLine: t.turnStartLine } : {}),
      startedAt: t.turnStartedAt,
      endedAt: Date.now()
    })
    // A split-echo double-submit lands a uuid-less scrape record next to the
    // reconciled uuid original — drop it here so it never persists or shows,
    // instead of waiting for the next reconcile to full-replace it away.
    const newRecord = appended[appended.length - 1]
    const deduped = dedupePhantomEchoes(appended)
    this.histories.set(id, deduped)
    this.store?.scheduleSave(id, deduped)
    this.push(t)
    // Skip the title pass when the just-appended turn was itself the phantom.
    if (deduped.some((r) => r.index === newRecord.index)) {
      void this.finalizeTitle(t, newRecord.index)
    }
  }

  /**
   * The reconciled record covering the turn that just finished, when it is
   * already there and still untitled — the target for the final Sous pass on
   * a file-backed terminal. Null when the reconcile has not caught up yet
   * (the backfill pump titles it on a later tick) or the record is titled.
   */
  private liveTurnRecordIndex(t: TrackedTerminal): number | null {
    const history = this.history(t.session.terminalId)
    const last = history[history.length - 1]
    if (!last || last.title !== undefined) return null
    return promptsMatch(t.prompt ?? '', last.prompt) ? last.index : null
  }

  private stopTurnTimers(t: TrackedTerminal): void {
    if (t.pollTimer) {
      clearInterval(t.pollTimer)
      t.pollTimer = null
    }
    if (t.titleTimer) {
      clearTimeout(t.titleTimer)
      t.titleTimer = null
    }
  }

  /**
   * Final Sous pass once a turn completed: summarize prompt + full reply and
   * back-fill the freshly appended TurnRecord. This is what gives short
   * turns (which end before any mid-turn refresh fires) their title.
   */
  private async finalizeTitle(t: TrackedTerminal, recordIndex: number): Promise<void> {
    const gen = t.titleGen
    const title = await this.summarize({
      prompt: t.prompt ?? '',
      tools: [],
      lines: (t.reply ?? '').split('\n')
    })
    if (title === null) return
    const id = t.session.terminalId
    const history = this.histories.get(id)
    if (history?.some((r) => r.index === recordIndex)) {
      const updated = history.map((r) => (r.index === recordIndex ? { ...r, title } : r))
      this.histories.set(id, updated)
      this.store?.scheduleSave(id, updated)
    }
    // Only retitle the live card if no new turn started while summarizing.
    if (this.tracked.get(id) === t && t.titleGen === gen && t.phase === 'replied') {
      t.title = title
      this.push(t)
    }
  }

  private isPromptEcho(line: string, prompt: string | null): boolean {
    if (!prompt) return false
    const trimmed = line.trim()
    return trimmed === prompt || trimmed === `> ${prompt}`
  }

  private schedulePush(terminalId: string): void {
    const t = this.tracked.get(terminalId)
    if (!t || t.pushTimer) return
    t.pushTimer = setTimeout(() => {
      t.pushTimer = null
      this.push(t)
    }, PUSH_THROTTLE_MS)
  }

  private push(t: TrackedTerminal): void {
    const activity = this.activityOf(t.session.terminalId)
    if (activity) this.emit('activity', activity)
  }

  private activityOf(terminalId: string): TerminalActivity | null {
    const t = this.tracked.get(terminalId)
    if (!t) return null
    const inTurn = t.phase === 'thinking' || t.phase === 'waiting'
    // The glance parser needs the RAW delta (status lines are chrome that
    // cleanTurnLines strips); the display tail uses the cleaned one.
    const rawDelta = inTurn ? diffOutput(t.snapshot, t.session.fullText()) : ''
    const lines = inTurn
      ? tailLines(
          cleanTurnLines(rawDelta).filter((l) => !this.isPromptEcho(l, t.prompt)),
          SUMMARY_TAIL
        )
      : tailLines(cleanTurnLines(t.session.viewportText()), SUMMARY_TAIL)
    const pending = t.promptBuffer.trim()
    const pane = t.session.paneScrollState?.() ?? { scrollRow: null, historySize: null }
    return {
      terminalId,
      agent: t.agent,
      phase: t.phase,
      prompt: t.prompt,
      pendingInput: pending.length > 0 ? pending : null,
      lines,
      reply: t.reply,
      glance: t.agent && inTurn ? parseAgentGlance(rawDelta) : null,
      title: t.title,
      turnCount: this.history(terminalId).length,
      turnStartedAt: inTurn ? t.turnStartedAt : null,
      turnStartLine: inTurn ? t.turnStartLine : null,
      // ONE combined tmux round-trip for both fields (optional-called; fakes
      // may not implement it). Deliberately NOT gated off during a turn: the
      // user can be in copy-mode WHILE the agent streams (scroll→step's main
      // case), and scrollBase must convert anchors at any time. Cost is one
      // ~2ms display-message per throttled push (≥250ms apart per terminal).
      scrollRow: pane.scrollRow,
      scrollBase: pane.historySize,
      // Clip signal only when the tail is settled — mid-turn the renderer
      // shows the whole live stream anyway.
      tailLines: inTurn || !t.agent ? null : latestTailLines(t.session.fullText()),
      updatedAt: Date.now()
    }
  }
}
