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
  asking,
  overloaded,
  type V2Context
} from './v2-http'
import { handleSeatRoute, mySeats } from './v2-seat-routes'
import { handleMigrateRoute, legacyHolds, refuseIfLegacy } from './v2-migrate-routes'
import type { V2Account, V2Desktop } from './v2-accounts'
import { readReach, verifyHello } from './v2-reach'
import { callerAddress } from './v2-limiter'
import { passwordGate } from './v2-hash-gate'
import { v2Error, type V2Error } from './v2-copy'
import { factorError } from './v2-factor-copy'
import { createFactorState, type FactorState } from './v2-factor-state'
import { handleFactorRoute, signInWithLadder } from './v2-factor-routes'

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

  // PHASE 4, in one line and ahead of everything: the ladder's routes live
  // under /v2/sessions/… and /v2/me/… , and `/v2/me` below would swallow the
  // second half of them. It answers false for every path it does not own.
  if (handleFactorRoute(ctx)) return true

  if (rest.length === 1 && rest[0] === 'keys' && method === 'GET') {
    v2Json(response, 200, { jwk: ctx.v2.tokens.publicKeyJwk(), revoked: ctx.v2.accounts.revokedIds() })
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
  if (rest.length === 1 && rest[0] === 'verify-hello' && method === 'POST') {
    void checkHello(ctx)
    return true
  }
  if (rest[0] === 'me') {
    void mine(ctx, rest.slice(1))
    return true
  }
  // Phase 6 — a handle from before passwords, becoming an account. Its own file.
  if (handleMigrateRoute(ctx, rest)) return true
  // Seats — a person at somebody else's door. Its own file, same plumbing.
  if (handleSeatRoute(ctx, rest)) return true
  refuse(response, 404, 'not_found')
  return true
}

// ── /v2/accounts ─────────────────────────────────────────────────────────

async function claimAccount(ctx: V2Context): Promise<void> {
  const { response, v2 } = ctx
  if (overloaded(response)) return
  const who = asking(ctx)
  if (!v2.limits.accounts.take(`claim|${who}`)) {
    refuse(response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
    return
  }
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  // A NAME A KEY ALREADY HOLDS IS NOT FREE (phase 6), and it is refused here
  // — before anything is created — because a handle serving live doors being
  // minted as a stranger's account is the one mistake this migration cannot
  // take back.
  if (refuseIfLegacy(ctx, body.value.username)) return
  const out = await v2.accounts.create({
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
  if (!ctx.v2.limits.lookups.take(`look|${asking(ctx)}`)) {
    if (ctx.method === 'HEAD') {
      head(ctx.response, 429)
      return
    }
    refuse(ctx.response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
    return
  }
  const profile = ctx.v2.accounts.publicProfile(username)
  if (ctx.method === 'HEAD') {
    // Taken covers a name a v1 key holds with no account behind it yet: the
    // sheet must never call it free, whatever it goes on to say about it.
    head(ctx.response, profile === null && !legacyHolds(ctx, username) ? 404 : 200)
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
  if (overloaded(response)) return
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const who = asking(ctx)
  const named = typeof body.value.username === 'string' ? body.value.username.trim().toLowerCase() : ''
  // Keyed by name AND address: one person fumbling their own password must not
  // be able to lock a stranger out of theirs, and a burst from one machine
  // against many names must not be free either.
  if (!v2.limits.sessions.take(`signin|${named}|${who}`)) {
    refuse(response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
    return
  }
  /**
   * PHASE 4'S SEAM, filled. The password is checked and then the ladder
   * decides: a session for an account with no factors on a device it knows,
   * and otherwise a 401 naming the ways this account can finish.
   *
   * The device is NOT attached here any more. It travels with the pending
   * record and is attached only when a rung is climbed — a password alone
   * putting a new device on an account is the thing the ladder exists to
   * stop.
   */
  await signInWithLadder(ctx, body.value)
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
  if (overloaded(response)) return
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const who = asking(ctx)
  const named = typeof body.value.username === 'string' ? body.value.username.trim().toLowerCase() : ''
  if (!v2.limits.sessions.take(`signin|${named}|${who}`)) {
    refuse(response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
    return
  }
  /**
   * "NOT ME" LOCKS THIS DOOR TOO.
   *
   * Phase 4's ladder refuses the password until it changes; this route is a
   * code and a device with no password at all, and the codes usually come off
   * the same screen the password was phished from. Leaving it open would
   * leave the alarm with a door beside it. The owner is not stranded: they
   * still hold the sitting they answered "not me" from.
   */
  if (v2.factors.store.mustChangePassword(named)) {
    v2Json(response, 403, factorError('password_change_required'))
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

// ── /v2/verify-hello ─────────────────────────────────────────────────────

/**
 * DID THAT REPLY COME FROM MY MAC?
 *
 * The page probes an address and gets back `{deviceId, nonce, sig}`. It cannot
 * check that signature itself — the device's public key is a fact the registry
 * holds — so it asks here, and gets one bit back.
 *
 * ONE BIT, AND ALWAYS THE SAME SHAPE. A device this account does not have, a
 * nonce that is not the one asked about, a signature by another key: all
 * `{ok:false}`. Anything richer would let a signed-in caller use this to learn
 * which device ids exist on other accounts.
 */
async function checkHello(ctx: V2Context): Promise<void> {
  const { response, v2 } = ctx
  const who = callerAddress(ctx.request.headers, ctx.request.socket.remoteAddress)
  if (!v2.limits.hello.take(`hello|${who}`)) {
    refuse(response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
    return
  }
  const signed = signedIn(ctx.request, v2)
  if (signed === null) {
    refuse(response, 401, 'unauthenticated')
    return
  }
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const deviceId = typeof body.value.deviceId === 'string' ? body.value.deviceId.toLowerCase() : ''
  const device = signed.account.devices.find((d) => d.id === deviceId) ?? null
  const ok = device !== null && verifyHello(device.jwk, { deviceId, nonce: body.value.nonce, sig: body.value.sig })
  v2Json(response, 200, { ok })
}

// ── /v2/me ───────────────────────────────────────────────────────────────

/**
 * A DESKTOP, AS ITS OWN ACCOUNT SEES IT — name, workspaces and reach card.
 *
 * The reach card is the whole difference between this and the public profile,
 * which carries neither: an address is a fact about a machine that only the
 * person who owns it may read. `publicProfile` never touches this shape, and
 * that is on purpose rather than by omission.
 */
export function desktopBody(desktop: V2Desktop): Record<string, unknown> {
  return {
    deviceId: desktop.deviceId,
    name: desktop.name,
    workspaces: desktop.workspaces,
    reach: desktop.reach ?? null,
    updatedAt: desktop.updatedAt
  }
}

/**
 * WHAT AN ACCOUNT HAS, on the body every client already reads.
 *
 * The desktop's Security card asks /v2/me and nothing else, so a body without
 * this could only be read as "an older registry, nothing enrolled" — and an
 * account with a live authenticator showed as having none, for ever. It is a
 * posture and never a secret: a passkey's name and when it arrived, whether an
 * authenticator is active, and whether "not me" is still waiting on a password
 * change.
 */
export interface FactorPosture {
  passkeys: readonly { id: string; name: string; addedAt: number }[]
  totp: boolean
  mustChangePassword: boolean
}

export const NO_FACTORS: FactorPosture = { passkeys: [], totp: false, mustChangePassword: false }

export function meBody(
  account: V2Account,
  currentDeviceId: string,
  factors: FactorPosture = NO_FACTORS
): Record<string, unknown> {
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
    desktops: account.desktops.map(desktopBody),
    recoveryCodesLeft: account.recovery.length,
    factors
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
    v2Json(response, 200, meBody(fresh, claims.dev, v2.factors.store.summary(account.username)))
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
    v2Json(
      response,
      200,
      meBody(v2.accounts.get(account.username) ?? account, claims.dev, v2.factors.store.summary(account.username))
    )
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
    if (overloaded(response)) return
    const body = await readJsonBody(ctx.request, SMALL_BODY)
    if (!body.ok) {
      refuse(response, body.reason === 'too_large' ? 413 : 400, 'malformed')
      return
    }
    // The caller's own sitting is kept; every other one ends with the change.
    const out = await v2.accounts.changePassword(
      account.username,
      body.value.current,
      body.value.next,
      claims.jti
    )
    if (!out.ok) {
      refuse(response, out.reason === 'bad_credentials' ? 401 : 400, out.reason)
      return
    }
    // The change is what "not me" was waiting for: the old password is gone,
    // so the lock it put on signing in comes off.
    v2.factors.store.setMustChangePassword(account.username, false)
    noContent(response)
    return
  }
  if (rest.length === 1 && rest[0] === 'recovery-codes' && method === 'POST') {
    const codes = v2.accounts.mintRecoveryCodes(account.username, claims.jti)
    // Shown ONCE. They are stored hashed, so this is the only moment they
    // exist in readable form anywhere.
    v2Json(response, 201, { codes })
    return
  }
  if (rest.length === 1 && rest[0] === 'desktops' && method === 'GET') {
    // ONLY THIS ACCOUNT'S. Any device of it may read them — that is the whole
    // point of the picker — but the answer is built from the signed-in
    // account and never from anything the caller named.
    v2Json(response, 200, account.desktops.map(desktopBody))
    return
  }
  /*
   * THERE IS NO `POST …/desktops/:id/open` ANY MORE (reach v2.1).
   *
   * It minted a canvas token for the `?open=&key=&device=` admission, and that
   * whole ceremony is retired: the relay prefix is already gated by the
   * account session, and what admits a phone AT THE MAC is the pairing token
   * the Mac prints, held by the companion. A second credential minted here
   * would be a second thing to get wrong about a door that is already shut.
   */
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
    // A card is REFUSED, not ignored: a desktop that signed the wrong bytes
    // would otherwise keep publishing workspaces and quietly stay unreachable.
    let reach: ReturnType<typeof readReach> | undefined
    if (body.value.reach !== undefined) {
      reach = readReach(deviceId, signed.device.jwk, { reach: body.value.reach, sig: body.value.sig })
      if (reach === null) {
        refuse(response, 400, 'bad_reach')
        return
      }
    }
    const out = v2.accounts.putDesktop(account.username, deviceId, {
      name: body.value.name,
      workspaces: body.value.workspaces,
      ...(reach === undefined ? {} : { reach })
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
