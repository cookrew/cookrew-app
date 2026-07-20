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
  detectAgentActivity,
  detectAttention,
  detectLiveWork,
  extractPromptEcho,
  feedPromptBuffer,
  isLiveStatus,
  parseAgentGlance,
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
   * for session-bound terminals. Sous titles carry over where the turn at an
   * index is still the same exchange (or the scraped prompt was a
   * placeholder). Shrinking is expected: after /rewind the rewound turns
   * disappear so counts match the real conversation.
   */
  replaceHistory(terminalId: string, records: TurnRecord[]): void {
    const byIndex = new Map(this.history(terminalId).map((r) => [r.index, r]))
    const merged = records.map((record) => {
      const prior = byIndex.get(record.index)
      if (!prior || !promptsMatch(prior.prompt, record.prompt)) return record
      // Same exchange: carry over what the reconcile source can't know —
      // the Sous title and the acknowledge-on-view read marker.
      return {
        ...record,
        ...(prior.title !== undefined ? { title: prior.title } : {}),
        ...(prior.seenAt !== undefined ? { seenAt: prior.seenAt } : {})
      }
    })
    const capped =
      merged.length > MAX_TURN_HISTORY ? merged.slice(merged.length - MAX_TURN_HISTORY) : merged
    this.histories.set(terminalId, capped)
    this.store?.scheduleSave(terminalId, capped)
    const t = this.tracked.get(terminalId)
    if (t) this.push(t)
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
    if (t.phase === 'waiting' && fed.submitted.length > 0) {
      // Enter on an approval/question menu answers the SAME turn — resume
      // thinking with the original prompt and snapshot intact.
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
      t.turnStartedAt = Date.now()
      // The prompt was typed before this tracker existed (reattach) — the
      // TUI's own echo of it is still on screen. Recover it so the card and
      // the eventual TurnRecord show the real prompt, not a synthetic label.
      t.prompt = extractPromptEcho(cleanTurnLines(t.snapshot))
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
    // Self-healed turns (opened without ever seeing a prompt) that also
    // produced no visible reply are tracker noise, not exchanges — end the
    // phase but record nothing. Recovered turns WITH real output are kept
    // under a synthetic label so history never shows an empty prompt.
    if (t.prompt === null && t.reply.length === 0) {
      this.push(t)
      return
    }
    const appended = appendTurnRecord(this.history(id), {
      prompt: t.prompt ?? RECOVERED_PROMPT_LABEL,
      reply: t.reply,
      ...(t.title !== null ? { title: t.title } : {}),
      startedAt: t.turnStartedAt,
      endedAt: Date.now()
    })
    this.histories.set(id, appended)
    this.store?.scheduleSave(id, appended)
    this.push(t)
    void this.finalizeTitle(t, appended[appended.length - 1].index)
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
      updatedAt: Date.now()
    }
  }
}
