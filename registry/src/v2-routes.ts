import { readJsonBody } from './http'
import {
  clearedCookie,
  cookie,
  head,
  noContent,
  refuse,
  sameOrigin,
  signedIn,
  v2Json,
  type V2Context
} from './v2-http'
import { handleSeatRoute, mySeats } from './v2-seat-routes'
import type { V2Account } from './v2-accounts'
import { callerAddress } from './v2-limiter'

/**
 * IDENTITY v2 — THE ACCOUNT ROUTES.
 *
 * Everything under /v2 that is about a PERSON: claiming a username, signing
 * in, the devices attached to it, and /me. The plumbing every route shares
 * (who is asking, how an answer is written) is in v2-http; the seats a person
 * holds at other people's doors are in v2-seat-routes, mounted below.
 *
 * The old /v1 routes keep working for the accounts that already exist; the
 * two only ever meet at `accountOf`, which now answers for either.
 */

export {
  SESSION_COOKIE,
  createV2,
  signedIn,
  sessionTokenOf,
  v2AccountOf,
  type Signed,
  type V2Context,
  type V2Identity,
  type V2Options
} from './v2-http'

/** Bodies: an account or a session is small; a profile carries a picture. */
const SMALL_BODY = 16 * 1024
const PROFILE_BODY = 192 * 1024

// ── the router ───────────────────────────────────────────────────────────

/** Answers true when it claimed the request; /v2 is owned entirely by these two files. */
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
  // Seats — a person at somebody else's door. Its own file, same plumbing.
  if (handleSeatRoute(ctx, rest)) return true
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
  // The seats this person holds, anywhere — rendered by the seat routes so
  // there is one shape of a seat on the wire.
  if (rest.length === 1 && rest[0] === 'seats' && method === 'GET') {
    mySeats(ctx, signed)
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
