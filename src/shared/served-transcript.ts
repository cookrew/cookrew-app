import type { TraceBoundaryMarker, TraceIndexEntry, TracePage, TracePageRequest } from './trace-blocks'
import type { TurnPage, TurnPageRequest, TurnRecord } from './turn'

/** Public address of the served transcript behind one placed crew card. */
export interface ServedTranscriptTarget {
  origin: string
  slug: string
}

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

/**
 * Renderer integration contract for one placed crew card. Unlike the local
 * bridge, there is deliberately no terminalId argument: the Bearer subject and
 * served slug resolve the caller's orch session on the server. Implementations
 * add `Authorization: Bearer ...` internally and treat 404 as no open session.
 */
export interface ServedRemoteTurnSource {
  listTurns(request: TurnPageRequest): Promise<TurnPage>
  listTrace(request: TracePageRequest): Promise<ServedTracePage>
  listTraceIndex(): Promise<TraceIndexEntry[]>
  listTraceMarkers(): Promise<TraceBoundaryMarker[]>
}
