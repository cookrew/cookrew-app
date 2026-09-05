import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody } from './http'
import { V2Accounts, type V2Account, type V2Device } from './v2-accounts'
import { SESSION_TTL_MS, V2Tokens, type V2Claims } from './v2-tokens'
import { Limiter, callerAddress } from './v2-limiter'
import { v2Error, type V2Error } from './v2-copy'

/**
 * IDENTITY v2 — THE ROUTES.
 *
 * Everything under /v2, mounted beside /v1 and touching none of it. The old
 * routes keep working for the accounts that already exist; v2 is what a
 * PERSON signs into — a username and a password, with devices attached to it —
 * and the two only ever meet at `accountOf`, which now answers for either.
 *
 * Three rules hold across every answer here:
 *   · private, no-store. Every one of these is about one reader.
 *   · a refusal is `{error, message}` where the message is a sentence.
 *   · a cookie-carried write from another site is refused, not performed.
 */

/** The browser's session cookie. HttpOnly, so no script can read or steal it. */
export const SESSION_COOKIE = 'cr_session'
const COOKIE_VALUE = /^[A-Za-z0-9._-]+$/

const PRIVATE: Record<string, string> = { 'cache-control': 'private, no-store', vary: 'cookie, authorization' }
/** Bodies: an account or a session is small; a profile carries a picture. */
const SMALL_BODY = 16 * 1024
const PROFILE_BODY = 192 * 1024

export interface V2Identity {
  accounts: V2Accounts
  tokens: V2Tokens
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
}

// ── answers ──────────────────────────────────────────────────────────────

function v2Json(response: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    ...PRIVATE,
    ...headers
  })
  response.end(payload)
}

const refuse = (
  response: ServerResponse,
  code: number,
  error: V2Error,
  subject?: string,
  headers: Record<string, string> = {}
): void => v2Json(response, code, v2Error(error, subject), headers)

function noContent(response: ServerResponse, headers: Record<string, string> = {}): void {
  response.writeHead(204, { ...PRIVATE, ...headers })
  response.end()
}

function head(response: ServerResponse, code: number): void {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...PRIVATE })
  response.end()
}

const cookie = (token: string, secure: boolean): string =>
  `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
const clearedCookie = (secure: boolean): string =>
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
function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

// ── the router ───────────────────────────────────────────────────────────

/** Answers true when it claimed the request; /v2 is owned entirely by this file. */
export function handleV2Route(ctx: V2Context): boolean {
  if (ctx.parts[0] !== 'v2') return false
  const { method, parts, response } = ctx
  const writes = method !== 'GET' && method !== 'HEAD'
  if (writes && !sameOrigin(ctx.request)) {
    refuse(response, 403, 'bad_origin')
    return true
  }
  const rest = parts.slice(1)

  if (rest.length === 1 && rest[0] === 'keys' && method === 'GET') {
    v2Json(response, 200, { jwk: ctx.v2.tokens.publicKeyJwk(), revoked: ctx.v2.accounts.revokedDevices() })
    return true
  }
  if (rest.length === 1 && rest[0] === 'accounts' && method === 'POST') {
    void claimAccount(ctx)
    return true
  }
  if (rest.length === 2 && rest[0] === 'accounts' && (method === 'GET' || method === 'HEAD')) {
    lookUpAccount(ctx, ctx.decode(rest[1]) ?? '')
    return true
  }
  if (rest.length === 1 && rest[0] === 'sessions' && method === 'POST') {
    void openSession(ctx)
    return true
  }
  if (rest.length === 2 && rest[0] === 'sessions' && rest[1] === 'current' && (method === 'DELETE' || method === 'POST')) {
    signOut(ctx)
    return true
  }
  if (rest.length === 1 && rest[0] === 'recovery' && method === 'POST') {
    void redeemRecovery(ctx)
    return true
  }
  if (rest[0] === 'me') {
    void mine(ctx, rest.slice(1))
    return true
  }
  refuse(response, 404, 'not_found')
  return true
}

// ── /v2/accounts ─────────────────────────────────────────────────────────

async function claimAccount(ctx: V2Context): Promise<void> {
  const { response, v2 } = ctx
  const who = callerAddress(ctx.request.headers, ctx.request.socket.remoteAddress)
  if (!v2.limits.accounts.take(`claim|${who}`)) {
    refuse(response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
    return
  }
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const out = v2.accounts.create({
    username: body.value.username,
    password: body.value.password,
    device: body.value.device
  })
  if (!out.ok) {
    const username = typeof body.value.username === 'string' ? body.value.username : undefined
    refuse(response, out.reason === 'taken' ? 409 : 400, out.reason, username)
    return
  }
  const session = v2.accounts.startSession(out.account.username, out.device.id)
  if (session === null) {
    refuse(response, 500, 'malformed')
    return
  }
  const minted = v2.tokens.mintSession(out.account.username, out.device.id, session.jti)
  v2Json(
    response,
    201,
    {
      username: out.account.username,
      deviceId: out.device.id,
      session: { token: minted.token, exp: minted.exp }
    },
    { 'set-cookie': cookie(minted.token, ctx.secure) }
  )
}

/**
 * IS THIS NAME FREE — the question the register sheet asks on every keystroke.
 * A HEAD, so the answer is a status and nothing else, and a GET for the public
 * profile: a name, a display name and a face. Never a device: what somebody
 * signs in with is not a public fact about them.
 */
function lookUpAccount(ctx: V2Context, username: string): void {
  const profile = ctx.v2.accounts.publicProfile(username)
  if (ctx.method === 'HEAD') {
    head(ctx.response, profile === null ? 404 : 200)
    return
  }
  if (profile === null) {
    refuse(ctx.response, 404, 'not_found')
    return
  }
  v2Json(ctx.response, 200, profile)
}

// ── /v2/sessions ─────────────────────────────────────────────────────────

async function openSession(ctx: V2Context): Promise<void> {
  const { response, v2 } = ctx
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const who = callerAddress(ctx.request.headers, ctx.request.socket.remoteAddress)
  const named = typeof body.value.username === 'string' ? body.value.username.trim().toLowerCase() : ''
  // Keyed by name AND address: one person fumbling their own password must not
  // be able to lock a stranger out of theirs, and a burst from one machine
  // against many names must not be free either.
  if (!v2.limits.sessions.take(`signin|${named}|${who}`)) {
    refuse(response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
    return
  }
  const out = v2.accounts.signIn({
    username: body.value.username,
    password: body.value.password,
    device: body.value.device
  })
  if (!out.ok) {
    refuse(response, out.reason === 'bad_device' ? 400 : 401, out.reason)
    return
  }
  /**
   * PHASE 4'S SEAM. When an account has a passkey or an authenticator this is
   * where the ladder starts: the answer becomes a 401 naming the factors
   * instead of a session. Today every account answers null, and the route is
   * written so that adding factors is a branch here rather than a new route.
   */
  const factor = v2.accounts.nextFactorFor(out.account)
  if (factor !== null) {
    refuse(response, 401, 'unauthenticated')
    return
  }
  const session = v2.accounts.startSession(out.account.username, out.device.id)
  if (session === null) {
    refuse(response, 500, 'malformed')
    return
  }
  const minted = v2.tokens.mintSession(out.account.username, out.device.id, session.jti)
  v2Json(
    response,
    201,
    { token: minted.token, exp: minted.exp, deviceId: out.device.id },
    { 'set-cookie': cookie(minted.token, ctx.secure) }
  )
}

function signOut(ctx: V2Context): void {
  const signed = signedIn(ctx.request, ctx.v2)
  if (signed !== null) ctx.v2.accounts.closeSession(signed.account.username, signed.claims.jti)
  // 204 either way: signing out of a session that has already ended is not an
  // error, and telling a caller which it was leaks whether a token was live.
  noContent(ctx.response, { 'set-cookie': clearedCookie(ctx.secure) })
}

async function redeemRecovery(ctx: V2Context): Promise<void> {
  const { response, v2 } = ctx
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const who = callerAddress(ctx.request.headers, ctx.request.socket.remoteAddress)
  const named = typeof body.value.username === 'string' ? body.value.username.trim().toLowerCase() : ''
  if (!v2.limits.sessions.take(`signin|${named}|${who}`)) {
    refuse(response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
    return
  }
  // Spent BEFORE the device is looked at: a code that was read out is gone
  // whether or not the rest of the request was well formed.
  if (!v2.accounts.useRecoveryCode(named, body.value.code)) {
    refuse(response, 401, 'bad_credentials')
    return
  }
  const attached = v2.accounts.attachDevice(named, body.value.device)
  if (!attached.ok) {
    refuse(response, attached.reason === 'bad_device' ? 400 : 401, attached.reason)
    return
  }
  const session = v2.accounts.startSession(named, attached.device.id)
  if (session === null) {
    refuse(response, 500, 'malformed')
    return
  }
  const minted = v2.tokens.mintSession(named, attached.device.id, session.jti)
  v2Json(
    response,
    201,
    { token: minted.token, exp: minted.exp, deviceId: attached.device.id },
    { 'set-cookie': cookie(minted.token, ctx.secure) }
  )
}

// ── /v2/me ───────────────────────────────────────────────────────────────

export function meBody(account: V2Account, currentDeviceId: string): Record<string, unknown> {
  return {
    username: account.username,
    displayName: account.displayName,
    avatar: account.avatar,
    claimedAt: account.claimedAt,
    devices: account.devices.map((d) => ({
      id: d.id,
      kind: d.kind,
      name: d.name,
      addedAt: d.addedAt,
      lastSeenAt: d.lastSeenAt,
      current: d.id === currentDeviceId
    })),
    desktops: account.desktops.map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      workspaces: d.workspaces,
      updatedAt: d.updatedAt
    })),
    recoveryCodesLeft: account.recovery.length
  }
}

async function mine(ctx: V2Context, rest: string[]): Promise<void> {
  const { response, v2, method } = ctx
  const signed = signedIn(ctx.request, v2)
  if (signed === null) {
    refuse(response, 401, 'unauthenticated')
    return
  }
  const { account, claims } = signed

  if (rest.length === 0 && method === 'GET') {
    v2.accounts.touch(account.username, claims.dev)
    const fresh = v2.accounts.get(account.username) ?? account
    v2Json(response, 200, meBody(fresh, claims.dev))
    return
  }
  if (rest.length === 0 && method === 'PATCH') {
    const body = await readJsonBody(ctx.request, PROFILE_BODY)
    if (!body.ok) {
      refuse(response, body.reason === 'too_large' ? 413 : 400, 'malformed')
      return
    }
    const out = v2.accounts.setProfile(account.username, {
      ...(body.value.displayName === undefined ? {} : { displayName: body.value.displayName }),
      ...(body.value.avatar === undefined ? {} : { avatar: body.value.avatar })
    })
    if (!out.ok) {
      refuse(response, out.reason === 'not_found' ? 404 : 400, out.reason)
      return
    }
    v2Json(response, 200, meBody(v2.accounts.get(account.username) ?? account, claims.dev))
    return
  }
  if (rest.length === 1 && rest[0] === 'devices' && method === 'GET') {
    v2Json(response, 200, { devices: meBody(account, claims.dev).devices })
    return
  }
  if (rest.length === 2 && rest[0] === 'devices' && method === 'DELETE') {
    const id = (ctx.decode(rest[1]) ?? '').toLowerCase()
    const out = v2.accounts.revokeDevice(account.username, id)
    if (!out.ok) {
      refuse(response, out.reason === 'last_device' ? 409 : 404, out.reason)
      return
    }
    // Revoking the device in your hand is allowed, and it ends this session —
    // so the browser is handed an empty cookie rather than one that no longer
    // opens anything.
    noContent(response, id === claims.dev ? { 'set-cookie': clearedCookie(ctx.secure) } : {})
    return
  }
  if (rest.length === 1 && rest[0] === 'password' && method === 'POST') {
    const body = await readJsonBody(ctx.request, SMALL_BODY)
    if (!body.ok) {
      refuse(response, body.reason === 'too_large' ? 413 : 400, 'malformed')
      return
    }
    const out = v2.accounts.changePassword(account.username, body.value.current, body.value.next)
    if (!out.ok) {
      refuse(response, out.reason === 'bad_credentials' ? 401 : 400, out.reason)
      return
    }
    noContent(response)
    return
  }
  if (rest.length === 1 && rest[0] === 'recovery-codes' && method === 'POST') {
    const codes = v2.accounts.mintRecoveryCodes(account.username)
    // Shown ONCE. They are stored hashed, so this is the only moment they
    // exist in readable form anywhere.
    v2Json(response, 201, { codes })
    return
  }
  if (rest.length === 2 && rest[0] === 'desktops' && method === 'PUT') {
    const deviceId = (ctx.decode(rest[1]) ?? '').toLowerCase()
    // Only that desktop may describe itself: another device of the same
    // account could otherwise rewrite the workspace list of a machine it has
    // never seen.
    if (deviceId !== claims.dev) {
      refuse(response, 403, 'not_this_device')
      return
    }
    const body = await readJsonBody(ctx.request, SMALL_BODY)
    if (!body.ok) {
      refuse(response, body.reason === 'too_large' ? 413 : 400, 'malformed')
      return
    }
    const out = v2.accounts.putDesktop(account.username, deviceId, {
      name: body.value.name,
      workspaces: body.value.workspaces
    })
    if (!out.ok) {
      refuse(response, out.reason === 'not_found' ? 404 : 400, out.reason)
      return
    }
    noContent(response)
    return
  }
  refuse(response, 404, 'not_found')
}
