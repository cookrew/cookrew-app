import type { IncomingMessage, ServerResponse } from 'node:http'
import { V2Accounts, type V2Account, type V2Device } from './v2-accounts'
import { V2Seats } from './v2-seats'
import { SESSION_TTL_MS, V2Tokens, type V2Claims } from './v2-tokens'
import { Limiter } from './v2-limiter'
import { v2Error, type V2Error } from './v2-copy'
import type { DoorRecord } from './doors'

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

/** The browser's session cookie. HttpOnly, so no script can read or steal it. */
export const SESSION_COOKIE = 'cr_session'
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
  limits: { accounts: Limiter; sessions: Limiter }
}

export interface V2Options {
  limits?: { accountsPerMinute: number; sessionsPerMinute: number }
  now?: () => number
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
    revoked: () => new Set(accounts.revokedDevices()),
    now: options.now
  })
  return {
    accounts,
    tokens,
    seats: new V2Seats(base, options.now),
    limits: {
      accounts: new Limiter(options.limits?.accountsPerMinute ?? 10, 60_000, options.now),
      sessions: new Limiter(options.limits?.sessionsPerMinute ?? 5, 60_000, options.now)
    }
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

export const cookie = (token: string, secure: boolean): string =>
  `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
export const clearedCookie = (secure: boolean): string =>
  `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`

// ── reading who is asking ────────────────────────────────────────────────

export function sessionTokenOf(request: IncomingMessage, mode: 'any' | 'bearer' = 'any'): string | null {
  const auth = request.headers.authorization ?? ''
  if (auth.startsWith('Bearer ')) {
    const value = auth.slice(7).trim()
    return COOKIE_VALUE.test(value) ? value : null
  }
  if (mode === 'bearer') return null
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
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}
