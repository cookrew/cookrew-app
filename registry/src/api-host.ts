import type { IncomingMessage, ServerResponse } from 'node:http'
import { v2Error } from './v2-copy'
import type { V2Identity } from './v2-http'

/**
 * API.COOKREW.DEV — WHAT THE API HOST IS, STATED ONCE AND AT THE DOOR.
 *
 * In 0.6.0 this process answers two names: the auth host (auth-host.ts) and
 * this one. Everything a client calls lives here: /v1, /v2 and the relay path
 * (/api/m). Four rules hold for every request that arrives on it, and they are
 * enforced here, before any route runs, rather than route by route:
 *
 *   NO PAGE. A path that is not the API is a 404 in JSON. The intro site and
 *   the console are static sites hosted elsewhere; no HTML is served here.
 *
 *   NO COOKIE IS READ. The session is `Authorization: Bearer`, or the relay
 *   path's own header. A cookie is something another site can make a browser
 *   send, so the header is removed from the request before a route can look.
 *
 *   NO COOKIE IS SET. Whatever a route would have set on a single-host
 *   registry is dropped on the way out.
 *
 *   ONE ORIGIN MAY CALL IT FROM A PAGE: the console's, compared whole. Its
 *   preflight is answered here. A caller that is not a browser sends no Origin
 *   and is judged by its credential alone. The relay path does its own
 *   answering of this (v2-canvas-relay.ts), by the same rule.
 *
 * Routing is by the exact Host the configured API origin names — never a
 * suffix, never a forwarded header.
 */

/** What the console's page may send here, and how. Nothing is echoed back from the request. */
export const API_CORS_HEADERS = 'authorization, content-type'
export const API_CORS_METHODS = 'GET, HEAD, POST, PUT, DELETE'
/** Ten minutes, the ceiling OWASP names (main/companion-cors.ts). */
export const API_CORS_MAX_AGE = '600'

/** The path prefixes that are the API. Everything else on this host is not there. */
const API_PREFIXES = ['/v1/', '/v2/', '/api/m/']
/** The relay path answers its own origin question and its own preflight. */
const RELAY_PREFIX = '/api/m/'

/** The exact host[:port] of the API origin, lowercased; null on a registry that is one host. */
export const apiHostOf = (v2: V2Identity | undefined): string | null =>
  v2?.apiOrigin ? new URL(v2.apiOrigin).host.toLowerCase() : null

const refuse = (response: ServerResponse, code: number, error: 'not_found' | 'bad_origin'): void => {
  const payload = Buffer.from(JSON.stringify(v2Error(error)), 'utf8')
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    vary: 'origin, authorization'
  })
  response.end(payload)
}

/**
 * The answer's head, as this host lets it out: no Set-Cookie, and `vary`
 * naming the origin. Always: an answer the console may read and the same
 * answer without that grant must never be mistaken for each other by a cache.
 */
function ownHead<T>(headers: T): T {
  if (Array.isArray(headers)) {
    // Raw pairs: [name, value, name, value, …].
    const kept: unknown[] = []
    for (let at = 0; at + 1 < headers.length; at += 2) {
      const name = String(headers[at]).toLowerCase()
      if (name === 'set-cookie') continue
      kept.push(headers[at], name === 'vary' ? varyingByOrigin(String(headers[at + 1])) : headers[at + 1])
    }
    return kept as T
  }
  if (typeof headers !== 'object' || headers === null) return headers
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([name]) => name.toLowerCase() !== 'set-cookie')
      .map(([name, value]) => [name, name.toLowerCase() === 'vary' ? varyingByOrigin(String(value)) : value])
  ) as T
}

const varyingByOrigin = (vary: string): string => (/(^|,)\s*origin\s*(,|$)/i.test(vary) ? vary : `${vary}, origin`)

/** From here on this response carries no Set-Cookie, however a route writes its head. */
function guardHead(response: ServerResponse): void {
  const setHeader = response.setHeader.bind(response)
  response.setHeader = ((name: string, value: number | string | readonly string[]) =>
    name.toLowerCase() === 'set-cookie' ? response : setHeader(name, value)) as typeof response.setHeader
  const writeHead = response.writeHead.bind(response) as (...args: unknown[]) => ServerResponse
  response.writeHead = ((code: number, ...rest: unknown[]) => {
    response.removeHeader('set-cookie')
    return writeHead(code, ...rest.map((part) => (typeof part === 'string' ? part : ownHead(part))))
  }) as typeof response.writeHead
}

/**
 * A request on the API host, taken through the four rules. True when it was
 * answered here (not the API, a preflight, a page of another origin asking
 * one); false when a route should now run, with the cookie gone from the
 * request and the console's grant, if it is the console asking, already on
 * the response.
 */
export function enterApiHost(v2: V2Identity, request: IncomingMessage, response: ServerResponse, url: URL): boolean {
  delete request.headers.cookie
  guardHead(response)
  // Kept by every answer whose route names no `vary` of its own; one that does has `origin` added (ownHead).
  response.setHeader('vary', 'origin')
  const path = url.pathname
  if (!API_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    refuse(response, 404, 'not_found')
    return true
  }
  if (path.startsWith(RELAY_PREFIX)) return false
  const origin = request.headers.origin
  const method = request.method ?? 'GET'
  if (origin === undefined) {
    // Not a browser. A stray OPTIONS is nobody's preflight.
    if (method === 'OPTIONS') {
      refuse(response, 404, 'not_found')
      return true
    }
    return false
  }
  const console_ = typeof origin === 'string' && v2.consoleOrigin !== null && origin === v2.consoleOrigin
  if (method === 'OPTIONS') {
    if (!console_) {
      refuse(response, 403, 'bad_origin')
      return true
    }
    // THE PREFLIGHT, before auth: a browser sends it with no credential by
    // construction, and its answer is a list of names, the same for every path.
    response.writeHead(204, {
      'access-control-allow-origin': v2.consoleOrigin as string,
      'access-control-allow-methods': API_CORS_METHODS,
      'access-control-allow-headers': API_CORS_HEADERS,
      'access-control-max-age': API_CORS_MAX_AGE,
      'cache-control': 'private, no-store',
      vary: 'origin'
    })
    response.end()
    return true
  }
  // The console may read what follows. A page of any other origin gets no
  // grant, so its browser shows it nothing; its writes are refused by the
  // routes' own origin rule (v2-http.ts · writeOriginOk), and no cookie of its
  // visitor's can ride along because none is read here.
  if (console_) response.setHeader('access-control-allow-origin', v2.consoleOrigin as string)
  return false
}
