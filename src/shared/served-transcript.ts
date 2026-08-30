import type { TracePage } from './trace-blocks'
import type { TurnPage, TurnRecord } from './turn'

/** Stable caller-scoped routes. None accepts a terminal, workspace, or session id. */
export const SERVED_TRANSCRIPT_PATHS = Object.freeze({
  turns: '/turns',
  trace: '/trace',
  traceIndex: '/trace/index',
  traceMarkers: '/trace/markers'
} as const)

export type ServedTranscriptPath =
  (typeof SERVED_TRANSCRIPT_PATHS)[keyof typeof SERVED_TRANSCRIPT_PATHS]

export type ServedTraceSource = 'claude' | 'codex' | 'pi' | null
export type ServedTracePage = TracePage & { source: ServedTraceSource }
export type ServedTurnsWireResponse = TurnRecord[] | TurnPage
