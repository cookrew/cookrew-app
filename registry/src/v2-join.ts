import { readJsonBody } from './http'
import { qrRows } from './v2-qr'
import { relyingParty } from './v2-factor-http'
import { asking, cookie, refuse, signedIn, v2Json, type V2Context } from './v2-http'
import { factorError } from './v2-factor-copy'
import { stepUpHeld } from './v2-step-up'

/** The same ceiling the other /v2/me writes read a body under. */
const SMALL_BODY = 16 * 1024

/**
 * THE TWO ROUTES OF JOINING BY CODE. The store they stand on is a leaf
 * module (v2-join-codes.ts) so that the assembly in v2-http can hold one
 * without importing a file that imports v2-http back.
 */

/**
 * POST /v2/me/join-codes — mint one, on a device that is already trusted.
 *
 * STEP-UP, because this is the act that adds a machine to the account: the
 * session alone is not enough for anything that widens what the account can be
 * opened from. Which proof is asked for is v2-step-up's to decide — the ladder
 * when the account holds something stronger than its password, the password
 * when it does not.
 */
async function mintJoinCode(ctx: V2Context, username: string): Promise<void> {
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(ctx.response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  // The step-up itself lives in one place (v2-step-up.ts) because this is one
  // of seven acts that need it, and seven copies of a security boundary drift.
  if (!(await stepUpHeld(ctx, username, 'mint-join-code', body.value))) return
  /**
   * SIX AN HOUR, PER ACCOUNT. A join code is a bearer that attaches a machine,
   * and a signed-in device that can mint them without a ceiling is a way to
   * keep a supply of them alive — one always fresh, one always unspent. Six is
   * more than a person adding machines and far less than a supply.
   */
  if (!ctx.v2.limits.joinCodes.take(`join-codes|${username}`)) {
    refuse(ctx.response, 429, 'rate_limited', undefined, { 'retry-after': '3600' })
    return
  }
  const minted = ctx.v2.joinCodes.mint(username)
  /**
   * THE CODE, THE LINK AND THE PICTURE — one answer, because they are one
   * secret in three shapes and a screen that shows all three fits every way a
   * person moves it: a phone camera, a message to another machine, or fingers.
   *
   * THE CODE IS IN THE FRAGMENT (`/join#CODE`). A fragment is never put on the
   * wire, so a scanned link does not hand the code to this registry's access
   * log, to any proxy in front of it, or to `document.referrer` on the page it
   * lands on — and the page that reads it is ours. The architecture names this
   * URL; it is built here so the QR and the link cannot disagree about it.
   *
   * The QR is rendered HERE for the same reason the authenticator's is
   * (v2-qr.ts): the CSP forbids an inline script and no encoder ships in the
   * browser bundle, so the matrix travels with the secret it encodes, on an
   * answer that is already private and never cached.
   */
  const url = `${relyingParty(ctx).origin}/join#${minted.code}`
  v2Json(ctx.response, 201, { code: minted.code, url, qr: qrRows(url), expiresAt: minted.expiresAt })
}

/**
 * POST /v2/join {code, device} — the new machine, with nothing typed on it
 * but the code.
 *
 * The shape of `redeemRecovery`: a one-shot secret, a device, and a session at
 * the end of it. No username on the wire, because the code names the account —
 * and a caller who has to guess the username as well as the code learns
 * nothing from either refusal, since both answer the same 401.
 */
async function redeemJoinCode(ctx: V2Context): Promise<void> {
  const { response, v2 } = ctx
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  /**
   * FIVE A MINUTE FROM ONE ADDRESS. Eight characters of this alphabet is forty
   * bits, so guessing is not the threat a limiter is here for — a flood is.
   * Keyed by address alone because there is no username on this route to key
   * by, and counted before the code is read so a wrong code and a malformed
   * one cost the same.
   */
  const who = asking(ctx)
  if (!v2.limits.join.take(`join|${who}`)) {
    refuse(response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
    return
  }
  const username = v2.joinCodes.redeem(body.value.code)
  if (username === null) {
    refuse(response, 401, 'bad_credentials')
    return
  }
  /**
   * "NOT ME" LOCKS THIS DOOR TOO, exactly as it locks the recovery route. A
   * code minted before the alarm was raised is a code the stranger may be
   * holding; the owner is not stranded, since they still hold the sitting they
   * pressed the alarm from and can mint another once the password has changed.
   */
  if (v2.factors.store.mustChangePassword(username)) {
    v2Json(response, 403, factorError('password_change_required'))
    return
  }
  const attached = v2.accounts.attachDevice(username, body.value.device)
  if (!attached.ok) {
    refuse(response, attached.reason === 'bad_device' ? 400 : 401, attached.reason)
    return
  }
  const session = v2.accounts.startSession(username, attached.device.id)
  if (session === null) {
    refuse(response, 500, 'malformed')
    return
  }
  const minted = v2.tokens.mintSession(username, attached.device.id, session.jti)
  v2Json(
    response,
    201,
    { token: minted.token, exp: minted.exp, deviceId: attached.device.id, username },
    { 'set-cookie': cookie(minted.token) }
  )
}

/**
 * The two routes, claimed ahead of `/v2/me` for the same reason phase 4's are:
 * the router's own `me` branch would otherwise swallow `/v2/me/join-codes`.
 * Answers false for anything it does not own.
 */
export function handleJoinRoute(ctx: V2Context, rest: readonly string[]): boolean {
  const { method } = ctx
  if (rest.length === 1 && rest[0] === 'join' && method === 'POST') {
    void redeemJoinCode(ctx)
    return true
  }
  if (rest.length === 2 && rest[0] === 'me' && rest[1] === 'join-codes' && method === 'POST') {
    const signed = signedIn(ctx.request, ctx.v2)
    if (signed === null) {
      refuse(ctx.response, 401, 'unauthenticated')
      return true
    }
    void mintJoinCode(ctx, signed.account.username)
    return true
  }
  return false
}
