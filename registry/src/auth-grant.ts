import { jwkThumbprint } from '../../src/shared/jwk-thumbprint'
import type { AuthOpener, AuthRequest } from './auth-requests'
import { finishRequest } from './auth-finish'
import { tryGrantPassword } from './v2-device-grant'
import { signedIn, v2Json, type Signed, type V2Context } from './v2-http'

/**
 * THE DEVICE PASS BY PASSWORD, FOR THE CONSOLE — typed here, never there
 * (owner 2026-11-10).
 *
 * The console is the page that draws what machines send and keeps its tokens
 * where a script could read them. A passkey is safe to touch on such a page: a
 * touch signs one challenge and nothing reusable leaves. A password is not: a
 * script that saw it once has it for good. So the console never takes one
 * (v2-device-grant.ts refuses it unread), and sends the person here instead:
 *
 *   1. The console's page opens a `grant` request with its own session, device
 *      key, challenge and state (POST /v2/auth/requests on the API host).
 *   2. The person types the account password on THIS origin
 *      (POST /auth/api/grant), under the same three-tries rule as a pass asked
 *      for anywhere else.
 *   3. The page goes back to the console with a one-use code, and the console
 *      spends it (POST /v2/auth/token) with its verifier AND the sign-in that
 *      opened the request. Only then is a pass minted, bound to the console's
 *      own device key, exactly as a passkey's is.
 *
 * Nothing typed here counts until that last step, in the browser that asked.
 * A stranger holding the request's link can type a password and gets a code
 * only the console that asked can spend.
 */

const SAID = {
  notThisRequest: 'This page was not opened to open your machines. Start again from the console.',
  over: 'This already finished. Start again from the console.',
  sessionOver: 'The console session that asked for this has ended. Sign in to the console again, then try once more.',
  locked: 'This account is locked down after “Not me”. Change the password at auth.cookrew.dev first.',
  noPassword: 'This account has no password. Use a passkey in the console, or set a password at auth.cookrew.dev first.',
  wrong: 'That is not the account password.',
  resting: 'Too many wrong tries. Try again in a minute.',
  empty: 'Type your account password.',
  badDevice: 'This device’s key cannot be named. Sign in to the console again.'
} as const

const said = (ctx: V2Context, status: number, error: string, message: string, extra: Record<string, unknown> = {}): void =>
  v2Json(ctx.response, status, { error, message, ...extra })

/** The sign-in a session continues: carried across renewals, so a token renewed mid-trip is still the one that asked. */
const sittingOf = (ctx: V2Context, signed: Signed): string =>
  ctx.v2.accounts.session(signed.account.username, signed.claims.jti)?.sitting ?? signed.claims.jti

/** Is the sign-in that opened this request still live, on the device that opened it? */
function openerLive(ctx: V2Context, opener: AuthOpener): boolean {
  const live = ctx.v2.accounts.liveSessionOf(opener.username, opener.device)
  return live !== null && (live.sitting ?? live.jti) === opener.jti
}

/**
 * WHO MAY OPEN A GRANT REQUEST: a console session, for its own device, on an
 * account that has a password to type. The opener records the SIGN-IN (its
 * sitting), not the token: a console token is renewed every few minutes.
 * Answers null with the refusal written.
 */
export function openerForGrant(ctx: V2Context, signed: Signed | null, deviceId: string): AuthOpener | null {
  if (signed === null) {
    said(ctx, 401, 'unauthenticated', SAID.sessionOver)
    return null
  }
  if (signed.claims.via !== 'console') {
    said(ctx, 400, 'bad_flow', SAID.notThisRequest)
    return null
  }
  if (deviceId !== signed.claims.dev) {
    said(ctx, 403, 'not_this_device', SAID.badDevice)
    return null
  }
  if (ctx.v2.factors.store.mustChangePassword(signed.account.username)) {
    said(ctx, 403, 'locked', SAID.locked)
    return null
  }
  if (signed.account.passwordless === true) {
    said(ctx, 409, 'password_required', SAID.noPassword)
    return null
  }
  return { username: signed.account.username, jti: sittingOf(ctx, signed), device: signed.claims.dev }
}

/** POST /auth/api/grant {password} — on the auth origin, for the bound request. */
export async function grantOnPage(ctx: V2Context, request: AuthRequest, body: Record<string, unknown>): Promise<void> {
  const { v2 } = ctx
  const opener = request.opener
  if (request.intent !== 'grant' || opener === null) return said(ctx, 404, 'not_this_request', SAID.notThisRequest)
  if (v2.auth?.requests.isOpen(request) !== true) return said(ctx, 410, 'expired', SAID.over)
  const account = v2.accounts.get(opener.username)
  if (account === null || !openerLive(ctx, opener)) return said(ctx, 401, 'session_over', SAID.sessionOver)
  if (v2.factors.store.mustChangePassword(opener.username)) return said(ctx, 403, 'locked', SAID.locked)
  if (account.passwordless === true) return said(ctx, 409, 'password_required', SAID.noPassword)
  if (typeof body.password !== 'string' || body.password === '') return said(ctx, 400, 'proof_required', SAID.empty)
  const tried = await tryGrantPassword(ctx, opener.username, opener.device, body.password)
  if (!tried.ok) {
    if (tried.resting) return said(ctx, 429, 'resting', SAID.resting, { retryAfterMs: tried.retryAfterMs })
    return said(ctx, 401, 'wrong', SAID.wrong, { triesLeft: tried.triesLeft })
  }
  v2.auth.log('device pass: password typed on the auth origin')
  // What is held for the console is that a password was typed, and nothing
  // else: the pass itself is minted when the console that asked spends the code.
  finishRequest(ctx, request, { status: 201, body: { status: 'grant' } })
}

/**
 * THE PASS IS MINTED HERE AND ONLY HERE: for the console that opened the
 * request, holding its verifier (checked by the redeem) and the very sign-in
 * that asked. A browser that got hold of the request's link can finish the
 * page and is handed nothing.
 */
export function spendGrant(ctx: V2Context, request: AuthRequest): void {
  const { v2, response } = ctx
  const signed = signedIn(ctx.request, v2, 'bearer')
  const opener = request.opener
  if (
    signed === null ||
    opener === null ||
    signed.claims.via !== 'console' ||
    signed.account.username !== opener.username ||
    signed.claims.dev !== opener.device ||
    sittingOf(ctx, signed) !== opener.jti
  ) {
    return said(ctx, 401, 'unauthenticated', SAID.sessionOver)
  }
  if (v2.factors.store.mustChangePassword(signed.account.username)) return said(ctx, 403, 'locked', SAID.locked)
  const jkt = jwkThumbprint(signed.device.jwk)
  if (jkt === null) return said(ctx, 400, 'bad_device', SAID.badDevice)
  const minted = v2.tokens.mintGrant(signed.account.username, signed.device.id, jkt, opener.jti)
  response.setHeader('cache-control', 'private, no-store')
  v2Json(response, 201, { grant: minted.token, exp: minted.exp, deviceId: signed.device.id })
}
