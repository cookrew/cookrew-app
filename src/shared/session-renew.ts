/**
 * WHEN A DESKTOP RENEWS, AND WHEN IT WARNS (v3, V3-17).
 *
 * A session lives thirty days. Before V3-16 that meant the owner retyped
 * their password once a month or every door they serve went "no-relay" —
 * the marketplace's availability bounded by a human's memory. The registry
 * now takes a signature from the device key instead (POST /v2/sessions/renew),
 * which is no weaker than the credential that attached the device in the
 * first place, and this file is the two questions the Mac asks about its own
 * clock.
 *
 * PURE, AND SEPARATE FROM THE CALL, because the interesting part is the
 * timing and the timing is what a test can pin. Nothing here reaches a
 * socket; `Accounts.renew` does that.
 */

/** Renew a week out. Six failed days still leave a day of warning. */
export const RENEW_AHEAD_MS = 7 * 24 * 60 * 60 * 1000

/** Two days out, tell every device — this is the last moment a person can act. */
export const EXPIRY_WARNING_MS = 2 * 24 * 60 * 60 * 1000

/** The registry's own message, byte for byte (registry/src/v2-renew.ts). */
export const RENEW_PREFIX = 'cookrew-renew/1'

export const renewMessage = (username: string, deviceId: string, nonce: string): string =>
  `${RENEW_PREFIX} ${username} ${deviceId} ${nonce}`

/** What this Mac holds, as far as the clock is concerned. */
export interface RenewableSession {
  readonly exp: number
  /** Set when the registry already refused it; no clock can predict that. */
  readonly endedAt?: number
}

/**
 * Is it time to renew?
 *
 * A session the registry has already ended is NOT renewable: the device key
 * would mint a fresh month for a session somebody deliberately closed, which
 * is the one thing "not me" must be able to stop. That case belongs to the
 * password, which is where `session-expired` already sends every surface.
 */
export function renewDue(session: RenewableSession | null, now: number, ahead = RENEW_AHEAD_MS): boolean {
  if (session === null || session.endedAt !== undefined) return false
  if (session.exp <= now) return false
  return session.exp - now <= ahead
}

/**
 * Has renewal failed long enough that the owner has to be told?
 *
 * Only while it is still TRUE — a warning for a session that has already
 * expired is a warning about something that has happened, and the app has a
 * better sentence for that (the doors are already down). And only once the
 * renewal is actually failing: a session inside its warning window that
 * renewed this morning is not a thing to alarm anybody about.
 */
export function expiryWarningDue(
  session: RenewableSession | null,
  now: number,
  renewFailing: boolean,
  within = EXPIRY_WARNING_MS
): boolean {
  if (!renewFailing) return false
  if (session === null || session.endedAt !== undefined) return false
  if (session.exp <= now) return false
  return session.exp - now <= within
}

/** The day the doors go down, for the sentence. Local, because a person reads it. */
export function expiryDay(session: RenewableSession, format: (at: number) => string): string {
  return format(session.exp)
}
