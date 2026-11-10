import type { IncomingMessage, ServerResponse } from 'node:http'
import { serveAsset } from './assets'
import { ASSET_VERSION } from './assets-bundle'
import { AUTH_PAGE_CSP, authPageHtml } from './auth-page'
import { productOrigin } from './auth-finish'
import { FAVICON_SVG } from './site-brand'
import { boundRequest, completeWeb, handleAuthApi } from './v2-auth-routes'
import { mePage } from './site-account'
import { respondPage } from './site-shell'
import { handleV2Route } from './v2-routes'
import { refuse, sessionTokenOf, signedIn, v2Json, type V2Context, type V2Identity } from './v2-http'
import { saysConsole } from './console-scope'
import { v2Error } from './v2-copy'
import { AUTH_REQUEST_HEADER, SIGNED_IN_INTENTS } from '../../src/shared/auth-site'

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

const ASSETS = new Set(['auth-kit.js', 'auth-enrol.js', 'auth-step.js', 'auth-grant.js', 'auth.js', 'inter.woff2', 'jetbrains-mono.woff2'])
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
  // A second step set up before the first session (auth UX 2026-11-09, v2-second-step.ts).
  ['POST', new RegExp(`^/v2/sessions/${UUID}/setup/(passkey/options|passkey|totp|totp/confirm|finish)$`)],
  ['POST', /^\/v2\/oauth\/claim$/]
]
/** A `step-up` request climbs its own ladder's rungs (auth-step-up.ts) and nothing of a sign-in. */
const STEP_UP_ROUTES: readonly [string, RegExp][] = [
  ['POST', new RegExp(`^/v2/sessions/${UUID}/(totp|recovery|passkey)$`)],
  ['GET', new RegExp(`^/v2/sessions/${UUID}/passkey/options$`)]
]
const PROVIDER_ROUTES: readonly [string, RegExp][] = [
  ['GET', /^\/v2\/oauth\/providers$/],
  ['POST', /^\/v2\/oauth\/(github|google)\/start$/]
]

const PROVIDER_CALLBACK = /^\/v2\/oauth\/(github|google)\/callback$/

/**
 * THE ACCOUNT PAGE (0.6.0), on a registry that splits its hosts: /account, its
 * scripts, and the account's own routes, reached with the session cookie this
 * host — and only this host — sets. What it may ask is the account and its
 * security, by an allow-list: `/v2/me` and what hangs under it, opening its
 * own requests, signing out. NOTHING OF A MACHINE: no machine list, no device
 * pass, no line, no relay, no directory. Those belong to the console and the
 * API host, and a cookie must not open them.
 */
const ACCOUNT_ASSETS = new Set(['site.js', 'factors.js', 'step-up.js', 'device-id.js'])
const ACCOUNT_ROUTES: readonly RegExp[] = [
  /^\/v2\/me$/,
  /^\/v2\/me\/(?!desktops(?:\/|$)|device-grant(?:\/|$)|presence(?:\/|$))[a-z-]+(?:\/[A-Za-z0-9_.~%-]+){0,3}$/,
  /^\/v2\/sessions\/current$/,
  /^\/v2\/auth\/requests$/,
  /^\/v2\/auth\/requests\/[A-Za-z0-9_-]{16,64}\/proof$/,
  /^\/v2\/oauth\/providers$/,
  /^\/v2\/keys$/
]
const isAccountRoute = (path: string): boolean => ACCOUNT_ROUTES.some((route) => route.test(path))

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
  // A CONSOLE SESSION OPENS NOTHING ON THIS HOST, however it is presented: its
  // token lives where a page's script could read it, and the account's
  // security is exactly what such a token must never reach (console-scope.ts).
  if (saysConsole(sessionTokenOf(request))) {
    v2Json(response, 403, v2Error('console_scope'))
    return
  }
  // NO BEARER IS READ HERE. The one session this host knows is its own cookie,
  // set by its own sign-in; a token a client holds is the API host's business.
  delete request.headers.authorization
  if ((method === 'GET' || method === 'HEAD') && (path === '/' || path === '/device')) {
    page(response, method, authPageHtml({ authOrigin: auth.origin, productOrigin: productOrigin(v2), assetVersion: ASSET_VERSION, path }))
    return
  }
  if ((method === 'GET' || method === 'HEAD') && parts.length === 2 && parts[0] === 'assets' && ASSETS.has(parts[1])) {
    if (!serveAsset(response, parts[1])) refuse(response, 404, 'not_found')
    return
  }
  // ── the account page, when this registry splits its hosts ──────────────
  const split = v2.apiOrigin !== null
  if (split && (method === 'GET' || method === 'HEAD') && parts.length === 2 && parts[0] === 'assets' && ACCOUNT_ASSETS.has(parts[1])) {
    if (!serveAsset(response, parts[1])) refuse(response, 404, 'not_found')
    return
  }
  if (split && method === 'GET' && path === '/account') {
    const signed = signedIn(request, v2)
    const standalone = { site: productOrigin(v2), console: v2.consoleOrigin, home: '/account' }
    respondPage(
      response,
      mePage(
        signed === null
          ? null
          : { view: 'account', account: signed.account, currentDeviceId: signed.claims.dev, factors: v2.factors.store.summary(signed.account.username) },
        standalone
      )
    )
    return
  }
  // The address this page had, and the returns its script and its step-ups
  // still name: the same page, here. A fixed path; the query is the caller's
  // own and the fragment travels with the browser.
  if (split && method === 'GET' && (path === '/me' || path === '/me/account')) {
    response.writeHead(303, { location: `/account${url.search}`, 'cache-control': 'private, no-store', 'content-length': '0' })
    response.end()
    return
  }
  // The web client's way back: the page that asked lives on this host.
  if (split && method === 'GET' && path === '/auth/complete') {
    completeWeb(v2, request, response, url)
    return
  }
  if ((method === 'GET' || method === 'HEAD') && path === '/favicon.svg') {
    const payload = Buffer.from(FAVICON_SVG, 'utf8')
    response.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': String(payload.byteLength), 'cache-control': 'public, max-age=86400' })
    response.end(method === 'HEAD' ? undefined : payload)
    return
  }
  // WHERE A PROVIDER COMES BACK TO, on a registry that splits its hosts: a
  // navigation, so it carries no Origin of ours and no request header. It
  // opens nothing by itself: the state it carries is taken first, and the
  // browser is sent back to the page (v2-oauth-routes.ts · callback).
  if (v2.apiOrigin !== null && method === 'GET' && PROVIDER_CALLBACK.test(path)) {
    handleV2Route({ ...contextOf(parts), via: 'auth' })
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
  // THE ACCOUNT PAGE'S OWN CALLS carry no request of the sign-in page's: they
  // are this browser's session asking about its own account. Told apart by
  // that header, so a route both could name (none today) is never guessed at.
  if (split && request.headers[AUTH_REQUEST_HEADER] === undefined && isAccountRoute(path)) {
    handleV2Route({ ...contextOf(parts), via: 'auth' })
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
  // A device pass by password is finished by the password typed on this page
  // and by nothing else (auth-grant.ts): no ladder, and no provider trip, which
  // would let a provider's word stand in for the password.
  if (bound.intent === 'grant') {
    refuse(response, 404, 'not_found')
    return
  }
  // A link, a passkey or a step-up is a signed-in act for the account that
  // opened it: there is nobody to sign in here, so the ladder's routes are not
  // reachable — but a step-up climbs the rungs of its own act's ladder.
  const ownRung = bound.intent === 'step-up' && allowed(STEP_UP_ROUTES, method, path)
  if (SIGNED_IN_INTENTS.includes(bound.intent) && signIn && !ownRung) {
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
