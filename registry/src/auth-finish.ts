import { OAUTH_LOOPBACK_PATH, OAUTH_SCHEME_HOST } from '../../src/shared/oauth'
import { AUTH_CODE_TTL_MS, AUTH_REQUEST_TTL_MS, type AuthHandoff } from '../../src/shared/auth-site'
import type { AuthRequest, AuthResult } from './auth-requests'
import type { ProviderProof } from './v2-oauth-providers'
import { refuse, v2Json, type V2Context, type V2Identity } from './v2-http'
import { SESSION_TTL_MS } from './v2-tokens'
import { tokenExpiry, type VerifiedBy } from './v2-session-age'

/**
 * IS THIS REQUEST STILL WAITING? Asked at the last moment before anything is
 * minted: a cancel can land while a password is being checked, and a
 * sign-in that finishes after it must not hand anybody a session.
 */
export function stillOpen(ctx: V2Context, request: AuthRequest): boolean {
  if (ctx.v2.auth?.requests.isOpen(request) === true) return true
  const denied = request.stage === 'denied'
  v2Json(ctx.response, 410, {
    error: denied ? 'denied' : 'expired',
    message: denied ? 'This sign-in was cancelled. Start again from the app that asked.' : 'This sign-in is over. Start again.'
  })
  return false
}

/**
 * THE END OF A SIGN-IN ON THE AUTH ORIGIN.
 *
 * Everything before this line is the ladder every client already climbs; this
 * is the one place where the auth origin differs from the product origin. A
 * sign-in that finishes here mints its session exactly as anywhere else, and
 * then hands the page a way back instead of the session: the token is held
 * for the client that opened the request and reaches it only through a
 * one-use code spent with that client's verifier. No cookie is set here.
 */

/** Where the product origin lives, which is where every client is returned to. */
export function productOrigin(v2: V2Identity): string {
  if (v2.origin === null || v2.origin === '') throw new Error('The auth origin needs a configured product origin')
  return v2.origin.replace(/\/+$/, '')
}

/** The way back for this request, carrying the code or the error and nothing else. */
export function handoffFor(v2: V2Identity, request: AuthRequest, outcome: { code: string } | { error: 'denied' | 'expired' }): AuthHandoff {
  if (request.client === 'cli') return { kind: 'cli' }
  if (request.client === 'web') {
    const params = new URLSearchParams({ ...outcome, state: request.clientState ?? '' })
    return { kind: 'web', url: `${productOrigin(v2)}/auth/complete?${params.toString()}` }
  }
  const params = new URLSearchParams({ ...outcome, state: request.clientState ?? '' }).toString()
  const scheme = `cookrew://${OAUTH_SCHEME_HOST}#${params}`
  const port = request.back?.port
  const loopback = port === undefined ? null : `http://127.0.0.1:${port}${OAUTH_LOOPBACK_PATH}?${params}`
  const first = request.back?.scheme === false && loopback !== null ? loopback : scheme
  return { kind: 'app', url: first, fallback: first === scheme ? loopback : null }
}

/** Hold the result for the client and tell the page where to go. */
export function finishRequest(
  ctx: V2Context,
  request: AuthRequest,
  result: AuthResult,
  extra: Record<string, unknown> = {},
  linkProof: ProviderProof | null = null
): void {
  if (!stillOpen(ctx, request)) return
  // A page showing recovery codes keeps the person for as long as saving them
  // takes; the code waiting behind that screen lives as long as a request.
  const ttl = extra.codes === undefined ? AUTH_CODE_TTL_MS : AUTH_REQUEST_TTL_MS
  const code = ctx.v2.auth?.requests.complete(request, result, ttl, linkProof) ?? null
  ctx.v2.auth?.log(`auth request finished: client=${request.client} intent=${request.intent} status=${result.status}`)
  const handoff = code === null ? handoffFor(ctx.v2, request, { error: 'expired' }) : handoffFor(ctx.v2, request, { code })
  v2Json(ctx.response, 200, { status: 'authorized', handoff: request.client === 'cli' ? { kind: 'cli' } : handoff, ...extra })
}

/**
 * A SESSION FOR THE REQUEST'S DEVICE, minted and held. `codes` is set when the
 * account was made on this page: its recovery codes are shown once, here,
 * because this is the only screen the person who made it is looking at.
 */
export function authorizeSession(
  ctx: V2Context,
  request: AuthRequest,
  username: string,
  deviceId: string,
  hasPassword: boolean,
  options: { codes?: boolean; verifiedBy?: VerifiedBy; trust?: false } = {}
): boolean {
  const { v2, response } = ctx
  if (!stillOpen(ctx, request)) return false
  const session = v2.accounts.startSession(username, deviceId, {
    ...(options.verifiedBy === undefined ? {} : { verifiedBy: options.verifiedBy }),
    ...(options.trust === false ? { trust: false as const } : {})
  })
  if (session === null) {
    refuse(response, 500, 'malformed')
    return false
  }
  const minted = v2.tokens.mintSession(username, deviceId, session.jti, tokenExpiry(session, ctx.v2.now(), SESSION_TTL_MS))
  const codes = options.codes === true ? v2.accounts.mintRecoveryCodes(username, session.jti) : null
  finishRequest(
    ctx,
    request,
    { status: 201, body: { token: minted.token, exp: minted.exp, deviceId, username, hasPassword } },
    codes === null ? {} : { codes }
  )
  return true
}
