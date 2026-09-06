import { createHash } from 'node:crypto'
import { readJsonBody } from './http'
import { asking, cookie, overloaded, refuse, v2Json, type V2Context } from './v2-http'
import { sentenceFor } from './v2-copy'

/**
 * IDENTITY v2, PHASE 6 — TODAY'S HANDLES BECOME ACCOUNTS.
 *
 * Everything before this phase assumed an empty registry. It is not empty: a
 * handle in `credentials.json` is a person who is serving doors right now,
 * with a key on their Mac and no password anywhere. This file is the bridge
 * they cross, and the two rules it exists to keep are:
 *
 *   · THE NAME IS RESERVED. A handle with a key and no account is not free.
 *     A sheet that offered it as free would let a stranger take the name a
 *     live door is published under, which is the one irreversible mistake
 *     available in this migration.
 *   · THE KEY IS THE PROOF. The person who may set a password on @drej is
 *     whoever can sign the v1 ceremony for @drej — the same ceremony the old
 *     app and the site already perform. No new credential is invented for the
 *     crossing, because a second way to prove a handle is a second way to
 *     take one.
 *
 * v1 IS NOT TOUCHED. `/v1/identity/assert` keeps minting for a migrated
 * handle, `credentials.json` keeps the credential, and a desktop that has not
 * been updated keeps serving exactly as it did. That is what makes the deploy
 * order free: the registry can go first, the app can go first, and no door
 * goes down either way.
 */

/** Bodies: a username, a password, a device and one ceremony. */
const SMALL_BODY = 16 * 1024

/**
 * The half of the v1 identity service this file needs, named as a shape.
 *
 * A shape rather than the class so nothing here can reach for the rest of it:
 * migration reads a public key, verifies one assertion, and has no business
 * minting v1 tokens, enrolling credentials or listing who exists.
 */
export interface LegacyIdentity {
  known(credentialId: string): boolean
  jwkFor(credentialId: string): Record<string, unknown> | null
  assert(input: {
    credentialId: string
    clientDataJSON: string
    authenticatorData: string
    signature: string
  }): { ok: true; sub: string; token: string } | { ok: false; reason: string }
}

/** Trim and lowercase, and nothing else: a name is refused, never rewritten. */
const asName = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : ''

/**
 * Does a v1 credential hold this name while no account does?
 *
 * Both halves matter. Once the account exists the name is an ordinary taken
 * name — `taken`, not `legacy` — and the sentence a person reads has to change
 * with it, because "set a password on the key that holds it" is wrong advice
 * for a name that already has one.
 */
export function legacyHolds(ctx: V2Context, username: unknown): boolean {
  const name = asName(username)
  if (name === '' || ctx.legacy === undefined) return false
  return ctx.legacy.known(name) && !ctx.v2.accounts.has(name)
}

/**
 * The reserved-name refusal, answered — or false when the name is nobody's.
 *
 * Called by the claim route BEFORE anything is created, so a name held by a
 * key can never be minted as somebody else's account.
 */
export function refuseIfLegacy(ctx: V2Context, username: unknown): boolean {
  if (!legacyHolds(ctx, username)) return false
  refuse(ctx.response, 409, 'legacy', asName(username))
  return true
}

/**
 * THE ID OF A LEGACY KEY, derived exactly as every other device id is.
 *
 * RFC 7638 thumbprint, hashed again, sixteen bytes wearing UUID version 8 —
 * the same derivation `src/main/account-v2.ts deviceIdFor` and the browser's
 * `device-id.js` perform, and a test holds the three to the same answer. It
 * is computed here rather than sent because the key is ours: it comes off
 * credentials.json, and an id a request could choose would be an id a request
 * could collide with somebody else's device.
 */
export function legacyDeviceId(jwk: Record<string, unknown>): string | null {
  const canonical =
    jwk.kty === 'OKP'
      ? JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })
      : jwk.kty === 'EC'
        ? JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
        : null
  if (canonical === null) return null
  const thumbprint = createHash('sha256').update(canonical).digest()
  const bytes = Buffer.from(createHash('sha256').update(thumbprint).digest().subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-')
}

interface LegacyAssertion {
  credentialId: string
  clientDataJSON: string
  authenticatorData: string
  signature: string
}

/** The ceremony, as four base64url strings or nothing at all. */
function assertionOf(input: unknown): LegacyAssertion | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const raw = input as Record<string, unknown>
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : null
  const credentialId = text(raw.credentialId)
  const clientDataJSON = text(raw.clientDataJSON)
  const authenticatorData = text(raw.authenticatorData)
  const signature = text(raw.signature)
  if (credentialId === null || clientDataJSON === null || authenticatorData === null || signature === null) {
    return null
  }
  return { credentialId, clientDataJSON, authenticatorData, signature }
}

/** Answers true when it claimed the request. Mounted inside /v2's router. */
export function handleMigrateRoute(ctx: V2Context, rest: readonly string[]): boolean {
  if (rest[0] !== 'migrate') return false
  if (rest.length === 1 && ctx.method === 'POST') {
    void migrate(ctx)
    return true
  }
  /**
   * GET /v2/migrate/:username — IS THIS NAME WAITING FOR A PASSWORD?
   *
   * The sign-in sheet needs it: a legacy handle refuses a password with the
   * same 401 as a typo, and "that name and password do not go together" is
   * the wrong sentence for somebody whose name simply has no password yet.
   *
   * It publishes nothing new. `HEAD /v2/accounts/:h` already answers 200 for
   * these names while `GET` answers 404, so the fact is on the wire either
   * way; this says it in one call instead of two and in a sentence.
   */
  if (rest.length === 2 && (ctx.method === 'GET' || ctx.method === 'HEAD')) {
    if (!ctx.v2.limits.lookups.take(`look|${asking(ctx)}`)) {
      refuse(ctx.response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
      return true
    }
    const name = asName(ctx.decode(rest[1]) ?? '')
    if (!legacyHolds(ctx, name)) {
      refuse(ctx.response, 404, 'not_found')
      return true
    }
    v2Json(ctx.response, 200, { username: name, legacy: true, message: sentenceFor('legacy', name) })
    return true
  }
  refuse(ctx.response, 405, 'method_not_allowed')
  return true
}

/**
 * POST /v2/migrate — the crossing itself.
 *
 * The order is the security. The ceremony is verified BEFORE the password is
 * stretched, so a stranger cannot spend a scrypt on a name they cannot sign
 * for; and the account is created before the legacy key is filed, so a key
 * that cannot be filed costs a device row rather than the migration.
 */
async function migrate(ctx: V2Context): Promise<void> {
  const { response, v2 } = ctx
  const legacy = ctx.legacy
  if (legacy === undefined) {
    // A registry with no v1 identity service has nothing to migrate FROM.
    refuse(response, 404, 'not_found')
    return
  }
  if (overloaded(response)) return
  if (!v2.limits.accounts.take(`migrate|${asking(ctx)}`)) {
    refuse(response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
    return
  }
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const username = asName(body.value.username)
  // Already an account: this is an ordinary taken name and the person is
  // looking for the sign-in sheet, not this route.
  if (v2.accounts.has(username)) {
    refuse(response, 409, 'taken', username)
    return
  }
  const jwk = legacy.jwkFor(username)
  if (jwk === null) {
    refuse(response, 404, 'not_found')
    return
  }
  const assertion = assertionOf(body.value.assertion)
  if (assertion === null) {
    refuse(response, 400, 'malformed')
    return
  }
  const asserted = legacy.assert(assertion)
  // NAMED BOTH WAYS: the ceremony must verify AND it must be the ceremony of
  // the handle being migrated. Without the second check a person holding any
  // enrolled key could set a password on any other handle.
  if (!asserted.ok || asserted.sub !== username) {
    refuse(response, 401, 'bad_credentials')
    return
  }
  const out = await v2.accounts.create({
    username,
    password: body.value.password,
    device: body.value.device
  })
  if (!out.ok) {
    refuse(response, out.reason === 'taken' ? 409 : 400, out.reason, username)
    return
  }
  // The old key becomes a device of the account it used to BE. It is listed
  // and revocable like any other, which is how this migration ends: the day
  // the owner revokes it, the pre-password world is closed.
  const id = legacyDeviceId(jwk)
  if (id !== null) {
    v2.accounts.attachLegacyKey(out.account.username, { id, name: `@${username} key`, jwk })
  }
  const session = v2.accounts.startSession(out.account.username, out.device.id)
  if (session === null) {
    refuse(response, 500, 'malformed')
    return
  }
  const minted = v2.tokens.mintSession(out.account.username, out.device.id, session.jti)
  // The same 201 as a claim, because from here on this IS a claimed account
  // and every client already knows how to read that answer.
  v2Json(
    response,
    201,
    {
      username: out.account.username,
      deviceId: out.device.id,
      session: { token: minted.token, exp: minted.exp }
    },
    { 'set-cookie': cookie(minted.token) }
  )
}
