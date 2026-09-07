// THE STREAM OVER HTTP — the phone's transport (one-stream T3).
//
// The five routes T2 stood up, and nothing else. It is deliberately NOT
// remote-api.ts's `req`: that helper is private to the CookrewApi object and
// this client is not a bridge method — the whole point of "one hook" is that
// the rail, the drawer and the pager reach the stream directly instead of
// through six differently-shaped API entries.
//
// AUTH IS THE SAME AUTH. The token rides as a bearer on fetches and as
// `?token=` on the EventSource (which has no headers), exactly as every other
// companion call does; a 401 is reported to the auth store so a stale
// credential raises the re-pair screen here too rather than looking like an
// agent with no history.

import { AuthError, authStore, tokenParam } from '../auth-gate'
import { apiPath } from '../api-base'
import { planeFetch } from '../plane-fetch'
import type {
  MarkPatch,
  StreamBlockPage,
  StreamCursor,
  StreamIndexPage,
  StreamMarks,
  StreamOpen,
  StreamTail,
  TranscriptSource
} from './stream-types'
import type { StreamLiveHandlers, StreamTransport } from './stream-transport'

/** Thrown for a route this build's server does not serve — the one failure
 *  the open fallback is allowed to swallow. Everything else propagates. */
export class StreamRouteAbsent extends Error {
  constructor(path: string) {
    super(`no stream route at ${path}`)
    this.name = 'StreamRouteAbsent'
  }
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const token = authStore().token()
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) }
  if (token) headers.authorization = `Bearer ${token}`
  const response = await planeFetch(path, { ...init, headers })
  if (response.status === 404) throw new StreamRouteAbsent(path)
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string }
    const message = detail.error ?? `HTTP ${response.status}`
    if (response.status === 401) {
      const failure = new AuthError(message, /read-only/i.test(message) ? 'read-only' : 'none')
      authStore().report(failure)
      throw failure
    }
    throw new Error(message)
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

function query(cursor: StreamCursor): string {
  const params = new URLSearchParams()
  if (cursor.after !== undefined) params.set('after', cursor.after)
  if (cursor.before !== undefined) params.set('before', cursor.before)
  // ALWAYS a limit. `GET /stream` without a cursor is the PTY mirror's own
  // path (see the collision note in stream-routes.ts), so a block window that
  // sent no parameters would open a terminal mirror instead of a page.
  params.set('limit', String(cursor.limit ?? 20))
  return params.toString()
}

/** Every stream path, already scoped to the workspace this client was served
 *  for — apiPath wraps the literal HERE so the conformance sweep in
 *  tests/api-base.test.ts can see that it does (a path built in one function
 *  and wrapped in another is exactly the blind spot that sweep exists for). */
const base = (terminalId: string, leaf = ''): string =>
  apiPath(`/api/terminal/${encodeURIComponent(terminalId)}/stream${leaf}`)

/** What today's `/stream/index` answers, before T2.5's pagination. */
interface LegacyIndexAnswer {
  checkpoints: StreamIndexPage['checkpoints']
  missing?: unknown[]
  orphanMarks?: unknown[]
  source: TranscriptSource
  nextCursor?: string | null
  backwardsCursor?: string | null
  total?: number
}

/**
 * ONE OPEN, and — until T2.5 lands — a fallback for a server that has none.
 *
 * <<< FALLBACK: /stream/open, removable in one commit. Everything between
 * this marker and its twin exists only so this branch runs against a dev
 * build whose server predates T2.5. It is a separate commit deliberately. >>>
 */
async function open(terminalId: string): Promise<StreamOpen> {
  try {
    return await readJson<StreamOpen>(base(terminalId, '/open'))
  } catch (error) {
    if (!(error instanceof StreamRouteAbsent)) throw error
    return openFromIndex(terminalId)
  }
}

/**
 * The open, rebuilt from the routes that exist on dev today.
 *
 * The full index is one read (it is the light projection — a head per row,
 * never a body), the tail arrives as the live subscription's first frame, and
 * there is nothing older than a full listing, so the backwards cursor is
 * null. `missing` and `orphanMarks` are counted as anomalies rather than
 * dropped: they are the same "something moved" evidence T2.5 will classify.
 */
async function openFromIndex(terminalId: string): Promise<StreamOpen> {
  const answer = await readJson<LegacyIndexAnswer>(base(terminalId, '/index'))
  const anomalies: Record<string, number> = {}
  if ((answer.missing?.length ?? 0) > 0) anomalies.missingFile = answer.missing!.length
  if ((answer.orphanMarks?.length ?? 0) > 0) anomalies.orphanMark = answer.orphanMarks!.length
  return {
    index: answer.checkpoints ?? [],
    tail: null,
    backwardsCursor: answer.backwardsCursor ?? null,
    source: answer.source,
    anomalies,
    rolledBack: []
  }
}
/** <<< END FALLBACK >>> */

export function createHttpStreamTransport(): StreamTransport {
  return {
    open,
    index: (terminalId, cursor) =>
      readJson<StreamIndexPage>(`${base(terminalId, '/index')}?${query(cursor)}`),
    blocks: (terminalId, cursor) =>
      readJson<StreamBlockPage>(`${base(terminalId)}?${query(cursor)}`),
    mark: async (terminalId, patch: MarkPatch) => {
      await readJson<unknown>(base(terminalId, '/marks'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch)
      })
    },
    live: (terminalId, handlers) => subscribe(terminalId, handlers)
  }
}

/**
 * The live subscription, over SSE.
 *
 * `hello` is the proof the link is up; the browser's own EventSource retries
 * a dropped connection, and the state it reports is what the rail shows as
 * 'reconnecting'. `rollback` is listened for even though T2.5 is what emits
 * it — a handler that arrives with the event is one fewer coordinated deploy.
 */
function subscribe(terminalId: string, handlers: StreamLiveHandlers): () => void {
  let source: EventSource | null = null
  try {
    source = new EventSource(tokenParam(base(terminalId, '/live')))
  } catch (error) {
    handlers.onState('off')
    handlers.onError(error instanceof Error ? error.message : String(error))
    return () => undefined
  }
  const parse = <T,>(event: MessageEvent, use: (value: T) => void): void => {
    try {
      use(JSON.parse(event.data) as T)
    } catch (error) {
      // A malformed frame costs that frame, never the subscription: the next
      // tick re-reads. Reported, because a rail that quietly stops updating
      // is the worst of the three outcomes.
      handlers.onError(error instanceof Error ? error.message : String(error))
    }
  }
  source.addEventListener('hello', () => handlers.onState('connected'))
  source.addEventListener('tail', (event) =>
    parse<StreamTail>(event as MessageEvent, handlers.onTail)
  )
  source.addEventListener('mark', (event) =>
    parse<{ identity: string; mark: StreamMarks | null }>(event as MessageEvent, (frame) =>
      handlers.onMark(frame.identity, frame.mark)
    )
  )
  source.addEventListener('rollback', (event) =>
    parse<{ fromOrdinal: number; at?: number }>(event as MessageEvent, (frame) =>
      handlers.onRollback(frame.fromOrdinal, frame.at ?? Date.now())
    )
  )
  source.onerror = (): void => handlers.onState('reconnecting')
  return () => {
    source?.close()
    handlers.onState('off')
  }
}
