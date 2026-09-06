import type { IncomingMessage, ServerResponse } from 'node:http'
import { V2Accounts, type V2Account, type V2Device } from './v2-accounts'
import { V2Seats } from './v2-seats'
import { SESSION_TTL_MS, V2Tokens, type V2Claims } from './v2-tokens'
import { Limiter, callerAddress } from './v2-limiter'
import { passwordGate } from './v2-hash-gate'
import { createFactorState, type FactorState } from './v2-factor-state'
import { v2Error, type V2Error } from './v2-copy'
import type { LegacyIdentity } from './v2-migrate-routes'
import type { DoorRecord } from './doors'
import type { NamesFeature } from './names'

/**
 * IDENTITY v2 — THE PLUMBING EVERY /v2 ROUTE SHARES.
 *
 * How the half is assembled, who is asking, and how an answer is written.
 * It lives apart from the routes because there are now two files of them —
 * accounts and seats — and a second copy of "is this person signed in" would
 * be a second opinion about it.
 *
 * Three rules hold across every answer under /v2:
 *   · private, no-store. Every one of these is about one reader.
 *   · a refusal is `{error, message}` where the message is a sentence.
 *   · a cookie-carried write from another site is refused, not performed.
 */

/**
 * THE BROWSER'S SESSION COOKIE, AND WHY ITS NAME BEGINS WITH `__Host-`.
 *
 * It was `cr_session`, a host-only cookie — and reach v2.1 introduces
 * attacker-influenced names under `*.d.cookrew.dev`. A document served from
 * one of those is same-site with cookrew.dev, and a same-site document may set
 * a cookie with `Domain=cookrew.dev`, which then arrives on every request to
 * cookrew.dev alongside the real one. `sessionTokenOf` takes the first match,
 * so a stranger could choose which session the registry believed it was
 * talking to: session fixation, by writing a cookie from a subdomain.
 *
 * The `__Host-` prefix is the browser-enforced answer. A cookie with this
 * prefix is REFUSED unless it is Secure, Path=/, and carries no Domain at all
 * — which means no subdomain of ours, however it is obtained, can write one.
 * All three attributes are therefore not optional here, and `Secure` is set
 * unconditionally rather than only over https: without it the prefix rule
 * rejects the cookie outright, and every current browser accepts a Secure
 * cookie over http://localhost, which is the only place we are not on https.
 *
 * NO DUAL READ. The old name is not accepted for a release: accepting it is
 * precisely the shadowing hole this closes, and every live session was ended
 * by the v2 rollout in any case. The cost is that everyone signs in once more.
 */
export const SESSION_COOKIE = '__Host-cr_session'
/** The name it had before, kept so the relay never forwards a stale one. */
export const LEGACY_SESSION_COOKIE = 'cr_session'
const COOKIE_VALUE = /^[A-Za-z0-9._-]+$/

export const PRIVATE: Record<string, string> = {
  'cache-control': 'private, no-store',
  vary: 'cookie, authorization'
}

export interface V2Identity {
  accounts: V2Accounts
  tokens: V2Tokens
  /** Who may open which door — phase 5's fact. */
  seats: V2Seats
  /** Per-IP on claiming, per username+IP on signing in. The contract's numbers. */
  /** Per-IP on claiming, per username+IP on signing in, loose on lookups. */
  limits: { accounts: Limiter; sessions: Limiter; lookups: Limiter; hello: Limiter }
  /** Addresses whose X-Forwarded-For may be believed. Empty by default. */
  trustedProxies: readonly string[]
  /** Phase 4: passkeys, authenticators, pending sign-ins and approvals. */
  factors: FactorState
  /**
   * The canonical public origin, when the deployment knows it. WebAuthn
   * compares an assertion's origin and rpId against a string; null means
   * "use the Host", which is what a dev binary and a test do.
   */
  origin: string | null
}

export interface V2Options {
  /** Where a store's own sentence goes — a seat cap reached, and the like. */
  log?: (message: string) => void
  limits?: {
    accountsPerMinute: number
    sessionsPerMinute: number
    lookupsPerMinute?: number
    helloPerMinute?: number
  }
  trustedProxies?: readonly string[]
  now?: () => number
  /** The origin a browser sees — https://cookrew.dev in production. */
  origin?: string
}

/**
 * Build the v2 half from a data directory. One function so a deployment, a
 * test and the dev binary all assemble it the same way — the store and the
 * token key have to agree about revocation, and that wiring is easy to get
 * subtly wrong twice.
 */
export function createV2(base: string, options: V2Options = {}): V2Identity {
  const accounts = new V2Accounts(base, options.now)
  const tokens = new V2Tokens(base, {
    revoked: () => new Set(accounts.revokedIds()),
    now: options.now
  })
  return {
    accounts,
    tokens,
    seats: new V2Seats(base, options.now, options.log),
    limits: {
      accounts: new Limiter(options.limits?.accountsPerMinute ?? 10, 60_000, options.now),
      sessions: new Limiter(options.limits?.sessionsPerMinute ?? 5, 60_000, options.now),
      lookups: new Limiter(options.limits?.lookupsPerMinute ?? 60, 60_000, options.now),
      // A light one: the /me page checks a hello per candidate address per
      // desktop; sixty a minute leaves that alone and still caps a client
      // asking the registry to verify signatures for sport.
      hello: new Limiter(options.limits?.helloPerMinute ?? 60, 60_000, options.now)
    },
    trustedProxies: options.trustedProxies ?? [],
    factors: createFactorState(base, { now: options.now }),
    origin: options.origin ?? null
  }
}

export interface V2Context {
  method: string
  parts: string[]
  request: IncomingMessage
  response: ServerResponse
  v2: V2Identity
  /** https, so the cookie is marked Secure. Never guessed from the request alone. */
  secure: boolean
  decode: (value: string) => string | null
  /**
   * The directory, for the routes that answer about a team. Optional because a
   * registry can run without one, and a seat at a door nobody serves is a 404
   * rather than a crash.
   */
  doors?: { get: (handle: string, name: string) => DoorRecord | null }
  /**
   * REACH v2.1 — the DNS zone and the ACME client, when this deployment was
   * given one. Absent → the cert route answers 503 and the reach card carries
   * `names: false`, which is the truth rather than a missing field.
   */
  names?: NamesFeature
  /**
   * The v1 identity service, for the migration routes only (phase 6): a
   * handle it knows is RESERVED for the key that holds it. Absent on a
   * registry with no v1 credentials, where nothing has to be migrated.
   */
  legacy?: LegacyIdentity
}

// ── answers ──────────────────────────────────────────────────────────────

export function v2Json(
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

export const refuse = (
  response: ServerResponse,
  code: number,
  error: V2Error,
  subject?: string,
  headers: Record<string, string> = {}
): void => v2Json(response, code, v2Error(error, subject), headers)

export function noContent(response: ServerResponse, headers: Record<string, string> = {}): void {
  response.writeHead(204, { ...PRIVATE, ...headers })
  response.end()
}

export function head(response: ServerResponse, code: number): void {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...PRIVATE })
  response.end()
}

/** Secure, Path=/, no Domain — the three the `__Host-` prefix requires. */
export const cookie = (token: string): string =>
  `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Lax; Secure`
export const clearedCookie = (): string =>
  `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`

// ── reading who is asking ────────────────────────────────────────────────

export function sessionTokenOf(request: IncomingMessage, mode: 'any' | 'bearer' = 'any'): string | null {
  const auth = request.headers.authorization ?? ''
  if (auth.startsWith('Bearer ')) {
    const value = auth.slice(7).trim()
    return COOKIE_VALUE.test(value) ? value : null
  }
  if (mode === 'bearer') return null
  // ONLY the prefixed name. The old one is never read: a cookie a subdomain
  // could have written is exactly what this stopped being willing to believe.
  const found = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([A-Za-z0-9._-]+)`).exec(request.headers.cookie ?? '')
  return found?.[1] ?? null
}

export interface Signed {
  claims: V2Claims
  account: V2Account
  device: V2Device
}

/**
 * The account behind a request, or null. The signature is checked by the token
 * layer (which also refuses a revoked device); the store answers the half a
 * signature cannot — was this session ended, is this device still attached.
 */
export function signedIn(request: IncomingMessage, v2: V2Identity, mode: 'any' | 'bearer' = 'any'): Signed | null {
  const token = sessionTokenOf(request, mode)
  if (token === null) return null
  const claims = v2.tokens.verify(token, 'session')
  if (claims === null) return null
  const found = v2.accounts.authenticate(claims)
  return found === null ? null : { claims, account: found.account, device: found.device }
}

/** For server.ts's `accountOf`: the username a v2 session names, or null. */
export function v2AccountOf(request: IncomingMessage, v2: V2Identity, mode: 'any' | 'bearer' = 'any'): string | null {
  return signedIn(request, v2, mode)?.account.username ?? null
}

/**
 * A COOKIE-CARRIED WRITE FROM ANOTHER SITE IS NOT THIS PERSON'S WISH.
 *
 * SameSite=Lax already keeps the cookie off a cross-site POST in every browser
 * that honours it. This is the second lock: an Origin that is not ours on a
 * write is refused outright. Absent Origin is allowed, because that is what a
 * desktop app and a curl look like — and neither of them carries a cookie a
 * browser attached on somebody's behalf.
 */
export function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  // A literal `null` origin is NOT "no origin": it is a sandboxed frame, a
  // data: document or a file:// page — every one of them a context that
  // should not be able to spend somebody's cookie.
  if (origin === 'null') return false
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

/** The address the limiter counts by. Never an identity — see v2-limiter.ts. */
export const asking = (ctx: V2Context): string =>
  callerAddress(ctx.request.headers, ctx.request.socket.remoteAddress, ctx.v2.trustedProxies)

/**
 * IS THE HASHER FULL? Asked before a password route does anything, so an
 * overload is a 503 a client can retry rather than a request that waits
 * behind thirty others for a stretch it will time out on.
 */
export function overloaded(response: ServerResponse): boolean {
  if (!passwordGate.overloaded) return false
  refuse(response, 503, 'busy', undefined, { 'retry-after': '5' })
  return true
}
