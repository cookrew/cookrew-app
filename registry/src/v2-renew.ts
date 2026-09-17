import { randomBytes } from 'node:crypto'
import { readJsonBody } from './http'
import { asking, cookie, refuse, v2Json, type V2Context } from './v2-http'
import { verifyDeviceSignature } from './v2-reach'

/**
 * A SESSION THAT RENEWS ITSELF ON THE DEVICE KEY.
 *
 * Sessions live thirty days. Before this, the only way past day thirty was a
 * password — which meant the availability of a person's DOORS was bounded by
 * their memory: a Mac serving a crew went dark on a Tuesday because nobody had
 * typed a password into it since a Tuesday a month ago. That is a bad bargain,
 * and not a security one: the device key is already the credential that
 * attached the device, so renewing on it is no weaker than the attachment was.
 *
 * WHY A NONCE AND NOT A TIMESTAMP. A signature over the clock is replayable
 * for as long as the skew allowance, and this signature mints a session. The
 * registry issues the number, remembers it for two minutes, and spends it on
 * first use — so a signature scraped off the wire buys nothing at all, not
 * even a narrow window.
 *
 * WHAT THE SIGNATURE SAYS, and why each part is in it:
 *
 *     cookrew-renew/1 <username> <deviceId> <nonce>
 *
 *   the prefix, so a signature minted for one purpose is not spendable at
 *     another (the hello challenge signs `cookrew-hello/2 …` for this reason);
 *   the username and device id, so a signature is about ONE session and cannot
 *     be replayed against another account that happened to be issued the same
 *     nonce;
 *   the nonce, so it is fresh and single-use.
 *
 * THE OLD SESSION IS CLOSED. Renewal is a replacement, not an addition:
 * leaving the old jti live would mean a month of renewals is a month of
 * accumulating bearer tokens, every one of them still good.
 */

/** Two minutes: long enough to sign and answer, short enough to be a moment. */
export const RENEW_NONCE_TTL_MS = 2 * 60 * 1000
/** More outstanding nonces than a registry hands out in two minutes. */
const RENEW_NONCES_MAX = 4096

export const RENEW_PREFIX = 'cookrew-renew/1'

/** What the device signs. One function, so the two ends cannot spell it differently. */
export const renewMessage = (username: string, deviceId: string, nonce: string): string =>
  `${RENEW_PREFIX} ${username} ${deviceId} ${nonce}`

export interface RenewNonces {
  /** A fresh number, remembered until it is spent or expires. */
  issue(): { nonce: string; expiresAt: number }
  /** True exactly once per nonce, and only inside its two minutes. */
  spend(nonce: unknown): boolean
  size(): number
}

export function createRenewNonces(
  now: () => number = Date.now,
  ttlMs = RENEW_NONCE_TTL_MS,
  max = RENEW_NONCES_MAX
): RenewNonces {
  // Insertion-ordered with one lifetime each, so the front is always the
  // oldest and a sweep can stop at the first live entry.
  const held = new Map<string, number>()
  const sweep = (at: number): void => {
    for (const [nonce, expiry] of held) {
      if (expiry > at) break
      held.delete(nonce)
    }
  }
  return {
    issue: () => {
      const at = now()
      sweep(at)
      const nonce = randomBytes(18).toString('base64url')
      const expiresAt = at + ttlMs
      held.set(nonce, expiresAt)
      // Trimmed AFTER the insert: the entry just added is the newest, so
      // insertion order guarantees the cap never evicts the nonce it was
      // called to record.
      while (held.size > max) {
        const oldest = held.keys().next()
        if (oldest.done === true) break
        held.delete(oldest.value)
      }
      return { nonce, expiresAt }
    },
    spend: (nonce) => {
      if (typeof nonce !== 'string' || nonce === '') return false
      const at = now()
      sweep(at)
      const expiry = held.get(nonce)
      if (expiry === undefined || expiry <= at) return false
      held.delete(nonce)
      return true
    },
    size: () => held.size
  }
}

/**
 * GET /v2/sessions/renew-nonce — a number to sign.
 *
 * Unauthenticated on purpose. A nonce is not a secret and proves nothing; the
 * signature is the credential, and requiring a session here would mean a Mac
 * whose session is about to lapse has to hold the thing it is renewing in
 * order to renew it. Bounded by the store's cap and by a per-address limiter,
 * because a route that allocates on demand is a route worth flooding.
 */
function renewNonce(ctx: V2Context): void {
  if (!ctx.v2.limits.lookups.take(`renew-nonce|${asking(ctx)}`)) {
    refuse(ctx.response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
    return
  }
  const issued = ctx.v2.renewNonces.issue()
  v2Json(ctx.response, 200, issued)
}

/**
 * POST /v2/sessions/renew {device, nonce, sig} — the same device, a new month.
 *
 * No username on the wire: the device id names exactly one account, and asking
 * the caller to also name it would be one more thing to get wrong and nothing
 * more to prove.
 */
async function renewSession(ctx: V2Context): Promise<void> {
  const { response, v2 } = ctx
  const body = await readJsonBody(ctx.request, 16 * 1024)
  if (!body.ok) {
    refuse(response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const deviceId = typeof body.value.device === 'string' ? body.value.device : ''
  if (deviceId === '') {
    refuse(response, 400, 'malformed')
    return
  }
  /**
   * PER DEVICE, not per address. A Mac renews a handful of times a year, and
   * the thing worth bounding is one device's key being used to churn sessions
   * — which an address limit would miss entirely when the churn comes through
   * a relay, and would punish a whole office for when it does not.
   */
  if (!v2.limits.renew.take(`renew|${deviceId}`)) {
    refuse(response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
    return
  }
  /**
   * SPENT BEFORE THE SIGNATURE IS CHECKED, exactly as a recovery code is spent
   * before the device is looked at. A nonce that has been presented is used up
   * whether or not what came with it was any good; otherwise a caller could
   * hold one open by sending deliberately bad signatures against it.
   */
  if (!v2.renewNonces.spend(body.value.nonce)) {
    refuse(response, 401, 'bad_credentials')
    return
  }
  const found = v2.accounts.deviceOwner(deviceId)
  if (found === null) {
    refuse(response, 401, 'bad_credentials')
    return
  }
  /**
   * A REVOKED DEVICE IS REFUSED HERE AND NOT ONLY AT THE DOOR. The security
   * model's fourth line says renewal is refused for a revoked device; without
   * this the key of a device the owner took back would still mint a fresh
   * thirty days, which is the whole point of taking it back.
   */
  if (v2.accounts.revokedFor(found.username).includes(deviceId)) {
    refuse(response, 401, 'bad_credentials')
    return
  }
  const message = renewMessage(found.username, deviceId, String(body.value.nonce))
  if (!verifyDeviceSignature(found.device.jwk, message, body.value.sig)) {
    refuse(response, 401, 'bad_credentials')
    return
  }
  const session = v2.accounts.startSession(found.username, deviceId)
  if (session === null) {
    refuse(response, 500, 'malformed')
    return
  }
  /**
   * The old one goes. A renewal replaces; it does not add. Closed AFTER the
   * new one exists, so a crash between the two leaves the device signed in on
   * the old session rather than signed out of both.
   */
  v2.accounts.closeOtherSessionsForDevice(found.username, deviceId, session.jti)
  const minted = v2.tokens.mintSession(found.username, deviceId, session.jti)
  v2Json(
    response,
    201,
    { token: minted.token, exp: minted.exp, deviceId, username: found.username },
    { 'set-cookie': cookie(minted.token) }
  )
}

/** The two routes. Answers false for anything it does not own. */
export function handleRenewRoute(ctx: V2Context, rest: readonly string[]): boolean {
  const { method } = ctx
  if (rest.length === 2 && rest[0] === 'sessions' && rest[1] === 'renew-nonce' && method === 'GET') {
    renewNonce(ctx)
    return true
  }
  if (rest.length === 2 && rest[0] === 'sessions' && rest[1] === 'renew' && method === 'POST') {
    void renewSession(ctx)
    return true
  }
  return false
}
