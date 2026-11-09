import { readJsonBody } from './http'
import { asking, v2Json, type Signed, type V2Context } from './v2-http'
import { relyingParty, spendChallenge } from './v2-factor-http'
import { verifyAssertion } from './v2-passkeys'
import { freshlyVerified, type VerifiedBy } from './v2-session-age'
import { jwkThumbprint } from '../../src/shared/jwk-thumbprint'

/**
 * POST /v2/me/device-grant — ONE VERIFICATION, EVERY MACHINE OF THE ACCOUNT.
 *
 * Owner's ruling 2026-11-09 (docs/auth-ux-2026-11-09.html): entering a device
 * takes the account password or a passkey, and one verification lets this
 * phone or browser into every machine of the account for twelve hours. A grant
 * usable by every machine cannot be any one machine's challenge, so it is
 * issued HERE, after a proof made within the last five minutes, and it is
 * bound to the asking device's own key: a machine admits it only with a fresh
 * signature from that key over the machine's own challenge
 * (src/main/account-pair.ts), and only while the device is on the account
 * (the published revoked list).
 *
 * WHAT THIS ADDS TO THE TRUST IN cookrew.dev, said plainly: a machine believes
 * the registry's signature that this account verified this device key in the
 * last twelve hours. A registry that lied — or anyone holding its signing key —
 * could grant a key of its own and enter every machine of the account.
 *
 * WHAT STILL STOPS A STOLEN SESSION: the grant needs the password or a
 * passkey (not a session alone), it is minted only for the key of the device
 * the session belongs to, and a browser's key is non-extractable, so a cookie
 * lifted into another browser can neither obtain a grant for itself nor sign
 * a machine's challenge with the victim's key.
 *
 *   POST /v2/me/device-grant/options  → { methods, passkey | null, needsPassword }
 *   POST /v2/me/device-grant          { password } | { credential } | {}
 *                                     → 201 { grant, exp, deviceId }
 *
 * `{}` is accepted only when this sitting verified with the password or a
 * passkey within the last five minutes. Three wrong proofs rest the account's
 * grants for a minute, like the remote unlock.
 */

export const GRANT_TRIES = 3
export const GRANT_REST_MS = 60_000
const BODY_MAX = 16 * 1024

const SAID = {
  needsPassword:
    'Set an account password first: this account signs in with a provider and has no password or passkey to enter a machine with.',
  locked: 'This account is locked down after “Not me”. Change the password at cookrew.dev/me first.',
  resting: 'Too many wrong tries. Try again in a minute.',
  wrongPassword: 'That is not the account password.',
  wrongPasskey: 'That passkey did not answer for this account.',
  proof: 'Prove it is you: the account password or a passkey.',
  badDevice: 'This device’s key cannot be named. Sign in again on this browser.'
} as const

type Rest = { wrong: number; until: number }
const rests = new Map<string, Rest>()

/**
 * Counted per account AND device: a stolen session guessing on its own device
 * must not lock the owner's phone out, and each device needs a full two-step
 * sign-in of its own to guess at all.
 */
const restKey = (signed: Signed): string => `${signed.account.username}|${signed.device.id}`
const restingFor = (key: string, now: number): number => Math.max(0, (rests.get(key)?.until ?? 0) - now)

function sweep(now: number): void {
  if (rests.size < 1024) return
  for (const [key, held] of rests) if (held.until < now && held.wrong === 0) rests.delete(key)
}

function missed(username: string, now: number): number {
  sweep(now)
  const held = rests.get(username) ?? { wrong: 0, until: 0 }
  const wrong = held.wrong + 1
  if (wrong >= GRANT_TRIES) {
    rests.set(username, { wrong: 0, until: now + GRANT_REST_MS })
    return 0
  }
  rests.set(username, { wrong, until: 0 })
  return GRANT_TRIES - wrong
}

const said = (ctx: V2Context, status: number, error: string, message: string, extra: Record<string, unknown> = {}): void =>
  v2Json(ctx.response, status, { error, message, ...extra })

const challengeKey = (signed: Signed): string => `grant|${signed.claims.jti}`

function passkeysOf(ctx: V2Context, username: string): { id: string; credentialId: string; jwk: Record<string, string>; signCount: number }[] {
  return ctx.v2.factors.store.passkeys(username).map((p) => ({ id: p.id, credentialId: p.credentialId, jwk: p.jwk, signCount: p.signCount }))
}

export function grantOptions(ctx: V2Context, signed: Signed): void {
  if (!ctx.v2.factors.options.take(`grant|${asking(ctx)}`)) {
    said(ctx, 429, 'rate_limited', SAID.resting)
    return
  }
  const { username } = signed.account
  const passkeys = passkeysOf(ctx, username)
  const password = signed.account.passwordless !== true
  const { rpId } = relyingParty(ctx)
  v2Json(ctx.response, 200, {
    methods: { password, passkey: passkeys.length > 0 },
    needsPassword: !password && passkeys.length === 0,
    passkey:
      passkeys.length === 0
        ? null
        : {
            challenge: ctx.v2.factors.challenges.issue(challengeKey(signed)),
            rpId,
            timeout: 120_000,
            userVerification: 'required',
            allowCredentials: passkeys.map((p) => ({ type: 'public-key', id: p.credentialId }))
          }
  })
}

/** The passkey answered, for this sitting's challenge, with a person verified. */
function passkeyProof(ctx: V2Context, signed: Signed, credential: unknown): boolean {
  if (typeof credential !== 'object' || credential === null) return false
  const held = credential as { id?: unknown; response?: Record<string, unknown> }
  const response = held.response ?? {}
  const passkey = passkeysOf(ctx, signed.account.username).find((p) => p.credentialId === held.id)
  const challenge = spendChallenge(ctx.v2.factors.challenges, challengeKey(signed), response.clientDataJSON)
  if (passkey === undefined || challenge === null) return false
  const { origin, rpId } = relyingParty(ctx)
  const out = verifyAssertion(
    { clientDataJSON: response.clientDataJSON, authenticatorData: response.authenticatorData, signature: response.signature },
    passkey,
    { challenge, origin, rpId, requireUserVerification: true }
  )
  if (out.ok) ctx.v2.factors.store.noteSignCount(signed.account.username, passkey.id, out.signCount)
  return out.ok
}

export async function issueGrant(ctx: V2Context, signed: Signed): Promise<void> {
  const { account, claims, device } = signed
  const now = ctx.v2.now()
  const body = await readJsonBody(ctx.request, BODY_MAX)
  const value: Record<string, unknown> = body.ok ? body.value : {}
  if (ctx.v2.factors.store.mustChangePassword(account.username)) return said(ctx, 403, 'locked', SAID.locked)
  const passkeys = passkeysOf(ctx, account.username)
  if (account.passwordless === true && passkeys.length === 0) return said(ctx, 409, 'password_required', SAID.needsPassword)
  const key = restKey(signed)
  const rest = restingFor(key, now)
  if (rest > 0) return said(ctx, 429, 'resting', SAID.resting, { retryAfterMs: rest })
  const jkt = jwkThumbprint(device.jwk)
  if (jkt === null) return said(ctx, 400, 'bad_device', SAID.badDevice)

  let by: VerifiedBy | null = null
  if (value.credential !== undefined) {
    if (!passkeyProof(ctx, signed, value.credential)) {
      const left = missed(key, now)
      return left === 0
        ? said(ctx, 429, 'resting', SAID.resting, { retryAfterMs: GRANT_REST_MS })
        : said(ctx, 401, 'wrong', SAID.wrongPasskey, { triesLeft: left })
    }
    by = 'passkey'
  } else if (typeof value.password === 'string' && value.password !== '') {
    const right = account.passwordless !== true && (await ctx.v2.accounts.verifyPassword(account.username, value.password))
    if (!right) {
      const left = missed(key, now)
      return left === 0
        ? said(ctx, 429, 'resting', SAID.resting, { retryAfterMs: GRANT_REST_MS })
        : said(ctx, 401, 'wrong', SAID.wrongPassword, { triesLeft: left })
    }
    by = 'password'
  } else if (!freshlyVerified(ctx.v2.accounts.session(account.username, claims.jti), ctx.v2.now(), ['password', 'passkey'], ctx.v2.freshWindowMs)) {
    return said(ctx, 401, 'proof_required', SAID.proof)
  }

  rests.delete(key)
  if (by !== null) ctx.v2.accounts.markVerified(account.username, claims.jti, by)
  const minted = ctx.v2.tokens.mintGrant(account.username, device.id, jkt)
  ctx.response.setHeader('cache-control', 'private, no-store')
  v2Json(ctx.response, 201, { grant: minted.token, exp: minted.exp, deviceId: device.id })
}

/** For tests: forget every rest. */
export const forgetGrantRests = (): void => rests.clear()

/**
 * A FIRST ACCOUNT PASSWORD (owner's ruling 3): a provider-only account sets one
 * before it enters a machine without a passkey. Setting it is a sensitive act,
 * so it needs a verification in the last five minutes — any sign-in step, a
 * passkey, or a provider round trip spent for `change-password`. Nobody else
 * held a password, so no other sitting ends.
 */
export async function setFirstPassword(ctx: V2Context, signed: Signed, body: Record<string, unknown>): Promise<void> {
  const { account, claims } = signed
  const session = ctx.v2.accounts.session(account.username, claims.jti)
  const proved =
    freshlyVerified(session, ctx.v2.now(), undefined, ctx.v2.freshWindowMs) ||
    ctx.v2.factors.pending.spendAuthorised(account.username, 'change-password', body.stepUp, claims.jti)
  if (!proved) {
    said(ctx, 403, 'step_up', 'Prove it is you first: sign in again, or confirm with your provider, then set the password within five minutes.')
    return
  }
  const out = await ctx.v2.accounts.setFirstPassword(account.username, body.next)
  if (!out.ok) {
    said(ctx, 400, out.reason, out.reason === 'weak_password' ? 'Too easy to guess. Use 12 characters or more; a sentence works.' : 'This account already has a password.')
    return
  }
  ctx.v2.accounts.markVerified(account.username, claims.jti, 'password')
  ctx.response.writeHead(204).end()
}
