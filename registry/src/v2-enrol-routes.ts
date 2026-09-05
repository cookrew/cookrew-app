import { readJsonBody } from './http'
import { json, noContent, refuse, refuseFactor, relyingParty, spendChallenge } from './v2-factor-http'
import { parseRegistration } from './v2-passkeys'
import type { Decision } from './v2-pending'
import { signedIn, type V2Context } from './v2-routes'

/**
 * IDENTITY v2, PHASE 4 — ADDING A FACTOR, AND ANSWERING FOR ONE.
 *
 * Everything under /v2/me that phase 4 owns: enrolling a passkey, setting up
 * an authenticator, and the approvals an account's own devices answer. It is
 * a separate file from the ladder because the ladder is what a STRANGER can
 * reach and this is what only a signed-in device can — two different threat
 * surfaces should not share a page of code.
 *
 * A PASSKEY IS A FACTOR, NOT A DEVICE. Adding one does not attach anything;
 * removing the last one is allowed, because the account still has a password
 * and the ladder simply gets shorter. The rule that cannot be broken is about
 * DEVICES — the last one of those cannot be revoked — and it lives with them.
 */

const SMALL_BODY = 16 * 1024
const ATTESTATION_BODY = 32 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Claimed before v2-routes' own `/v2/me`, and only for the paths phase 4 owns. */
export function handleMeFactorRoute(ctx: V2Context, rest: string[]): boolean {
  const { method } = ctx
  const owns =
    rest[0] === 'approvals' || rest[0] === 'totp' || rest[0] === 'passkeys' || rest[0] === 'factors'
  if (!owns) return false

  const signed = signedIn(ctx.request, ctx.v2)
  if (signed === null) {
    refuse(ctx.response, 401, 'unauthenticated')
    return true
  }
  const who = signed.account.username

  /**
   * WHAT THIS ACCOUNT HAS, for a Security screen that is not this website's.
   *
   * The app half renders the same posture on the desktop, and a route it can
   * read is better than the desktop guessing from a 401 it has not been sent
   * yet. Never a secret: a passkey's name and when it arrived, and whether an
   * authenticator is active — not its seed.
   */
  if (rest.length === 1 && rest[0] === 'factors' && method === 'GET') {
    json(ctx.response, 200, ctx.v2.factors.store.summary(who))
    return true
  }
  if (rest.length === 1 && rest[0] === 'approvals' && method === 'GET') {
    listApprovals(ctx, who)
    return true
  }
  if (rest.length === 2 && rest[0] === 'approvals' && method === 'POST') {
    void answerApproval(ctx, who, (ctx.decode(rest[1]) ?? '').toLowerCase(), signed.claims.jti)
    return true
  }
  if (rest.length === 2 && rest[0] === 'totp' && rest[1] === 'enrol' && method === 'POST') {
    beginTotp(ctx, who)
    return true
  }
  if (rest.length === 2 && rest[0] === 'totp' && rest[1] === 'confirm' && method === 'POST') {
    void confirmTotp(ctx, who)
    return true
  }
  if (rest.length === 1 && rest[0] === 'totp' && method === 'DELETE') {
    ctx.v2.factors.store.clearTotp(who)
    noContent(ctx.response)
    return true
  }
  if (rest.length === 2 && rest[0] === 'passkeys' && rest[1] === 'options' && method === 'POST') {
    passkeyOptions(ctx, who, signed.account.displayName)
    return true
  }
  if (rest.length === 1 && rest[0] === 'passkeys' && method === 'POST') {
    void addPasskey(ctx, who)
    return true
  }
  if (rest.length === 2 && rest[0] === 'passkeys' && method === 'DELETE') {
    const id = (ctx.decode(rest[1]) ?? '').toLowerCase()
    if (!UUID.test(id) || !ctx.v2.factors.store.removePasskey(who, id)) {
      refuse(ctx.response, 404, 'not_found')
      return true
    }
    noContent(ctx.response)
    return true
  }
  refuse(ctx.response, 404, 'not_found')
  return true
}

// ── approvals (D6) ────────────────────────────────────────────────────────

/**
 * WHAT THE AVATAR'S REQUEST BADGE POLLS. Every field the D6 prompt needs and
 * nothing that would help whoever is asking: the address is shown because the
 * owner should see where the request came from, and the pending id is not,
 * because holding it is what lets a device finish the sign-in.
 */
function listApprovals(ctx: V2Context, username: string): void {
  json(
    ctx.response,
    200,
    ctx.v2.factors.pending.approvalsFor(username).map((a) => ({
      id: a.id,
      deviceName: a.deviceName,
      kind: a.kind,
      address: a.address,
      at: a.at,
      expiresAt: a.expiresAt,
      sentence: a.sentence
    }))
  )
}

const DECISIONS: readonly Decision[] = ['approve', 'deny', 'not-me']

/**
 * APPROVE, DENY, OR NOT ME.
 *
 * Approve lets the waiting browser finish (it collects the session from its
 * own poll, so the token is never handed to the device that approved it).
 * Deny ends that one request. "Not me" is the alarm: the request is denied,
 * every other sitting on the account ends — the caller's own survives, since
 * signing yourself out of the device you just used reads as a failure — and
 * the password is locked out until it is changed.
 */
async function answerApproval(ctx: V2Context, username: string, id: string, keepJti: string): Promise<void> {
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(ctx.response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const decision = body.value.decision
  if (typeof decision !== 'string' || !DECISIONS.includes(decision as Decision)) {
    refuseFactor(ctx.response, 400, 'bad_decision')
    return
  }
  const answered = ctx.v2.factors.pending.decide(username, id, decision as Decision)
  if (answered === null) {
    refuseFactor(ctx.response, 404, 'no_approval')
    return
  }
  if (decision === 'not-me') {
    ctx.v2.accounts.endOtherSessions(username, keepJti)
    ctx.v2.factors.store.setMustChangePassword(username, true)
  }
  noContent(ctx.response)
}

// ── the authenticator ─────────────────────────────────────────────────────

/**
 * The secret, shown once, as base32 AND as an otpauth URL in text. No QR:
 * drawing one would cost a dependency the bundle refuses, and a string a
 * person can copy into their app works on every phone.
 */
function beginTotp(ctx: V2Context, username: string): void {
  if (ctx.v2.factors.store.totpActive(username)) {
    refuseFactor(ctx.response, 409, 'totp_active')
    return
  }
  const started = ctx.v2.factors.store.beginTotp(username)
  json(ctx.response, 201, started)
}

async function confirmTotp(ctx: V2Context, username: string): Promise<void> {
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(ctx.response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  if (ctx.v2.factors.store.get(username).totp === null) {
    refuseFactor(ctx.response, 400, 'totp_not_started')
    return
  }
  // A code proves the app holds the secret. Until one does, the factor is not
  // active and the ladder does not offer it.
  if (!ctx.v2.factors.store.confirmTotp(username, body.value.code)) {
    refuseFactor(ctx.response, 401, 'bad_code')
    return
  }
  noContent(ctx.response)
}

// ── passkeys ──────────────────────────────────────────────────────────────

function passkeyOptions(ctx: V2Context, username: string, displayName: string): void {
  const { rpId } = relyingParty(ctx)
  const known = ctx.v2.factors.store.passkeys(username)
  json(ctx.response, 200, {
    challenge: ctx.v2.factors.challenges.issue(`enrol|${username}`),
    rp: { id: rpId, name: 'Cookrew' },
    user: {
      id: ctx.v2.factors.store.userHandle(username),
      name: username,
      displayName: displayName.trim() === '' ? username : displayName.trim()
    },
    // ES256 first, Ed25519 second — the two this registry can verify.
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -8 }
    ],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    // Attestation is trusted on first use, so asking for one would be asking
    // for a certificate chain we have already decided not to read.
    attestation: 'none',
    timeout: 120_000,
    excludeCredentials: known.map((k) => ({ type: 'public-key', id: k.credentialId }))
  })
}

async function addPasskey(ctx: V2Context, username: string): Promise<void> {
  const body = await readJsonBody(ctx.request, ATTESTATION_BODY)
  if (!body.ok) {
    refuse(ctx.response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const credential = body.value.credential
  if (typeof credential !== 'object' || credential === null || Array.isArray(credential)) {
    refuse(ctx.response, 400, 'malformed')
    return
  }
  const inner = (credential as { response?: unknown }).response
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) {
    refuse(ctx.response, 400, 'malformed')
    return
  }
  const { clientDataJSON, attestationObject } = inner as Record<string, unknown>
  const challenge = spendChallenge(ctx.v2.factors.challenges, `enrol|${username}`, clientDataJSON)
  if (challenge === null) {
    refuseFactor(ctx.response, 401, 'passkey_refused')
    return
  }
  const { origin, rpId } = relyingParty(ctx)
  const read = parseRegistration({ clientDataJSON, attestationObject }, { challenge, origin, rpId })
  if (!read.ok) {
    refuseFactor(ctx.response, 400, 'passkey_refused')
    return
  }
  const added = ctx.v2.factors.store.addPasskey(username, {
    credentialId: read.credentialId,
    jwk: read.jwk,
    name: body.value.name,
    signCount: read.signCount
  })
  if (!added.ok) {
    refuseFactor(
      ctx.response,
      added.reason === 'bad_name' ? 400 : 409,
      added.reason === 'too_many' ? 'passkey_limit' : added.reason === 'already_known' ? 'passkey_known' : 'bad_name'
    )
    return
  }
  json(ctx.response, 201, { id: added.passkey.id, name: added.passkey.name, addedAt: added.passkey.addedAt })
}
