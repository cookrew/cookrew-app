import { EventEmitter } from 'node:events'
import type { PtySession } from './pty'
import { diffOutput } from './ask'
import { summarizeTurn, TurnSummarizer } from './sous'
import type { TurnStore } from './turn-store'
import {
  MAX_TURN_HISTORY,
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
  parseAgentGlance,
  scrollLineOf,
  tailLines
} from '../shared/turn'

/** Output silence that counts as "the agent finished its turn". */
const QUIESCENCE_MS = 2500
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
   * session); it is only dropped via clearHistory when a node is removed.
   * Backed by TurnStore files (~/.cookrew/turns) so restarts keep it too —
   * terminal ids are stable across runs.
   */
  private histories = new Map<string, TurnRecord[]>()

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
    const deduped = dedupePhantomEchoes(merged)
    const capped =
      deduped.length > MAX_TURN_HISTORY ? deduped.slice(deduped.length - MAX_TURN_HISTORY) : deduped
    this.histories.set(terminalId, capped)
    this.store?.scheduleSave(terminalId, capped)
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

  /** Forget a removed terminal's turns (node deletion, not detach). */
  clearHistory(terminalId: string): void {
    this.histories.delete(terminalId)
    this.store?.remove(terminalId)
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
    t.turnStartLine = scrollLineOf(t.snapshot)
    t.phase = 'thinking'
    t.lastSubmitAt = 0
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
      t.turnStartLine = scrollLineOf(t.snapshot)
      t.turnStartedAt = Date.now()
      // The prompt was typed before this tracker existed (reattach) — the
      // TUI's own echo of it is still on screen. Recover it so the card and
      // the eventual TurnRecord show the real prompt, not a synthetic label.
      // Fall back to the still-buffered input: a fresh Codex terminal whose
      // ask pasted the prompt (Enter not yet submitted) has no "> prompt"
      // echo on its boot screen, so recover the prompt we actually captured
      // instead of labelling the first turn '(recovered turn)'.
      t.prompt = extractPromptEcho(cleanTurnLines(t.snapshot)) ?? (t.promptBuffer.trim() || null)
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
    if (elapsed < GRACE_MS || t.session.idleFor() < QUIESCENCE_MS) return
    const delta = diffOutput(t.snapshot, t.session.fullText())
    // Agents pause well past quiescence mid-turn (long tool calls, slow
    // output). While the tail still shows an in-flight spinner the turn is
    // NOT over — hold it open. Completed-style status ("✻ Brewed for
    // 4m 15s") and spinner-less output fall through to the quiescence rule.
    const status = parseAgentGlance(delta).status
    if (status !== null && isLiveStatus(status)) return
    const lines = cleanTurnLines(delta).filter((l) => !this.isPromptEcho(l, t.prompt))
    if (detectAttention(lines)) {
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
    const sawInput = t.promptBuffer.trim().length > 0 || t.lastSubmitAt !== 0
    if (t.prompt === null && !sawInput) {
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
      updatedAt: Date.now()
    }
  }
}
