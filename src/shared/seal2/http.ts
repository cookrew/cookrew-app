import type { Seal2Connection } from './connection'
import type { Fields } from './frames'
import type { Seal2Stream } from './stream'

/**
 * KIND "http" (spec.ts §5): an HTTP exchange as one sealed stream. The request
 * is OPEN's fields plus a body; the answer is HEAD plus a body. Either body can
 * stream: an upload is written as it is read, and an event stream is an answer
 * whose body has not ended.
 */

export const HTTP_KIND = 'http'

export interface SealedRequest {
  readonly method: string
  /** A path on the far server, never a URL. */
  readonly path: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: Uint8Array | string | ReadableStream<Uint8Array> | null
  readonly signal?: AbortSignal
}

export interface SealedResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: ReadableStream<Uint8Array>
  /** The stream underneath, for whoever wants to end it early. */
  readonly stream: Seal2Stream
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
/** What a page may ask. CONNECT and TRACE would each mean something else on the far socket. */
export const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/**
 * A path on this server: never a scheme, never `//host`, nothing that could end the request line, and no '#':
 * the companion reads nothing after one, so `/api/watch/item/..#/frame` would be judged as one path and served
 * as another (Relay round 4, B). A page drops its fragment before it seals a request, as fetch does.
 */
export const isLocalPath = (path: unknown): path is string =>
  typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') && !path.includes('#') && !CONTROL.test(path) && !path.includes(' ')

/** Lower-case names, no pseudo-fields, no control characters. An answer may join several Set-Cookie with a newline. */
export function plainHeaders(fields: Fields, answer = false): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(fields)) {
    if (name.startsWith(':')) continue
    const checked = answer && name === 'set-cookie' ? value.replace(/\n/g, '') : value
    if (!TOKEN.test(name) || CONTROL.test(checked)) return null
    out[name] = value
  }
  return out
}

export function requestFields(method: string, path: string, headers: Readonly<Record<string, string>> = {}): Fields {
  if (!TOKEN.test(method) || !isLocalPath(path)) throw new Error('Not a request this seal carries')
  const lowered = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
  return { ...lowered, ':method': method, ':path': path }
}

/** Null for anything that is not a request a server should be handed. */
export function readRequest(fields: Fields): { method: string; path: string; headers: Record<string, string> } | null {
  const method = fields[':method']
  const path = fields[':path']
  if (typeof method !== 'string' || !HTTP_METHODS.has(method) || !isLocalPath(path)) return null
  const extra = Object.keys(fields).filter((name) => name.startsWith(':') && name !== ':method' && name !== ':path')
  const headers = plainHeaders(fields)
  return extra.length > 0 || headers === null ? null : { method, path, headers }
}

const bodyBytes = (body: Uint8Array | string): Uint8Array => (typeof body === 'string' ? new TextEncoder().encode(body) : body)

async function sendBody(stream: Seal2Stream, body: SealedRequest['body']): Promise<void> {
  if (body instanceof ReadableStream) {
    await body.pipeTo(stream.writable)
    return
  }
  const writer = stream.writable.getWriter()
  if (body !== undefined && body !== null && bodyBytes(body).length > 0) await writer.write(bodyBytes(body))
  await writer.close()
}

/** One HTTP exchange inside the session. Rejects when the stream is refused or cut; never answers in the clear. */
export async function sealedFetch(connection: Seal2Connection, request: SealedRequest): Promise<SealedResponse> {
  const stream = connection.openStream(HTTP_KIND, requestFields(request.method, request.path, request.headers))
  const stop = (): void => stream.abort(1, 'the caller stopped')
  if (request.signal?.aborted) stop()
  request.signal?.addEventListener('abort', stop, { once: true })
  void stream.closed.finally(() => request.signal?.removeEventListener('abort', stop)).catch(() => undefined)
  void sendBody(stream, request.body).catch(() => stream.abort(1, 'the request body failed'))
  // A caller's abort reads as one, the way fetch says it, with the caller's own reason.
  const head = await stream.head.catch((error: unknown) => {
    if (request.signal?.aborted) throw request.signal.reason ?? new DOMException('The request was aborted', 'AbortError')
    throw error
  })
  const headers = plainHeaders(head.fields, true)
  if (headers === null) {
    stream.abort(8, 'an answer with unreadable headers')
    throw new Error('The far end answered with headers that cannot be read')
  }
  return { status: head.status, headers, body: stream.readable, stream }
}

/** The whole answer as bytes: for small JSON exchanges. */
export async function readBody(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for (const reader = body.getReader(); ; ) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  parts.reduce((at, part) => (out.set(part, at), at + part.length), 0)
  return out
}
