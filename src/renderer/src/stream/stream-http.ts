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
  StreamTail
} from './stream-types'
import type { StreamLiveHandlers, StreamTransport } from './stream-transport'

/** Thrown for a route this build's server does not serve. Its own type so a
 *  caller can tell "this build has no such route" from "this card has no
 *  history" — the distinction the whole design exists to keep visible. */
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

/** ONE OPEN — the whole first paint in one round trip. */
async function open(terminalId: string): Promise<StreamOpen> {
  return readJson<StreamOpen>(base(terminalId, '/open'))
}

/**
 * The TAIL alone, for a card preview or a board row.
 *
 * `/stream/open` already carries it, and taking the tail out of that answer
 * costs one read — a board of twenty idle agents draws twenty one-line
 * previews without pulling twenty index pages of its own.
 */
async function tail(terminalId: string): Promise<StreamTail | null> {
  const answer = await readJson<StreamOpen>(base(terminalId, '/open'))
  const newest = answer.index[answer.index.length - 1]
  const marks = newest?.identity === answer.tail?.block?.id ? newest?.marks : undefined
  return answer.tail === null ? null : { ...answer.tail, ...(marks !== undefined ? { marks } : {}) }
}

export function createHttpStreamTransport(): StreamTransport {
  return {
    open,
    index: (terminalId, cursor) =>
      readJson<StreamIndexPage>(`${base(terminalId, '/index')}?${query(cursor)}`),
    blocks: (terminalId, cursor) =>
      readJson<StreamBlockPage>(`${base(terminalId)}?${query(cursor)}`),
    tail,
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

/** How long a dropped subscription waits before it re-opens. The browser's
 *  own EventSource retry is ~3 s; this replaces it (see subscribe). */
const RECONNECT_MS = 3000

/**
 * The live PATH, carrying the newest mark reading this client already holds.
 *
 * Deliberately WITHOUT the token: `tokenParam` is applied at the `new
 * EventSource(...)` call site so tests/api-base.test.ts's sweep can see it
 * there. A token added inside a helper is the exact blind spot that sweep
 * exists for — and a stream opened without one is a 401 the browser retries
 * forever while the rail simply never fills.
 */
export function liveHref(terminalId: string, since: number | null): string {
  const path = base(terminalId, '/live')
  return since === null ? path : `${path}?since=${encodeURIComponent(String(since))}`
}

/**
 * The live subscription, over SSE.
 *
 * `hello` is the proof the link is up. RECONNECTION IS OURS, not the browser's
 * (T5 QA, 2026-09-07): a native EventSource retry re-opens the SAME url, so a
 * subscriber that dropped for a second used to be handed the whole mark ledger
 * again — 498 frames on the owner's busiest card. Re-opening ourselves lets the
 * next connect carry `?since=<the newest mark reading we hold>`, which is the
 * outage's own delta and nothing else. `hello.marksAt` seeds that reading and
 * every `mark` frame advances it.
 *
 * `rollback` is listened for even though T2.5 is what emits it — a handler
 * that arrives with the event is one fewer coordinated deploy.
 */
function subscribe(terminalId: string, handlers: StreamLiveHandlers): () => void {
  let source: EventSource | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  /** The newest mark reading this client holds — the resume token. */
  let since: number | null = null

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

  const advance = (at: number | undefined): void => {
    if (typeof at === 'number' && Number.isFinite(at) && (since === null || at > since)) since = at
  }

  const connect = (): void => {
    if (stopped) return
    try {
      source = new EventSource(tokenParam(liveHref(terminalId, since)))
    } catch (error) {
      handlers.onState('off')
      handlers.onError(error instanceof Error ? error.message : String(error))
      return
    }
    source.addEventListener('hello', (event) =>
      parse<{ marksAt?: number }>(event as MessageEvent, (frame) => {
        advance(frame.marksAt)
        handlers.onState('connected')
      })
    )
    source.addEventListener('tail', (event) =>
      parse<StreamTail>(event as MessageEvent, handlers.onTail)
    )
    source.addEventListener('mark', (event) =>
      parse<{ identity: string; mark: StreamMarks | null; at?: number }>(
        event as MessageEvent,
        (frame) => {
          advance(frame.at)
          handlers.onMark(frame.identity, frame.mark)
        }
      )
    )
    source.addEventListener('rollback', (event) =>
      parse<{ fromOrdinal: number; at?: number }>(event as MessageEvent, (frame) =>
        handlers.onRollback(frame.fromOrdinal, frame.at ?? Date.now())
      )
    )
    source.onerror = (): void => {
      if (stopped) return
      handlers.onState('reconnecting')
      source?.close()
      source = null
      if (retry === null) {
        retry = setTimeout(() => {
          retry = null
          connect()
        }, RECONNECT_MS)
      }
    }
  }

  connect()
  return () => {
    if (stopped) return
    stopped = true
    if (retry !== null) clearTimeout(retry)
    source?.close()
    handlers.onState('off')
  }
}
