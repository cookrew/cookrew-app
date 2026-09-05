import { readJsonBody } from './http'
import type { V2Account } from './v2-accounts'
import {
  asking,
  completeSignIn,
  deviceShape,
  json,
  refuse,
  refuseFactor,
  relyingParty,
  spendChallenge
} from './v2-factor-http'
import { handleMeFactorRoute } from './v2-enrol-routes'
import { factorSentence } from './v2-factor-copy'
import { FACTOR_ORDER, type Factor, type Pending } from './v2-pending'
import { verifyAssertion } from './v2-passkeys'
import type { V2Context, V2Identity } from './v2-routes'

/**
 * IDENTITY v2, PHASE 4 — THE SIGN-IN LADDER.
 *
 * A password is the floor, not the door (P5). When an account has a passkey or
 * an authenticator, or when the device asking is one the account has never
 * seen while it already has others, the password buys ONE MORE STEP and
 * nothing else: a pending record that holds the name, the unattached device
 * and the single fact `passwordOk`, and a list of the ways this particular
 * account can finish.
 *
 *   passkey → authenticator → approve on a trusted device → recovery code
 *
 * in that order, recommended first and rescue last (owner's ruling), and
 * filtered to what the account actually has — a rung nobody can stand on is
 * worse than a shorter ladder.
 *
 * THE DEVICE IS NOT ATTACHED UNTIL A RUNG IS CLIMBED. Everything about this
 * file follows from that: `v2-pending.ts` holds the payload without acting on
 * it, and `completeSignIn` is the one place that attaches.
 *
 * Every route here is mounted from ONE line in v2-routes.ts, so phase 4 can
 * land beside phases 2 and 5 without three agents editing the same router.
 */

const SMALL_BODY = 16 * 1024
/** An assertion carries a signature and a client-data blob; a few KB, not more. */
const ASSERTION_BODY = 32 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * WHAT THIS ACCOUNT CAN FINISH WITH, in the ladder's order.
 *
 * `approve` is offered whenever the account has any attached device, because
 * the request appears on all of them; `recovery` only when codes were minted,
 * since an empty rescue is a dead end dressed as a way in.
 */
export function factorsFor(v2: V2Identity, account: V2Account): Factor[] {
  const has: Record<Factor, boolean> = {
    passkey: v2.factors.store.hasPasskey(account.username),
    totp: v2.factors.store.totpActive(account.username),
    approve: account.devices.length > 0,
    recovery: account.recovery.length > 0
  }
  return FACTOR_ORDER.filter((factor) => has[factor])
}

/**
 * Is a password enough on its own? Only for an account with no factors being
 * opened on a device it already knows — or on its very first device, which is
 * the account that has just been claimed.
 *
 * DERIVED FROM `factorsFor` AND NOTHING ELSE. It was a second predicate that
 * happened to agree with the first, which is a ladder that disappears the day
 * somebody adds a factor kind to one list and not the other.
 */
function ladderApplies(next: readonly Factor[], account: V2Account, deviceId: string): boolean {
  const hasFactor = next.includes('passkey') || next.includes('totp')
  const known = account.devices.some((d) => d.id === deviceId)
  return hasFactor || (!known && account.devices.length > 0)
}

/**
 * POST /v2/sessions — the password step, and the fork.
 *
 * Called from v2-routes' `openSession` after its limiter, so the two phases
 * meet at exactly one line. The refusals and their sentences are the same as
 * before for the accounts that answer as before.
 */
export async function signInWithLadder(ctx: V2Context, body: Record<string, unknown>): Promise<void> {
  const { v2, response } = ctx
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
  // The store stretches against a decoy when the name is unknown, so an
  // account nobody has and a password that is wrong cost the same and answer
  // the same.
  const right = await v2.accounts.verifyPassword(username, typeof body.password === 'string' ? body.password : '')
  const account = v2.accounts.get(username)
  if (!right || account === null) {
    refuse(response, 401, 'bad_credentials')
    return
  }
  /**
   * "NOT ME" LOCKS THE PASSWORD OUT, not the person. Someone said a sign-in
   * was not theirs, so this password is treated as known to a stranger until
   * it changes — and a passkey, which the stranger does not have, still opens
   * the account (GET /v2/sessions/passkey/options).
   */
  if (v2.factors.store.mustChangePassword(account.username)) {
    refuseFactor(response, 403, 'password_change_required')
    return
  }
  const device = deviceShape(body.device)
  /**
   * THE WHOLE DEVICE, CHECKED HERE. `deviceShape` reads only what the ladder
   * needs; the account store is the authority on the rest (a usable key, an
   * id no other account holds, an id this account has not revoked). Asking it
   * now means a rung is never climbed — and a recovery code never burned —
   * for a device that could not have been attached at the end of it.
   */
  if (device === null || !v2.accounts.mayAttach(account.username, body.device)) {
    refuse(response, 400, 'bad_device')
    return
  }
  const next = factorsFor(v2, account)
  if (!ladderApplies(next, account, device.id)) {
    completeSignIn(ctx, account.username, body.device)
    return
  }
  if (next.length === 0) {
    // Cannot happen — the ladder applies only when there is a factor or a
    // device to approve from — and it FAILS CLOSED if it ever does. A
    // security ladder's default branch must not be "let them in".
    refuseFactor(response, 403, 'no_factor')
    return
  }
  const pending = v2.factors.pending.open({
    username: account.username,
    device: body.device,
    deviceName: device.name,
    kind: device.kind,
    address: asking(ctx),
    next
  })
  json(response, 401, {
    error: 'second_factor',
    message: factorSentence('second_factor'),
    next,
    pending: pending.id,
    expiresAt: pending.expiresAt
  })
}

// ── the router ────────────────────────────────────────────────────────────

/**
 * Phase 4's whole surface, claimed before v2-routes' own branches so that
 * `/v2/me/passkeys` is not swallowed by `/v2/me`. Answers false for anything
 * it does not own, which is how POST /v2/sessions still reaches its limiter.
 */
export function handleFactorRoute(ctx: V2Context): boolean {
  const { method, parts } = ctx
  const rest = parts.slice(1)
  if (rest[0] === 'me') return handleMeFactorRoute(ctx, rest.slice(1))
  if (rest[0] !== 'sessions') return false

  // Passwordless: the W1 sheet's first button, with no username typed.
  if (rest.length === 3 && rest[1] === 'passkey' && rest[2] === 'options' && method === 'GET') {
    discoveryOptions(ctx)
    return true
  }
  if (rest.length === 2 && rest[1] === 'passkey' && method === 'POST') {
    void passwordlessPasskey(ctx)
    return true
  }

  const id = (ctx.decode(rest[1] ?? '') ?? '').toLowerCase()
  if (!UUID.test(id)) return false
  if (rest.length === 2 && method === 'GET') {
    pollPending(ctx, id)
    return true
  }
  if (rest.length === 3 && method === 'POST' && rest[2] === 'totp') {
    void totpStep(ctx, id)
    return true
  }
  if (rest.length === 3 && method === 'POST' && rest[2] === 'recovery') {
    void recoveryStep(ctx, id)
    return true
  }
  if (rest.length === 3 && method === 'POST' && rest[2] === 'approve') {
    askForApproval(ctx, id)
    return true
  }
  if (rest.length === 4 && method === 'GET' && rest[2] === 'passkey' && rest[3] === 'options') {
    pendingPasskeyOptions(ctx, id)
    return true
  }
  if (rest.length === 3 && method === 'POST' && rest[2] === 'passkey') {
    void pendingPasskey(ctx, id)
    return true
  }
  return false
}

// ── one rung at a time ────────────────────────────────────────────────────

/**
 * The pending this request names, having spent one of its five tries.
 *
 * THE ALARM CLOSES EVERY DOOR, not just the one it was pressed on. A request
 * the account denied — or an account whose password was disowned — must not
 * remain climbable by the OTHER rungs: the whole point of "deny" and "not
 * me" is that the sign-in they answered does not happen.
 */
function attemptOn(ctx: V2Context, id: string, factor: Factor): Pending | null {
  const held = ctx.v2.factors.pending.get(id)
  if (held !== null && !held.next.includes(factor)) {
    // Checked before a try is spent: asking for a rung that was never offered
    // is a client bug, and it should not cost the person their budget.
    refuseFactor(ctx.response, 400, 'not_offered')
    return null
  }
  const tried = ctx.v2.factors.pending.attempt(id)
  if (!tried.ok) {
    // An id that was never real and one that went cold read the same — but a
    // BUDGET that has run out is a different thing to do about it, and saying
    // "this took too long" to somebody who has just typed five wrong codes
    // sends them looking for a clock problem they do not have.
    refuseFactor(ctx.response, 410, tried.reason)
    return null
  }
  const pending = tried.pending
  if (ctx.v2.factors.pending.refused(pending)) {
    ctx.v2.factors.pending.close(id)
    refuseFactor(ctx.response, 410, 'denied')
    return null
  }
  if (ctx.v2.factors.store.mustChangePassword(pending.username)) {
    ctx.v2.factors.pending.close(id)
    refuseFactor(ctx.response, 403, 'password_change_required')
    return null
  }
  return pending
}

async function totpStep(ctx: V2Context, id: string): Promise<void> {
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(ctx.response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const pending = attemptOn(ctx, id, 'totp')
  if (pending === null) return
  if (!ctx.v2.factors.store.checkTotp(pending.username, body.value.code)) {
    refuseFactor(ctx.response, 401, 'bad_code')
    return
  }
  if (completeSignIn(ctx, pending.username, pending.device)) ctx.v2.factors.pending.close(id)
}

async function recoveryStep(ctx: V2Context, id: string): Promise<void> {
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(ctx.response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const pending = attemptOn(ctx, id, 'recovery')
  if (pending === null) return
  // CONSUMED HERE, before the device is looked at: a code that was read out
  // is spent whether or not the rest of the request was well formed.
  if (!ctx.v2.accounts.useRecoveryCode(pending.username, body.value.code)) {
    refuseFactor(ctx.response, 401, 'bad_recovery')
    return
  }
  if (completeSignIn(ctx, pending.username, pending.device)) ctx.v2.factors.pending.close(id)
}

/** The options a browser needs to ask its authenticator for an assertion. */
function assertionOptions(
  ctx: V2Context,
  key: string,
  allow: readonly { id: string }[],
  verify: 'preferred' | 'required' = 'preferred'
): Record<string, unknown> {
  const { rpId } = relyingParty(ctx)
  return {
    challenge: ctx.v2.factors.challenges.issue(key),
    rpId,
    timeout: 120_000,
    // A rung behind a password asks; the passwordless button REQUIRES. There
    // the passkey is the whole answer, and a tap on a key somebody found is
    // not an answer.
    userVerification: verify,
    allowCredentials: allow.map((c) => ({ type: 'public-key', id: c.id }))
  }
}

function pendingPasskeyOptions(ctx: V2Context, id: string): void {
  if (!ctx.v2.factors.options.take(`ladder|${asking(ctx)}`)) {
    refuse(ctx.response, 429, 'rate_limited', { 'retry-after': '60' })
    return
  }
  const pending = ctx.v2.factors.pending.get(id)
  if (pending === null) {
    refuseFactor(ctx.response, 410, 'expired')
    return
  }
  if (!pending.next.includes('passkey')) {
    refuseFactor(ctx.response, 400, 'not_offered')
    return
  }
  const keys = ctx.v2.factors.store.passkeys(pending.username)
  json(ctx.response, 200, assertionOptions(ctx, `pending|${id}`, keys.map((k) => ({ id: k.credentialId }))))
}

interface Assertion {
  id: unknown
  response: { clientDataJSON: unknown; authenticatorData: unknown; signature: unknown; userHandle?: unknown }
}

/** The credential a body carries, or null — it is a stranger's JSON. */
function assertionOf(value: unknown): Assertion | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const held = value as { id?: unknown; rawId?: unknown; response?: unknown }
  const inner = held.response
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return null
  const parts = inner as Record<string, unknown>
  const id = typeof held.id === 'string' ? held.id : typeof held.rawId === 'string' ? held.rawId : null
  if (id === null) return null
  return {
    id,
    response: {
      clientDataJSON: parts.clientDataJSON,
      authenticatorData: parts.authenticatorData,
      signature: parts.signature,
      userHandle: parts.userHandle
    }
  }
}

async function pendingPasskey(ctx: V2Context, id: string): Promise<void> {
  const body = await readJsonBody(ctx.request, ASSERTION_BODY)
  if (!body.ok) {
    refuse(ctx.response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const pending = attemptOn(ctx, id, 'passkey')
  if (pending === null) return
  const credential = assertionOf(body.value.credential)
  if (credential === null) {
    refuse(ctx.response, 400, 'malformed')
    return
  }
  const found = ctx.v2.factors.store.byCredentialId(credential.id)
  // The key must be one of THIS account's: another account's perfectly good
  // passkey is not a way into this name.
  if (found === null || found.username !== pending.username) {
    refuseFactor(ctx.response, 401, 'passkey_refused')
    return
  }
  if (!checkAssertion(ctx, `pending|${id}`, credential, found)) return
  if (completeSignIn(ctx, pending.username, pending.device)) ctx.v2.factors.pending.close(id)
}

/**
 * The shared half of both passkey routes: spend the challenge, verify the
 * signature, move the counter. One refusal sentence for every way it can
 * fail, because a caller learning WHICH check refused learns how to pass it.
 */
function checkAssertion(
  ctx: V2Context,
  key: string,
  credential: Assertion,
  found: { username: string; passkey: { id: string; jwk: Record<string, string>; signCount: number } },
  requireUserVerification = false
): boolean {
  const challenge = spendChallenge(ctx.v2.factors.challenges, key, credential.response.clientDataJSON)
  if (challenge === null) {
    refuseFactor(ctx.response, 401, 'passkey_refused')
    return false
  }
  const { origin, rpId } = relyingParty(ctx)
  const out = verifyAssertion(
    {
      clientDataJSON: credential.response.clientDataJSON,
      authenticatorData: credential.response.authenticatorData,
      signature: credential.response.signature
    },
    found.passkey,
    { challenge, origin, rpId, requireUserVerification }
  )
  if (!out.ok) {
    refuseFactor(ctx.response, 401, 'passkey_refused')
    return false
  }
  ctx.v2.factors.store.noteSignCount(found.username, found.passkey.id, out.signCount)
  return true
}

// ── approve on a device the account already trusts ────────────────────────

function askForApproval(ctx: V2Context, id: string): void {
  if (!ctx.v2.factors.options.take(`ladder|${asking(ctx)}`)) {
    refuse(ctx.response, 429, 'rate_limited', { 'retry-after': '60' })
    return
  }
  const pending = ctx.v2.factors.pending.get(id)
  if (pending === null) {
    refuseFactor(ctx.response, 410, 'expired')
    return
  }
  if (!pending.next.includes('approve')) {
    refuseFactor(ctx.response, 400, 'not_offered')
    return
  }
  const approval = ctx.v2.factors.pending.ask(id)
  if (approval === null) {
    refuseFactor(ctx.response, 410, 'expired')
    return
  }
  json(ctx.response, 202, {
    approval: approval.id,
    expiresAt: approval.expiresAt,
    sentence: approval.sentence
  })
}

/**
 * THE WAITING SCREEN'S ONE QUESTION, asked every two seconds.
 *
 * Not counted against the five attempts: polling is not guessing. Approval
 * finishes the sign-in here rather than at the approving device, so the
 * session and its cookie are handed to the browser that is waiting for them
 * and to nothing else.
 */
function pollPending(ctx: V2Context, id: string): void {
  const pending = ctx.v2.factors.pending.get(id)
  if (pending === null) {
    refuseFactor(ctx.response, 410, 'expired')
    return
  }
  const approval = pending.approval
  if (approval === null || approval.decision === null) {
    json(ctx.response, 202, { status: 'waiting', expiresAt: pending.expiresAt })
    return
  }
  if (approval.decision !== 'approve') {
    ctx.v2.factors.pending.close(id)
    refuseFactor(ctx.response, 410, 'denied')
    return
  }
  if (completeSignIn(ctx, pending.username, pending.device)) ctx.v2.factors.pending.close(id)
}

// ── passwordless: the W1 sheet's first button ─────────────────────────────

/**
 * A CHALLENGE BOUND TO THIS ADDRESS, for two minutes, with no username asked.
 *
 * Discoverable credentials mean the authenticator knows which account it is
 * for; the page does not, and neither do we until the assertion arrives. So
 * there is nothing here to enumerate accounts with — the answer is the same
 * for every caller.
 */
function discoveryOptions(ctx: V2Context): void {
  if (!ctx.v2.factors.options.take(`passkey|${asking(ctx)}`)) {
    refuse(ctx.response, 429, 'rate_limited', { 'retry-after': '60' })
    return
  }
  json(ctx.response, 200, assertionOptions(ctx, `ip|${asking(ctx)}`, [], 'required'))
}

async function passwordlessPasskey(ctx: V2Context): Promise<void> {
  const body = await readJsonBody(ctx.request, ASSERTION_BODY)
  if (!body.ok) {
    refuse(ctx.response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  if (!ctx.v2.factors.options.take(`passkey|${asking(ctx)}`)) {
    refuse(ctx.response, 429, 'rate_limited', { 'retry-after': '60' })
    return
  }
  const credential = assertionOf(body.value.credential)
  if (credential === null || deviceShape(body.value.device) === null) {
    refuse(ctx.response, 400, credential === null ? 'malformed' : 'bad_device')
    return
  }
  const found = ctx.v2.factors.store.byCredentialId(credential.id)
  if (found === null) {
    refuseFactor(ctx.response, 401, 'passkey_refused')
    return
  }
  // The user handle is the authenticator's own account pointer. When it sends
  // one it must be the account the credential belongs to; a mismatch is a
  // credential being offered for somebody else's name.
  const handle = credential.response.userHandle
  if (typeof handle === 'string' && handle !== '' && handle !== ctx.v2.factors.store.userHandle(found.username)) {
    refuseFactor(ctx.response, 401, 'passkey_refused')
    return
  }
  if (!checkAssertion(ctx, `ip|${asking(ctx)}`, credential, found, true)) return
  completeSignIn(ctx, found.username, body.value.device)
}
