import { EventEmitter } from 'node:events'
import type { PtySession } from './pty'
import { diffOutput } from './ask'
import { summarizeTurn, TurnSummarizer } from './sous'
import type { TurnStore } from './turn-store'
import {
  TerminalActivity,
  TurnPhase,
  TurnRecord,
  appendTurnRecord,
  cleanTurnLines,
  detectAttention,
  feedPromptBuffer,
  parseAgentGlance,
  tailLines
} from '../shared/turn'

/** Output silence that counts as "the agent finished its turn". */
const QUIESCENCE_MS = 2500
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

interface TrackedTerminal {
  session: PtySession
  agent: boolean
  phase: TurnPhase
  promptBuffer: string
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
  onData: () => void
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
      onData: () => this.handleData(session.terminalId),
      onExit: () => this.handleExit(session.terminalId)
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
    const fed = feedPromptBuffer(t.promptBuffer, data)
    t.promptBuffer = fed.buffer
    if (!t.agent) return
    if (t.phase === 'waiting' && fed.submitted.length > 0) {
      // Enter on an approval/question menu answers the SAME turn — resume
      // thinking with the original prompt and snapshot intact.
      t.phase = 'thinking'
      this.push(t)
      return
    }
    const prompt = fed.submitted.filter((s) => s.length > 0).pop()
    if (prompt !== undefined) this.startTurn(t, prompt)
  }

  private startTurn(t: TrackedTerminal, prompt: string): void {
    t.snapshot = t.session.fullText()
    t.phase = 'thinking'
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
   */
  private handleData(terminalId: string): void {
    const t = this.tracked.get(terminalId)
    if (t?.phase === 'waiting') t.phase = 'thinking'
    this.schedulePush(terminalId)
  }

  private poll(t: TrackedTerminal): void {
    if (t.phase !== 'thinking') return
    const elapsed = Date.now() - t.turnStartedAt
    if (elapsed < GRACE_MS || t.session.idleFor() < QUIESCENCE_MS) return
    const delta = diffOutput(t.snapshot, t.session.fullText())
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
    const appended = appendTurnRecord(this.history(id), {
      prompt: t.prompt ?? '',
      reply: t.reply,
      ...(t.title !== null ? { title: t.title } : {}),
      startedAt: t.turnStartedAt,
      endedAt: Date.now()
    })
    this.histories.set(id, appended)
    this.store?.scheduleSave(id, appended)
    if (t.pollTimer) {
      clearInterval(t.pollTimer)
      t.pollTimer = null
    }
    if (t.titleTimer) {
      clearTimeout(t.titleTimer)
      t.titleTimer = null
    }
    this.push(t)
    void this.finalizeTitle(t, appended[appended.length - 1].index)
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
    return {
      terminalId,
      agent: t.agent,
      phase: t.phase,
      prompt: t.prompt,
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
