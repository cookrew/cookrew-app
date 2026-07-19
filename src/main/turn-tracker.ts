import { EventEmitter } from 'node:events'
import type { PtySession } from './pty'
import { diffOutput } from './ask'
import {
  TerminalActivity,
  TurnPhase,
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

interface TrackedTerminal {
  session: PtySession
  agent: boolean
  phase: TurnPhase
  promptBuffer: string
  prompt: string | null
  snapshot: string
  reply: string | null
  turnStartedAt: number
  pushTimer: NodeJS.Timeout | null
  pollTimer: NodeJS.Timeout | null
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
      turnStartedAt: 0,
      pushTimer: null,
      pollTimer: null,
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
    t.turnStartedAt = Date.now()
    if (!t.pollTimer) {
      t.pollTimer = setInterval(() => this.poll(t), POLL_MS)
    }
    this.push(t)
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
    if (t.pollTimer) {
      clearInterval(t.pollTimer)
      t.pollTimer = null
    }
    this.push(t)
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
      turnStartedAt: inTurn ? t.turnStartedAt : null,
      updatedAt: Date.now()
    }
  }
}
