import type { AgentPhase } from '../agent-rows'
import type { TurnPhase } from '../../../shared/turn'

/**
 * THE FIVE STATES AN INK AVATAR DRAWS (InkAvatar.tsx · status). Idle is the
 * bare ink; working laps a red third of a turn over the ensō; waiting closes
 * the red ring and blinks it with the harness mark; done is a red tick on the
 * shoulder while the reply is unread; offline fades the ink and writes a z.
 * Pure, so the mapping is tested without a DOM.
 */
export type InkStatus = 'idle' | 'working' | 'waiting' | 'done' | 'failed' | 'offline'
export type CornerMark = 'tick' | 'zee'

const OF_TURN: Record<TurnPhase | 'off', InkStatus> = { idle: 'idle', thinking: 'working', waiting: 'waiting', replied: 'done', off: 'offline' }

export const inkStatusOfTurn = (phase: TurnPhase | 'off'): InkStatus => OF_TURN[phase]

/** An agent row's status: a finished turn ticks only while its reply is unread; once looked at it is idle. */
export function inkStatusOfRow(phase: AgentPhase, unread = false): InkStatus {
  if (phase === 'done') return unread ? 'done' : 'idle'
  if (phase === 'quiet') return 'idle'
  return phase
}

/**
 * THE WORD UNDER A FACE says what the face draws (Gauge, 2026-11-01: agents
 * whose reply was read hours ago said DONE in amber over the bare idle face).
 * A read reply rests, as a quiet agent does; "done", the amber word, is the
 * unread reply only.
 */
const WORD_OF: Record<InkStatus, string> = { idle: 'resting', working: 'working', waiting: 'needs you', failed: 'failed', done: 'done', offline: 'offline' }

export const statusWord = (status: InkStatus): string => WORD_OF[status]

export const cornerOf = (status: InkStatus): CornerMark | null => (status === 'done' ? 'tick' : status === 'offline' ? 'zee' : null)
