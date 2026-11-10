import { readJsonBody } from './http'
import { asking, v2Json, type Signed, type V2Context } from './v2-http'
import { relyingParty, spendChallenge } from './v2-factor-http'
import { verifyAssertion } from './v2-passkeys'
import { type VerifiedBy } from './v2-session-age'
import { freshFor } from './v2-step-up'
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
 * Every pass takes a proof made at that moment: a password typed or a
 * passkey touched — never a recent verification alone. Three wrong proofs rest the account's
 * grants for a minute, like the remote unlock.
 */

export const GRANT_TRIES = 3
export const GRANT_REST_MS = 60_000
const BODY_MAX = 16 * 1024

const SAID = {
  needsPassword:
    'Set an account password first: this account signs in with a provider and has no password or passkey to enter a machine with.',
  locked: 'This account is locked down after “Not me”. Change the password at auth.cookrew.dev/account first.',
  resting: 'Too many wrong tries. Try again in a minute.',
  wrongPassword: 'That is not the account password.',
  wrongPasskey: 'That passkey did not answer for this account.',
  proof: 'Prove it is you: the account password or a passkey.',
  badDevice: 'This device’s key cannot be named. Sign in again on this browser.',
  passwordElsewhere: 'The account password is typed at auth.cookrew.dev, never on this page. Use a passkey here, or go there to type it.'
} as const

type Rest = { wrong: number; until: number }
const rests = new Map<string, Rest>()

/**
 * Counted per account AND device: a stolen session guessing on its own device
 * must not lock the owner's phone out, and each device needs a full two-step
 * sign-in of its own to guess at all.
 */
/** Tries are counted for an account on a device, wherever the password was typed. */
const restKeyOf = (username: string, deviceId: string): string => `${username}|${deviceId}`
const restKey = (signed: Signed): string => restKeyOf(signed.account.username, signed.device.id)
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
    // The console's page never takes the password itself (issueGrant): it sends the person to the auth host.
    ...(signed.claims.via === 'console' ? { passwordAt: 'auth' } : {}),
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

/**
 * A PROOF MADE NOW: a passkey verified by a person, or the account password.
 * The answer, or null when it has refused (and said so). One copy, for every
 * pass that takes one: a security boundary written twice drifts.
 */
async function provenNow(ctx: V2Context, signed: Signed, value: Record<string, unknown>, key: string, now: number): Promise<VerifiedBy | null> {
  const { account } = signed
  if (value.credential !== undefined) {
    if (!passkeyProof(ctx, signed, value.credential)) {
      const left = missed(key, now)
      if (left === 0) said(ctx, 429, 'resting', SAID.resting, { retryAfterMs: GRANT_REST_MS })
      else said(ctx, 401, 'wrong', SAID.wrongPasskey, { triesLeft: left })
      return null
    }
    rests.delete(key)
    return 'passkey'
  }
  if (typeof value.password === 'string' && value.password !== '') {
    const tried = await tryGrantPassword(ctx, account.username, signed.device.id, value.password)
    if (!tried.ok) {
      if (tried.resting) said(ctx, 429, 'resting', SAID.resting, { retryAfterMs: tried.retryAfterMs })
      else said(ctx, 401, 'wrong', SAID.wrongPassword, { triesLeft: tried.triesLeft })
      return null
    }
    return 'password'
  }
  // ALWAYS A PROOF MADE NOW. A session that verified a minute ago is not
  // asked again elsewhere, but a pass for every machine is: every relayed
  // machine page shares this origin, and one of them must not be able to
  // take a pass without the person touching a passkey or typing (review, 11-09).
  said(ctx, 401, 'proof_required', SAID.proof)
  return null
}

export type PasswordTry =
  | { readonly ok: true }
  | { readonly ok: false; readonly resting: true; readonly retryAfterMs: number }
  | { readonly ok: false; readonly resting: false; readonly triesLeft: number }

/**
 * ONE TRY AT THE ACCOUNT PASSWORD FOR A DEVICE PASS, under the one rule: three
 * wrong for an account on a device, then a minute's rest, wherever the
 * password was typed (here, or on the auth origin for the console:
 * auth-grant.ts). A try while resting is not looked at.
 */
export async function tryGrantPassword(ctx: Pick<V2Context, 'v2'>, username: string, deviceId: string, password: string): Promise<PasswordTry> {
  const now = ctx.v2.now()
  const key = restKeyOf(username, deviceId)
  const rest = restingFor(key, now)
  if (rest > 0) return { ok: false, resting: true, retryAfterMs: rest }
  const account = ctx.v2.accounts.get(username)
  const right = account !== null && account.passwordless !== true && (await ctx.v2.accounts.verifyPassword(username, password))
  if (right) {
    rests.delete(key)
    return { ok: true }
  }
  const left = missed(key, now)
  return left === 0 ? { ok: false, resting: true, retryAfterMs: GRANT_REST_MS } : { ok: false, resting: false, triesLeft: left }
}

export async function issueGrant(ctx: V2Context, signed: Signed): Promise<void> {
  const { account, claims, device } = signed
  const now = ctx.v2.now()
  const body = await readJsonBody(ctx.request, BODY_MAX)
  const value: Record<string, unknown> = body.ok ? body.value : {}
  if (ctx.v2.factors.store.mustChangePassword(account.username)) return said(ctx, 403, 'locked', SAID.locked)
  // THE CONSOLE'S PAGE NEVER HANDLES THE PASSWORD (owner 2026-11-10): it is the
  // page that draws what machines send and keeps its tokens where a script
  // could read them, so a password typed there is one an injected script takes
  // for good. Refused before it is looked at: right or wrong, it costs no try
  // and opens nothing. A passkey is touched in place; the password is typed on
  // the auth host and comes back as a code (auth-grant.ts).
  if (claims.via === 'console' && value.password !== undefined) return said(ctx, 403, 'password_elsewhere', SAID.passwordElsewhere)
  const passkeys = passkeysOf(ctx, account.username)
  if (account.passwordless === true && passkeys.length === 0) return said(ctx, 409, 'password_required', SAID.needsPassword)
  const key = restKey(signed)
  const rest = restingFor(key, now)
  if (rest > 0) return said(ctx, 429, 'resting', SAID.resting, { retryAfterMs: rest })
  const jkt = jwkThumbprint(device.jwk)
  if (jkt === null) return said(ctx, 400, 'bad_device', SAID.badDevice)

  const by = await provenNow(ctx, signed, value, key, now)
  if (by === null) return
  ctx.v2.accounts.markVerified(account.username, claims.jti, by)
  const sitting = ctx.v2.accounts.session(account.username, claims.jti)?.sitting ?? claims.jti
  const minted = ctx.v2.tokens.mintGrant(account.username, device.id, jkt, sitting)
  ctx.response.setHeader('cache-control', 'private, no-store')
  v2Json(ctx.response, 201, { grant: minted.token, exp: minted.exp, deviceId: device.id })
}

/**
 * POST /v2/me/device-grant/watch — A WATCH PAIRS ONCE (owner, 2026-11-09).
 *
 * The exception to "every pass takes a proof made now", for one kind of device:
 * a watch has no passkey and no keyboard for a password. Its proof was made
 * once, when it joined the account with a code a machine minted only after the
 * account's step-up (v2-join.ts); from then on it is handed a pass whenever it
 * asks, for its own key, and enters every machine of the account, those added
 * later included. Removing the watch in Devices ends it: a revoked device has
 * no session to ask with, and each machine drops the watch's token when the
 * revoked list names it (watch-pairing.ts · revoked). "Not me" stops new passes
 * and the watch's sessions; to end its tokens on the machines, remove it. The pass is a WATCH pass (its own scope), which a machine turns into a
 * watch's token — agents and pages, never a shell — and which a machine older
 * than it does not read at all.
 */
export function issueWatchGrant(ctx: V2Context, signed: Signed): void {
  const { account, claims, device } = signed
  if (device.kind !== 'watch') {
    return said(ctx, 403, 'not_watch', 'Only a watch is let into every machine on its pairing alone. Prove it is you instead.')
  }
  if (ctx.v2.factors.store.mustChangePassword(account.username)) return said(ctx, 403, 'locked', SAID.locked)
  // As the proved pass is limited: a watch asks a few times a visit, not a stream.
  if (!ctx.v2.factors.options.take(`watch-grant|${device.id}`)) return said(ctx, 429, 'rate_limited', SAID.resting)
  const jkt = jwkThumbprint(device.jwk)
  if (jkt === null) return said(ctx, 400, 'bad_device', SAID.badDevice)
  const sitting = ctx.v2.accounts.session(account.username, claims.jti)?.sitting ?? claims.jti
  const minted = ctx.v2.tokens.mintWatchGrant(account.username, device.id, jkt, sitting)
  ctx.response.setHeader('cache-control', 'private, no-store')
  v2Json(ctx.response, 201, { grant: minted.token, exp: minted.exp, deviceId: device.id })
}

/**
 * POST /v2/me/device-grant/machine — THE ACCOUNT'S MACHINES TRUST EACH OTHER
 * (owner, 2026-11-09: full control). A desktop enters every other machine of
 * the account as a device of it, the way a paired phone does.
 *
 * TRUSTED ONCE, BY A PROOF MADE ON IT. "Desktop" is what a device says it is,
 * so it is not what earns this: the FIRST pass takes the account password or a
 * passkey from that machine, and marks the device a trusted machine; every pass
 * after needs none. A device attached by a join code, a recovery code or a
 * provider sign-in is a machine only once it has made that proof (security
 * review 2026-11-09). A machine
 * pass is its own scope: a machine older than it reads no pass at all.
 * Revoking the machine at cookrew.dev ends its admission everywhere (the
 * machines read the revoked list); "Not me" stops new passes.
 */
export async function issueMachineGrant(ctx: V2Context, signed: Signed): Promise<void> {
  const { account, claims, device } = signed
  if (device.kind !== 'desktop') {
    return said(ctx, 403, 'not_machine', 'Only a machine of the account enters the others on its sign-in alone. Prove it is you instead.')
  }
  if (ctx.v2.factors.store.mustChangePassword(account.username)) return said(ctx, 403, 'locked', SAID.locked)
  if (!ctx.v2.factors.options.take(`machine-grant|${device.id}`)) return said(ctx, 429, 'rate_limited', SAID.resting)
  const jkt = jwkThumbprint(device.jwk)
  if (jkt === null) return said(ctx, 400, 'bad_device', SAID.badDevice)
  if (device.machine !== true) {
    const now = ctx.v2.now()
    const key = restKey(signed)
    const rest = restingFor(key, now)
    if (rest > 0) return said(ctx, 429, 'resting', SAID.resting, { retryAfterMs: rest })
    const body = await readJsonBody(ctx.request, BODY_MAX)
    // The password or a passkey, made now; a provider's trip alone is not enough (security
    // review 2026-11-10): a machine signed in again with its second step is trusted at that sign-in.
    const by = await provenNow(ctx, signed, body.ok ? body.value : {}, key, now)
    if (by === null) return
    ctx.v2.accounts.markVerified(account.username, claims.jti, by)
    ctx.v2.accounts.trustMachine(account.username, device.id)
  }
  const sitting = ctx.v2.accounts.session(account.username, claims.jti)?.sitting ?? claims.jti
  const minted = ctx.v2.tokens.mintMachineGrant(account.username, device.id, jkt, sitting)
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
  /**
   * An account that holds a passkey proves it with the passkey: a provider
   * round trip is the weaker key, and a password set on it alone would open
   * the device pass with the provider alone (review, 11-09). Without one, any
   * verification in the window, or a provider round trip, will do. `freshFor`
   * is the same question cookrew.dev/me asks before it shows the fields.
   */
  const hasPasskey = ctx.v2.factors.store.hasPasskey(account.username)
  const proved =
    freshFor(ctx.v2, signed, 'change-password') ||
    (!hasPasskey && ctx.v2.factors.pending.spendAuthorised(account.username, 'change-password', body.stepUp, claims.jti))
  if (!proved) {
    said(
      ctx,
      403,
      'step_up',
      hasPasskey
        ? 'Prove it is you with your passkey first, then set the password within five minutes. On cookrew.dev, Set takes you through it.'
        : 'Prove it is you first — with your provider or your authenticator — then set the password within five minutes. On cookrew.dev, Set takes you through it.'
    )
    return
  }
  const out = await ctx.v2.accounts.setFirstPassword(account.username, body.next)
  if (!out.ok) {
    said(ctx, 400, out.reason, out.reason === 'weak_password' ? 'Too easy to guess. Use 12 characters or more; a sentence works.' : 'This account already has a password.')
    return
  }
  // Choosing a password proves nothing: the window stays as the proof left it.
  ctx.response.writeHead(204).end()
}
