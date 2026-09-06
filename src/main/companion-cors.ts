import type http from 'node:http'

/**
 * CROSS-ORIGIN ACCESS TO THE COMPANION, FOR EXACTLY ONE READER.
 *
 * REACH v2.1 puts the phone's page at `https://cookrew.dev/relay/@you/desktop/
 * <id>/` and leaves it there for the life of the session — the address bar
 * never changes. The DATA plane underneath it does: when this Mac is on the
 * same Wi-Fi, the page fetches `https://192-168-2-40.<id>.d.cookrew.dev:8643`
 * directly, because that is the fast path and it now has a certificate a
 * browser trusts. The page's origin is then cookrew.dev and the request's is
 * this Mac, so every one of those routes is a cross-origin request. Without
 * these headers the switch cannot happen at all and the phone stays on the
 * relay forever, which is the whole thing the path badge exists to avoid.
 *
 * THE RULE IS AN EXACT MATCH AGAINST A SET WE COMPUTE, AND NOTHING ELSE.
 *
 *   NO WILDCARD, EVER. `*` here would let any page in any browser read
 *   transcripts and drive mutating routes on a machine on someone's LAN.
 *   NO SUFFIX MATCH. `endsWith('.cookrew.dev')` is how `notcookrew.dev` and
 *   `cookrew.dev.attacker.example` get in; the allowed set holds whole
 *   origins and the comparison is `===`.
 *   NO CREDENTIALS. `access-control-allow-credentials` is never written, so
 *   no cookie and no ambient authority rides along. The pairing token is sent
 *   deliberately, as an Authorization header, by a page that holds it.
 *   `Vary: Origin` ALWAYS, even on a refusal — a cache that saw the allowed
 *   origin's copy must not hand it to anybody else.
 *
 * THE PREFLIGHT IS ANSWERED BEFORE AUTH. A browser sends `OPTIONS` with no
 * Authorization header by construction, so a preflight behind the pairing gate
 * is a 401 that the browser reports as a CORS failure — and the real request
 * is never sent. Answering it first reveals nothing: the answer is a list of
 * methods and header names, identical for every path on this server.
 */

/** Long enough to spare a round trip per route on a slow link, short enough
 * that a rotated allow-list is honoured within the hour. */
export const CORS_MAX_AGE = '600'

/** Everything the companion sends. Nothing is echoed back from the request. */
export const CORS_ALLOW_HEADERS = 'authorization, content-type'

/** The verbs the companion's API uses (remote-api.ts). */
export const CORS_ALLOW_METHODS = 'GET, POST, PUT, DELETE, OPTIONS'

/**
 * Response headers a cross-origin reader may see beyond the safelist.
 *
 * Empty on purpose: the companion reads status and body and no header at all
 * (remote-api.ts). This is the seam for when it does — one string, in the one
 * place the allow-list lives, rather than a header appearing route by route.
 */
export const CORS_EXPOSE_HEADERS = ''

const trim = (origin: string): string => origin.replace(/\/+$/, '')

/** The request's origin if it is one we answer for, else null. */
export function allowedOrigin(
  requestOrigin: string | string[] | undefined,
  allowed: readonly string[]
): string | null {
  const raw = Array.isArray(requestOrigin) ? requestOrigin[0] : requestOrigin
  if (typeof raw !== 'string' || raw.length === 0 || raw === 'null') return null
  const asked = trim(raw)
  const set = new Set(allowed.filter((origin) => origin.length > 0).map(trim))
  return set.has(asked) ? asked : null
}

/**
 * The access-control headers for one request. `vary` is present whether or not
 * the origin was allowed; everything else appears only on a match.
 */
export function companionCorsHeaders(
  requestOrigin: string | string[] | undefined,
  allowed: readonly string[]
): Record<string, string> {
  const headers: Record<string, string> = { vary: 'origin' }
  const asked = allowedOrigin(requestOrigin, allowed)
  if (asked === null) return headers
  headers['access-control-allow-origin'] = asked
  headers['access-control-allow-methods'] = CORS_ALLOW_METHODS
  headers['access-control-allow-headers'] = CORS_ALLOW_HEADERS
  headers['access-control-max-age'] = CORS_MAX_AGE
  if (CORS_EXPOSE_HEADERS.length > 0) headers['access-control-expose-headers'] = CORS_EXPOSE_HEADERS
  return headers
}

/**
 * Write the headers onto the response and answer a preflight.
 *
 * Returns true when the request is FINISHED — a preflight, which no route
 * below should see. Everything else gets the headers set (not written): the
 * routes below call `writeHead` with their own, and Node merges what was set
 * here underneath them, so 200-odd call sites need no change and none of them
 * can forget.
 */
export function applyCompanionCors(
  request: Pick<http.IncomingMessage, 'headers' | 'method'>,
  response: http.ServerResponse,
  allowed: readonly string[]
): boolean {
  const headers = companionCorsHeaders(request.headers.origin, allowed)
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value)
  if ((request.method ?? 'GET') !== 'OPTIONS') return false
  // 204 either way. A refused preflight that answered 403 would tell a page
  // scanning the LAN that something is here; a 204 with no allow-origin is
  // the same refusal to the browser and says nothing to the script.
  response.writeHead(204, { 'content-length': '0' })
  response.end()
  return true
}
