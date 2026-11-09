import { readJsonBody } from './http'
import { asking, completeSignIn, deviceShape, json, refuse, refuseFactor, relyingParty, spendChallenge } from './v2-factor-http'
import { factorSentence } from './v2-factor-copy'
import { addRefusal, creationOptions } from './v2-enrol-routes'
import { parseRegistration } from './v2-passkeys'
import type { Pending } from './v2-pending'
import { qrRows } from './v2-qr'
import type { V2Context, V2Identity } from './v2-routes'
import type { ProviderId } from '../../src/shared/oauth'

/**
 * GATE 1: NO SESSION WITHOUT A SECOND STEP (owner, auth UX 2026-11-09).
 *
 * A password or a provider is the first step only. An account that holds a
 * passkey or an authenticator climbs the ladder for the second; an account
 * that holds neither SETS ONE UP before any session is issued, in the same
 * sign-in: a pending that allows exactly this, passkey first, authenticator
 * second, then fresh recovery codes handed back once, then the session.
 *
 * WHERE IT MAY BE SET UP, and why it is narrower than the ruling's words. The
 * set-up is the moment somebody holding only the first factor chooses the
 * second, so a stranger with a phished password would choose their own. That
 * used to need an approval from a device already on the account; approval is
 * no longer a second step, so the set-up runs only on a device the account
 * already holds (the owner's own laptop coming back), on a brand-new account,
 * or on an account with no device left. Anywhere else the answer names the
 * place it can be done: Security on cookrew.dev/me, on a signed-in device.
 *
 * Routes, on the pending (the id is what the first step handed back):
 *   POST /v2/sessions/:id/setup/passkey/options   creation options
 *   POST /v2/sessions/:id/setup/passkey           {name, credential}
 *   POST /v2/sessions/:id/setup/totp              → {secret, otpauth, qr}
 *   POST /v2/sessions/:id/setup/totp/confirm      {code}
 *   (each success answers {codes}: shown once, here)
 *   POST /v2/sessions/:id/setup/finish            {saved: true} → the session
 */

/** Does this account hold a second step? Recovery codes are a rescue, not one. */
export function hasSecondStep(v2: V2Identity, username: string): boolean {
  return v2.factors.store.hasPasskey(username) || v2.factors.store.totpActive(username)
}

const SMALL_BODY = 16 * 1024
const ATTESTATION_BODY = 64 * 1024

/**
 * Open a set-up and say so. Answered 403 with the sentence an old app shows as
 * it is (it has no screen for this), and with the pending a current page uses.
 */
export function openSetup(
  ctx: V2Context,
  username: string,
  rawDevice: unknown,
  via?: { provider: ProviderId; subject: string }
): void {
  const device = deviceShape(rawDevice)
  const pending = ctx.v2.factors.pending.open({
    username,
    device: rawDevice,
    deviceName: device?.name ?? username,
    kind: device?.kind ?? 'browser',
    address: asking(ctx),
    next: [],
    setup: true,
    ...(via === undefined ? {} : { via }),
    ...(ctx.auth === undefined ? {} : { authRequest: ctx.auth.request.id })
  })
  json(ctx.response, 403, {
    error: 'second_step_setup',
    message: factorSentence('second_step_setup'),
    pending: pending.id,
    setup: ['passkey', 'totp'],
    expiresAt: pending.expiresAt
  })
}

/** How long an account made on the direct path may finish its set-up from another device. */
export const UNFINISHED_MS = 72 * 60 * 60 * 1000

/** The set-up runs only where a stranger holding the first step could not choose the second. */
export function maySetUpHere(v2: V2Identity, username: string, deviceId: string): boolean {
  const account = v2.accounts.get(username)
  if (account === null) return false
  const unfinished = typeof account.setupPending === 'number' && account.setupPending > v2.now() && !hasSecondStep(v2, username)
  return account.devices.length === 0 || unfinished || account.devices.some((d) => d.id === deviceId)
}

/** The setup pending this request names, having spent one try. Null = answered. */
function setupOn(ctx: V2Context, id: string): Pending | null {
  const held = ctx.v2.factors.pending.get(id)
  if (held === null || held.setup === undefined) {
    refuseFactor(ctx.response, held === null ? 410 : 400, held === null ? 'expired' : 'not_offered')
    return null
  }
  const tried = ctx.v2.factors.pending.attempt(id)
  if (!tried.ok) {
    refuseFactor(ctx.response, 410, tried.reason)
    return null
  }
  if (ctx.v2.factors.store.mustChangePassword(held.username)) {
    ctx.v2.factors.pending.close(id)
    refuseFactor(ctx.response, 403, 'password_change_required')
    return null
  }
  // A SET-UP THAT ANOTHER ONE BEAT IS OVER. Once the account holds a second
  // step that this pending did not add, nothing more may be enrolled through
  // it: otherwise a set-up opened in the window by someone else finishes after
  // the owner's (review, 11-09).
  if (hasSecondStep(ctx.v2, held.username) && tried.pending.setup?.by === undefined) {
    ctx.v2.factors.pending.close(id)
    refuseFactor(ctx.response, 410, 'expired')
    return null
  }
  return tried.pending
}

/** A factor is in: hand the fresh recovery codes back, once. */
function setUp(ctx: V2Context, id: string, by: 'passkey' | 'totp'): void {
  const pending = ctx.v2.factors.pending.setUp(id, by)
  if (pending === null) {
    refuseFactor(ctx.response, 410, 'expired')
    return
  }
  // A second step exists now: an unfinished account is finished, and every
  // other set-up open for it ends here.
  ctx.v2.accounts.amend(pending.username, (a) => (a.setupPending === undefined ? a : { ...a, setupPending: undefined }))
  ctx.v2.factors.pending.closeAllFor(pending.username, id)
  // Shown here and nowhere else: they are stored hashed from this moment.
  const codes = ctx.v2.accounts.mintRecoveryCodes(pending.username)
  ctx.v2.factors.pending.codesShown(id)
  json(ctx.response, 201, { setUp: by, codes })
}

function passkeyOptions(ctx: V2Context, id: string): void {
  const pending = setupOn(ctx, id)
  if (pending === null) return
  const display = ctx.v2.accounts.get(pending.username)?.displayName ?? pending.username
  const options = creationOptions(ctx, pending.username, display, ctx.v2.factors.challenges.issue(`setup|${id}`))
  // The passkey is the second step from now on, so it must verify the person.
  json(ctx.response, 200, { ...options, authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' } })
}

async function addPasskey(ctx: V2Context, id: string): Promise<void> {
  const body = await readJsonBody(ctx.request, ATTESTATION_BODY)
  if (!body.ok) {
    refuse(ctx.response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const pending = setupOn(ctx, id)
  if (pending === null) return
  const credential = body.value.credential as { response?: { clientDataJSON?: unknown; attestationObject?: unknown } } | undefined
  const inner = credential?.response
  if (typeof inner !== 'object' || inner === null) {
    refuse(ctx.response, 400, 'malformed')
    return
  }
  const challenge = spendChallenge(ctx.v2.factors.challenges, `setup|${id}`, inner.clientDataJSON)
  if (challenge === null) {
    refuseFactor(ctx.response, 401, 'passkey_refused')
    return
  }
  const { origin, rpId } = relyingParty(ctx)
  const read = parseRegistration({ clientDataJSON: inner.clientDataJSON, attestationObject: inner.attestationObject }, { challenge, origin, rpId })
  if (!read.ok) {
    refuseFactor(ctx.response, 400, 'passkey_refused')
    return
  }
  const added = ctx.v2.factors.store.addPasskey(pending.username, {
    credentialId: read.credentialId,
    jwk: read.jwk,
    name: typeof body.value.name === 'string' && body.value.name.trim() !== '' ? body.value.name : pending.deviceName,
    signCount: read.signCount
  })
  if (!added.ok) {
    refuseFactor(ctx.response, added.reason === 'bad_name' ? 400 : 409, addRefusal(added.reason))
    return
  }
  ctx.v2.auth?.log('passkey enrolment: added at=setup')
  setUp(ctx, id, 'passkey')
}

function beginTotp(ctx: V2Context, id: string): void {
  const pending = setupOn(ctx, id)
  if (pending === null) return
  if (ctx.v2.factors.store.totpActive(pending.username)) {
    refuseFactor(ctx.response, 409, 'totp_active')
    return
  }
  const started = ctx.v2.factors.store.beginTotp(pending.username)
  json(ctx.response, 201, { ...started, qr: qrRows(started.otpauth) })
}

async function confirmTotp(ctx: V2Context, id: string): Promise<void> {
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(ctx.response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const pending = setupOn(ctx, id)
  if (pending === null) return
  if (ctx.v2.factors.store.get(pending.username).totp === null) {
    refuseFactor(ctx.response, 400, 'totp_not_started')
    return
  }
  if (!ctx.v2.factors.store.confirmTotp(pending.username, body.value.code)) {
    refuseFactor(ctx.response, 401, 'bad_code')
    return
  }
  setUp(ctx, id, 'totp')
}

async function finish(ctx: V2Context, id: string): Promise<void> {
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(ctx.response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const pending = ctx.v2.factors.pending.get(id)
  if (pending === null || pending.setup === undefined) {
    refuseFactor(ctx.response, 410, 'expired')
    return
  }
  const by = pending.setup.by
  // Saved means saved: the page asks the person to say so, and so does this.
  if (by === undefined || pending.setup.codes !== true || body.value.saved !== true) {
    refuseFactor(ctx.response, 400, 'setup_unfinished')
    return
  }
  if (completeSignIn(ctx, pending.username, pending.device, by)) ctx.v2.factors.pending.close(id)
}

/** The set-up routes, under /v2/sessions/:id/setup. Answers false for anything else. */
export function handleSetupRoute(ctx: V2Context, id: string, rest: readonly string[]): boolean {
  const { method } = ctx
  if (rest[0] !== 'setup' || method !== 'POST') return false
  const path = rest.slice(1).join('/')
  if (path === 'passkey/options') passkeyOptions(ctx, id)
  else if (path === 'passkey') void addPasskey(ctx, id)
  else if (path === 'totp') beginTotp(ctx, id)
  else if (path === 'totp/confirm') void confirmTotp(ctx, id)
  else if (path === 'finish') void finish(ctx, id)
  else return false
  return true
}

/**
 * A NEW ACCOUNT, made just now: it sets up its second step before its first
 * session, like any other. The account and its device exist; the session waits.
 */
export function setupForNewAccount(ctx: V2Context, username: string, rawDevice: unknown, via?: { provider: ProviderId; subject: string }): void {
  // ONLY ON THE DIRECT PATH, AND FOR A WHILE: the app that made the account
  // there may be one that cannot set up (0.5.x), so the set-up may finish on
  // the auth page from another device — for three days, and never once a
  // second step exists (see V2Account.setupPending). A sign-up on the auth
  // page or at a provider finishes where it started and needs none of it.
  if (ctx.auth === undefined) {
    const until = ctx.v2.now() + UNFINISHED_MS
    ctx.v2.accounts.amend(username, (a) => ({ ...a, setupPending: until }))
  }
  openSetup(ctx, username, rawDevice, via)
}
