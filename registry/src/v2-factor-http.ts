import type { ServerResponse } from 'node:http'
import { callerAddress } from './v2-limiter'
import { v2Error, type V2Error } from './v2-copy'
import { factorError, type FactorError } from './v2-factor-copy'
import { SESSION_COOKIE, type V2Context } from './v2-routes'
import { SESSION_TTL_MS } from './v2-tokens'

/**
 * IDENTITY v2, PHASE 4 — THE SHAPE OF AN ANSWER.
 *
 * The same three rules the rest of /v2 holds to, in the one place phase 4's
 * routes can share them: private and never stored, a refusal that carries a
 * sentence, and a session handed over as a cookie the page cannot read.
 *
 * They are written here rather than imported from v2-routes.ts because that
 * file is being edited by two other phases this week; a helper each phase can
 * see is a helper nobody has to merge.
 */

const PRIVATE: Record<string, string> = { 'cache-control': 'private, no-store', vary: 'cookie, authorization' }

export function json(
  response: ServerResponse,
  code: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    ...PRIVATE,
    ...headers
  })
  response.end(payload)
}

export function noContent(response: ServerResponse, headers: Record<string, string> = {}): void {
  response.writeHead(204, { ...PRIVATE, ...headers })
  response.end()
}

/** A refusal in the shared vocabulary — the one v2-copy.ts already owns. */
export const refuse = (
  response: ServerResponse,
  code: number,
  error: V2Error,
  headers: Record<string, string> = {}
): void => json(response, code, v2Error(error), headers)

/** A refusal in phase 4's own vocabulary. */
export const refuseFactor = (
  response: ServerResponse,
  code: number,
  error: FactorError,
  headers: Record<string, string> = {}
): void => json(response, code, factorError(error), headers)

/** Secure, Path=/, no Domain — the three the `__Host-` prefix requires. */
export const sessionCookie = (token: string): string =>
  `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Lax; Secure`

/** The address a limiter counts by; never an identity (see v2-limiter.ts). */
export const asking = (ctx: V2Context): string =>
  callerAddress(ctx.request.headers, ctx.request.socket.remoteAddress, ctx.v2.trustedProxies)

/**
 * WHO THE BROWSER THINKS IT IS TALKING TO, which is what WebAuthn compares
 * against. The configured origin when there is one — the deployment knows its
 * own name better than a header does — and otherwise the Host this request
 * arrived on, which is what a browser used and therefore what it signed over.
 */
export function relyingParty(ctx: V2Context): { origin: string; rpId: string } {
  // An empty configured origin is NOT a configuration: it would make
  // `new URL('')` throw and quietly hand the rpId back to the Host header.
  const configured = ctx.v2.origin === null || ctx.v2.origin === '' ? null : ctx.v2.origin
  const host = ctx.request.headers.host ?? 'localhost'
  const origin = configured ?? `${ctx.secure ? 'https' : 'http'}://${host}`
  try {
    return { origin, rpId: new URL(origin).hostname }
  } catch {
    return { origin, rpId: host.split(':')[0] }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * ENOUGH OF A DEVICE TO DECIDE THE LADDER BY.
 *
 * The account store is the authority on what a device is and refuses the rest
 * at attach time; this reads only what the ladder needs BEFORE anything is
 * attached — is this device already on the account, and what should the
 * approval prompt call it.
 */
export function deviceShape(input: unknown): { id: string; kind: string; name: string } | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const raw = input as { id?: unknown; kind?: unknown; name?: unknown }
  const id = typeof raw.id === 'string' ? raw.id.toLowerCase() : ''
  if (!UUID.test(id)) return null
  if (raw.kind !== 'desktop' && raw.kind !== 'phone' && raw.kind !== 'browser') return null
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (name.length === 0 || name.length > 64) return null
  return { id, kind: raw.kind, name }
}

/**
 * THE END OF EVERY RUNG — and the only place phase 4 attaches a device.
 *
 * Whatever proved it (a passkey, six digits, a nod from the Mac, a rescue
 * code), the finish is identical: the device joins the account, a sitting is
 * opened for it, and the browser is handed an HttpOnly cookie while the app
 * is handed the same token in the body.
 */
export function completeSignIn(ctx: V2Context, username: string, device: unknown): boolean {
  const { v2, response } = ctx
  const attached = v2.accounts.attachDevice(username, device)
  if (!attached.ok) {
    refuse(response, attached.reason === 'bad_device' ? 400 : 401, attached.reason)
    return false
  }
  const session = v2.accounts.startSession(username, attached.device.id)
  if (session === null) {
    refuse(response, 500, 'malformed')
    return false
  }
  const minted = v2.tokens.mintSession(username, attached.device.id, session.jti)
  json(
    response,
    201,
    { token: minted.token, exp: minted.exp, deviceId: attached.device.id },
    { 'set-cookie': sessionCookie(minted.token) }
  )
  return true
}

/**
 * The challenge inside a clientDataJSON, spent.
 *
 * Read first, then SPENT, then handed to the verifier as what to expect — so
 * a replayed assertion fails on the second presentation whatever else about
 * it is perfect. The ANTI-REPLAY IS `take`, not the equality check downstream:
 * by the time the verifier compares, it is comparing the challenge we just
 * proved we issued against itself.
 */
export function spendChallenge(
  challenges: { take: (key: string, challenge: unknown) => boolean },
  key: string,
  clientDataJSON: unknown
): string | null {
  if (typeof clientDataJSON !== 'string' || clientDataJSON.length > 8192) return null
  if (!/^[A-Za-z0-9_-]+$/.test(clientDataJSON)) return null
  let challenge: unknown
  try {
    challenge = (JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as { challenge?: unknown })
      .challenge
  } catch {
    return null
  }
  if (typeof challenge !== 'string' || challenge === '') return null
  return challenges.take(key, challenge) ? challenge : null
}
