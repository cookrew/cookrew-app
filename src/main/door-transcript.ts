import { SERVED_TRANSCRIPT_PATHS, type ServedTracePage } from '../shared/served-transcript'
import type {
  TraceBoundaryMarker,
  TraceIndexEntry,
  TraceIndexRequest,
  TracePageRequest
} from '../shared/trace-blocks'
import { pageTurns, type TurnPage, type TurnPageRequest, type TurnRecord } from '../shared/turn'
import type { DoorTranscriptState } from '../shared/door-transcript-state'

/**
 * THE RECORD BEHIND A REMOTE CARD.
 *
 * An imported card is a line into a session at someone else's app: its pixels
 * are the orch's PTY, mirrored. That is the whole INTERFACE, but it is not the
 * RECORD — the record is the session file the harness writes at the author's
 * machine, and the door already serves it to the caller who owns the session
 * (`/turns`, `/trace`, `/trace/index`, `/trace/markers`, behind the same
 * Bearer the line uses). This reads it, so the card's checkpoint rail, pager
 * and idle preview are fed by the same four calls a local card's are fed by
 * the file — and by nothing else. No photograph of the pixels is ever taken.
 *
 * It signs in as THE SAME CALLER the line does — same key file, same sub — or
 * the door would see two strangers, admit the line and refuse the transcript,
 * and the rail would stay blank while the pixels flowed (P13).
 *
 * WHAT IT SAYS WHEN IT CANNOT READ. A refusal is a state with a name, never a
 * silent empty rail: an empty rail because nothing has happened yet and an
 * empty rail because the door refused are two different sentences (P10). On
 * a transient failure the last good answer stands — rows never blink out —
 * and `state()` says why the next one did not arrive.
 */

export interface DoorTarget {
  /** Where the door answers — a dialled origin, or the relay's loopback end. */
  origin: string
  /** The slug, or the `@handle/team` name the relay proxy routes on. */
  slug: string
}

export type { DoorTranscriptState } from '../shared/door-transcript-state'

export interface DoorTranscriptDeps {
  /** Sign in as the caller and return the Bearer. Throws when there is no door. */
  signIn: (target: DoorTarget) => Promise<string>
  fetcher?: typeof fetch
  now?: () => number
  /** Reads inside this window share one request per path+query. */
  memoMs?: number
  timeoutMs?: number
}

const EMPTY_TRACE: ServedTracePage = { blocks: [], total: 0, source: null }
const MAX_BODY_BYTES = 8 * 1024 * 1024

interface Answer {
  status: number
  body: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isTurnRecord = (value: unknown): value is TurnRecord =>
  isRecord(value) &&
  typeof value.index === 'number' &&
  typeof value.prompt === 'string' &&
  typeof value.reply === 'string'

const isIndexEntry = (value: unknown): value is TraceIndexEntry =>
  isRecord(value) && typeof value.index === 'number' && typeof value.title === 'string'

const isMarker = (value: unknown): value is TraceBoundaryMarker =>
  isRecord(value) && typeof value.kind === 'string' && typeof value.afterIndex === 'number'

const isTraceBlock = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.index === 'number' &&
  typeof value.prompt === 'string' &&
  typeof value.reply === 'string' &&
  Array.isArray(value.activity)

const isTracePage = (value: unknown): value is ServedTracePage =>
  isRecord(value) &&
  Array.isArray(value.blocks) &&
  value.blocks.every(isTraceBlock) &&
  typeof value.total === 'number' &&
  (value.source === null || value.source === 'claude' || value.source === 'codex' || value.source === 'pi')

const isTurnPage = (value: unknown): value is TurnPage =>
  isRecord(value) &&
  Array.isArray(value.turns) &&
  value.turns.every(isTurnRecord) &&
  typeof value.total === 'number' &&
  typeof value.offset === 'number'

/** How many trace windows are remembered as last-good: one per scrub position
 *  would grow without bound in a long-lived main process. */
const LAST_GOOD_CAP = 24

function query(params: Record<string, number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && Number.isFinite(value)) search.set(key, String(value))
  }
  const text = search.toString()
  return text.length > 0 ? `?${text}` : ''
}

/**
 * Read a body up to `cap` bytes and not one more. `arrayBuffer()` would hold
 * the whole answer before any check could run, so a door answering with
 * gigabytes would take the main process down — and this is read unattended,
 * every few seconds, for every remote card.
 */
async function bounded(res: Response, cap: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > cap) return null
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array(0)
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel()
      return null
    }
    parts.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

export class DoorTranscript {
  private token: string | null = null
  private signingIn: Promise<string> | null = null
  private current: DoorTranscriptState = { kind: 'starting' }
  private everUp = false
  private readonly lastGood = new Map<string, unknown>()
  private readonly memo = new Map<string, { at: number; answer: Promise<Answer> }>()
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private readonly memoMs: number
  private readonly timeoutMs: number

  constructor(
    readonly target: DoorTarget,
    private readonly deps: DoorTranscriptDeps
  ) {
    this.fetcher = deps.fetcher ?? fetch
    this.now = deps.now ?? (() => Date.now())
    this.memoMs = deps.memoMs ?? 1000
    this.timeoutMs = deps.timeoutMs ?? 8000
  }

  state(): DoorTranscriptState {
    return this.current
  }

  /** Every completed turn of this caller's session, oldest first. */
  async turns(): Promise<TurnRecord[]> {
    const answer = await this.read(SERVED_TRANSCRIPT_PATHS.turns, '')
    return this.settle<TurnRecord[]>(SERVED_TRANSCRIPT_PATHS.turns, answer, (body) =>
      Array.isArray(body) && body.every(isTurnRecord) ? body : null
    , [])
  }

  /**
   * A window of turns. Paged AT THE DOOR when a window is asked for — the
   * door pages by the same identity rules the local pager uses — so a scrub
   * never pulls the whole history to show twenty rows of it.
   */
  async turnsPage(request: TurnPageRequest = {}): Promise<TurnPage> {
    const q = query({
      offset: request.offset,
      limit: request.limit,
      aroundIndex: request.aroundIndex,
      beforeIndex: request.beforeIndex
    })
    if (q.length === 0) return pageTurns(await this.turns(), request)
    const answer = await this.read(SERVED_TRANSCRIPT_PATHS.turns, q)
    return this.settle<TurnPage>(
      `${SERVED_TRANSCRIPT_PATHS.turns}${q}`,
      answer,
      (body) => (isTurnPage(body) ? body : null),
      { turns: [], total: 0, offset: 0 }
    )
  }

  /**
   * The newest turn and the count — ONE record over the wire. This is what
   * the poller and the idle preview read every few seconds; the whole history
   * is fetched only when something actually renders it.
   */
  private async tail(): Promise<TurnPage> {
    const q = query({ limit: 1 })
    const answer = await this.read(SERVED_TRANSCRIPT_PATHS.turns, q)
    return this.settle<TurnPage>(
      `${SERVED_TRANSCRIPT_PATHS.turns}${q}`,
      answer,
      (body) => (isTurnPage(body) ? body : null),
      { turns: [], total: 0, offset: 0 }
    )
  }

  async traceIndex(request: TraceIndexRequest = {}): Promise<TraceIndexEntry[]> {
    const q = query({ afterIndex: request.afterIndex })
    const answer = await this.read(SERVED_TRANSCRIPT_PATHS.traceIndex, q)
    return this.settle<TraceIndexEntry[]>(
      `${SERVED_TRANSCRIPT_PATHS.traceIndex}${q}`,
      answer,
      (body) => (Array.isArray(body) && body.every(isIndexEntry) ? body : null),
      []
    )
  }

  async traceMarkers(): Promise<TraceBoundaryMarker[]> {
    const answer = await this.read(SERVED_TRANSCRIPT_PATHS.traceMarkers, '')
    return this.settle<TraceBoundaryMarker[]>(
      SERVED_TRANSCRIPT_PATHS.traceMarkers,
      answer,
      (body) => (Array.isArray(body) && body.every(isMarker) ? body : null),
      []
    )
  }

  async tracePage(request: TracePageRequest = {}): Promise<ServedTracePage> {
    const q = query({
      beforeIndex: request.beforeIndex,
      afterIndex: request.afterIndex,
      aroundIndex: request.aroundIndex,
      limit: request.limit
    })
    const answer = await this.read(SERVED_TRANSCRIPT_PATHS.trace, q)
    return this.settle<ServedTracePage>(
      `${SERVED_TRANSCRIPT_PATHS.trace}${q}`,
      answer,
      (body) => (isTracePage(body) ? body : null),
      EMPTY_TRACE
    )
  }

  /** The newest completed turn — what an idle card shows. */
  async latest(): Promise<{ prompt: string; reply: string; title?: string } | null> {
    const page = await this.tail()
    const turn = page.turns[page.turns.length - 1]
    return turn
      ? { prompt: turn.prompt, reply: turn.reply, ...(turn.title ? { title: turn.title } : {}) }
      : null
  }

  /**
   * One string that changes exactly when the card should redraw: the state,
   * the count, and the newest identity. The poller compares these; a card
   * with a stable fingerprint costs nothing but the read behind it.
   */
  async fingerprint(): Promise<string> {
    const page = await this.tail()
    const last = page.turns[page.turns.length - 1]
    return `${this.current.kind}:${page.total}:${last?.index ?? -1}:${last?.uuid ?? ''}`
  }

  /** Drop the Bearer; the next read signs in again. */
  forget(): void {
    this.token = null
  }

  private settle<T>(key: string, answer: Answer, shape: (body: unknown) => T | null, empty: T): T {
    if (answer.status === 200) {
      const value = shape(answer.body)
      if (value !== null) {
        // "Up" means the door answered IN SHAPE, not merely with a 200 — a
        // later 404 reads as "ended" only if a real record was ever read.
        this.everUp = true
        this.current = { kind: 'ok', at: this.now() }
        this.remember(key, value)
        return value
      }
      // A 200 that is not the shape the door promised is a door talking a
      // different protocol — said so, not rendered as an empty history.
      this.current = { kind: 'unreachable', status: 200 }
    }
    const kept = this.lastGood.get(key)
    return kept !== undefined ? (kept as T) : empty
  }

  private remember(key: string, value: unknown): void {
    this.lastGood.delete(key)
    this.lastGood.set(key, value)
    // Oldest first: a Map iterates in insertion order.
    while (this.lastGood.size > LAST_GOOD_CAP) {
      const oldest = this.lastGood.keys().next().value
      if (oldest === undefined) break
      this.lastGood.delete(oldest)
    }
  }

  private async read(pathname: string, q: string): Promise<Answer> {
    const key = `${pathname}${q}`
    const at = this.now()
    const memoized = this.memo.get(key)
    if (memoized && at - memoized.at < this.memoMs) return memoized.answer
    for (const [stale, entry] of this.memo) {
      if (at - entry.at >= this.memoMs) this.memo.delete(stale)
    }
    const answer = this.request(pathname, q).then((got) => {
      this.note(got.status, got.body)
      return got
    })
    this.memo.set(key, { at, answer })
    return answer
  }

  private note(status: number, body: unknown): void {
    if (status === 200) {
      // Decided in settle(), once the body has been checked for shape.
      return
    }
    if ((status === 404 || status === 502) && isRecord(body) && body.error === 'not-serving') {
      // The DOOR's 404 is a bare `{}` on purpose (no session and somebody
      // else's session look the same). A refusal that names itself is the
      // caller's end of the RELAY saying nobody is serving this name — a
      // different sentence (relay-proxy.ts).
      this.current = { kind: 'not-serving' }
    } else if (status === 404) {
      this.current = this.everUp ? { kind: 'ended' } : { kind: 'no-session' }
    } else if (status === 402) {
      this.current = { kind: 'ended' }
    } else if (status === 401 || status === 403) {
      this.current = { kind: 'signed-out' }
    } else if (status === 503) {
      this.current = { kind: 'unavailable' }
    } else if (status === -1) {
      this.current = { kind: 'not-serving' }
    } else {
      this.current = { kind: 'unreachable', status }
    }
  }

  private async bearer(): Promise<string> {
    if (this.token) return this.token
    if (!this.signingIn) {
      this.signingIn = this.deps.signIn(this.target).finally(() => {
        this.signingIn = null
      })
    }
    this.token = await this.signingIn
    return this.token
  }

  private async request(pathname: string, q: string): Promise<Answer> {
    let token: string
    try {
      token = await this.bearer()
    } catch {
      return { status: -1, body: null }
    }
    const url = `${this.target.origin}/${this.target.slug}${pathname}${q}`
    const once = async (bearer: string): Promise<Answer> => {
      try {
        const res = await this.fetcher(url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' }
        })
        const raw = await bounded(res, MAX_BODY_BYTES)
        if (raw === null) return { status: 0, body: null }
        let body: unknown = null
        try {
          body = JSON.parse(new TextDecoder().decode(raw))
        } catch {
          body = null
        }
        return { status: res.status, body }
      } catch {
        return { status: 0, body: null }
      }
    }
    let answer = await once(token)
    if (answer.status === 401) {
      // The token aged out, or the door restarted its issuer. One fresh
      // sign-in, and if that is refused too the answer is honest: signed out.
      this.token = null
      try {
        answer = await once(await this.bearer())
      } catch {
        return { status: -1, body: null }
      }
    }
    return answer
  }
}
