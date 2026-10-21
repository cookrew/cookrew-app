// The embed's details, one document = one machine, so an agent id is enough.
// At most ONE detail request is in flight per document and the latest asked
// wins: a hover that moves on aborts the read it started, and a focus for
// another agent aborts a prefetch — but a hover never aborts the read a dive
// is waiting on; it is simply not started. A read already under way for the same
// agent is joined, never repeated. What has been read stays, so a switch
// back mounts at once and is read again behind it.
import type { DetailResult, EmbedDetail } from './embed-boot'

export type FetchDetail = (agentId: string, signal: AbortSignal) => Promise<DetailResult>

export interface DetailLoader {
  /** Hover intent: read ahead, mount nothing. Skipped when already known or already under way. */
  prefetch(agentId: string): void
  /** What this document last read for the agent, or null. */
  known(agentId: string): EmbedDetail | null
  /** Read it now (joining a read already under way for it); aborts any read for another agent. */
  load(agentId: string): Promise<DetailResult>
  /** The read in flight, for tests and the budget: null or its agent. */
  inFlight(): string | null
}

export const createDetailLoader = (fetchDetail: FetchDetail): DetailLoader => {
  const cache = new Map<string, EmbedDetail>()
  let current: { agentId: string; kind: 'prefetch' | 'load'; abort: AbortController; result: Promise<DetailResult> } | null = null

  const start = (agentId: string, kind: 'prefetch' | 'load'): Promise<DetailResult> => {
    if (current?.agentId === agentId) {
      if (kind === 'load') current = { ...current, kind }
      return current.result
    }
    current?.abort.abort()
    const abort = new AbortController()
    const result = fetchDetail(agentId, abort.signal).then((outcome) => {
      if (outcome.ok) cache.set(agentId, outcome.detail)
      else if (!abort.signal.aborted) cache.delete(agentId)
      return outcome
    })
    current = { agentId, kind, abort, result }
    void result.finally(() => {
      if (current?.result === result) current = null
    })
    return result
  }

  return {
    prefetch(agentId) {
      if (cache.has(agentId) || current?.agentId === agentId || current?.kind === 'load') return
      void start(agentId, 'prefetch')
    },
    known: (agentId) => cache.get(agentId) ?? null,
    load: (agentId) => start(agentId, 'load'),
    inFlight: () => current?.agentId ?? null
  }
}
