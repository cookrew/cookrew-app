import type { IncomingMessage, ServerResponse } from 'node:http'
import { serveAsset } from './assets'
import { ASSET_VERSION } from './assets-bundle'
import { AUTH_PAGE_CSP, authPageHtml } from './auth-page'
import { productOrigin } from './auth-finish'
import { FAVICON_SVG } from './site-brand'
import { boundRequest, handleAuthApi } from './v2-auth-routes'
import { handleV2Route } from './v2-routes'
import { refuse, v2Json, type V2Context, type V2Identity } from './v2-http'

/**
 * AUTH.COOKREW.DEV — EVERYTHING THE AUTH ORIGIN ANSWERS, AND NOTHING ELSE.
 *
 * The page, its script and fonts, the page's own calls, and a short list of
 * the ladder's /v2 routes, each reached with the request this browser claimed.
 * Every other path is a 404: the auth origin is not a second front door to
 * the registry, and no session, door, relay or profile is reachable here.
 *
 * Routing is by the exact Host the configured auth origin names — never a
 * suffix, never a forwarded header.
 */

const ASSETS = new Set(['auth-kit.js', 'auth.js', 'inter.woff2', 'jetbrains-mono.woff2'])
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/** The ladder's routes a page may reach, by method. A link request reaches only the provider trip. */
const SIGN_IN_ROUTES: readonly [string, RegExp][] = [
  ['POST', /^\/v2\/sessions$/],
  ['POST', /^\/v2\/accounts$/],
  ['HEAD', /^\/v2\/accounts\/[a-z0-9-]{1,32}$/],
  ['POST', /^\/v2\/recovery$/],
  ['GET', /^\/v2\/sessions\/passkey\/options$/],
  ['POST', /^\/v2\/sessions\/passkey$/],
  ['GET', new RegExp(`^/v2/sessions/${UUID}$`)],
  ['POST', new RegExp(`^/v2/sessions/${UUID}/(totp|recovery|approve|passkey)$`)],
  ['GET', new RegExp(`^/v2/sessions/${UUID}/passkey/options$`)],
  ['POST', /^\/v2\/oauth\/claim$/]
]
const PROVIDER_ROUTES: readonly [string, RegExp][] = [
  ['GET', /^\/v2\/oauth\/providers$/],
  ['POST', /^\/v2\/oauth\/(github|google)\/start$/]
]

const allowed = (routes: readonly [string, RegExp][], method: string, path: string): boolean =>
  routes.some(([m, pattern]) => m === method && pattern.test(path))

/** The exact host[:port] of the auth origin, lowercased. */
export const authHostOf = (v2: V2Identity | undefined): string | null =>
  v2?.auth ? new URL(v2.auth.origin).host.toLowerCase() : null

function page(response: ServerResponse, method: string, html: string): void {
  const payload = Buffer.from(html, 'utf8')
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(payload.byteLength),
    'content-security-policy': AUTH_PAGE_CSP,
    'cache-control': 'private, no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'strict-transport-security': 'max-age=31536000'
  })
  response.end(method === 'HEAD' ? undefined : payload)
}

/**
 * A WRITE FROM ANYWHERE BUT THIS PAGE IS NOT THIS PERSON'S. Stricter than the
 * product origin's rule: there, an absent Origin is an app; here, every
 * caller is this page's own script, which always sends one.
 */
function ownOrigin(request: IncomingMessage, v2: V2Identity): boolean {
  return request.method === 'GET' || request.method === 'HEAD' || request.headers.origin === v2.auth?.origin
}

export function handleAuthHost(
  v2: V2Identity,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  contextOf: (parts: string[]) => V2Context
): void {
  const method = request.method ?? 'GET'
  const path = url.pathname
  const parts = path.split('/').filter(Boolean)
  const auth = v2.auth
  if (auth === null) {
    refuse(response, 404, 'not_found')
    return
  }
  if ((method === 'GET' || method === 'HEAD') && (path === '/' || path === '/device')) {
    page(response, method, authPageHtml({ authOrigin: auth.origin, productOrigin: productOrigin(v2), assetVersion: ASSET_VERSION, path }))
    return
  }
  if ((method === 'GET' || method === 'HEAD') && parts.length === 2 && parts[0] === 'assets' && ASSETS.has(parts[1])) {
    if (!serveAsset(response, parts[1])) refuse(response, 404, 'not_found')
    return
  }
  if ((method === 'GET' || method === 'HEAD') && path === '/favicon.svg') {
    const payload = Buffer.from(FAVICON_SVG, 'utf8')
    response.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': String(payload.byteLength), 'cache-control': 'public, max-age=86400' })
    response.end(method === 'HEAD' ? undefined : payload)
    return
  }
  if (!ownOrigin(request, v2)) {
    refuse(response, 403, 'bad_origin')
    return
  }
  if (path.startsWith('/auth/api/')) {
    void handleAuthApi(contextOf(parts), path)
      .then((claimed) => {
        if (!claimed) refuse(response, 404, 'not_found')
      })
      .catch(() => {
        if (!response.headersSent) refuse(response, 500, 'malformed')
        else response.end()
      })
    return
  }
  const signIn = allowed(SIGN_IN_ROUTES, method, path)
  if (!signIn && !allowed(PROVIDER_ROUTES, method, path)) {
    refuse(response, 404, 'not_found')
    return
  }
  const ctx = contextOf(parts)
  const bound = boundRequest(ctx)
  if (bound === null) return
  // A link is a signed-in act proven before the page opened: there is nobody
  // to sign in here, so the ladder's routes are not reachable for one.
  if (bound.intent === 'link' && signIn) {
    refuse(response, 404, 'not_found')
    return
  }
  // Over is over: a finished request is a page that already handed off, a
  // denied one a page that already said so. Named, so the page lands right.
  if (bound.stage === 'done' || bound.stage === 'denied') {
    const denied = bound.stage === 'denied'
    v2Json(response, 410, {
      error: denied ? 'denied' : 'expired',
      message: denied ? 'This sign-in was cancelled. Start again from the app that asked.' : 'This sign-in already finished.'
    })
    return
  }
  handleV2Route({ ...ctx, auth: { request: bound } })
}
