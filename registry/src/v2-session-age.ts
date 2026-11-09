/**
 * HOW OLD A SESSION MAY GET, AND HOW RECENTLY IT MUST HAVE PROVED ITSELF.
 *
 * Owner's ruling, 2026-11-09 (docs/auth-ux-2026-11-09.html, the green box):
 *
 *   idle      seven days without a request ends a session;
 *   absolute  thirty days after the sign-in that started it, a session ends
 *             whatever it did meanwhile — renewing on the device key carries
 *             the sign-in's time forward, it never restarts it;
 *   fresh     changing the password, adding or removing a factor, deleting the
 *             account and removing a device need a verification within the
 *             last five minutes.
 *
 * ONE MODULE FOR THE NUMBERS AND THE QUESTIONS, because the routes that ask
 * them are many and a second copy of "five minutes" is how two of them would
 * disagree. The fields live on the session record (v2-accounts.ts · V2Session);
 * all three are optional because sessions written before this ruling carry
 * none — a missing `signedInAt` is filled in the first time the session is
 * used after the deploy, so every older session gets thirty days from then.
 */

export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000
export const FRESH_MS = 5 * 60 * 1000
/** A request refreshes `lastUsedAt` at most this often: a session is not a file write per request. */
export const LAST_USED_GRAIN_MS = 10 * 60 * 1000

/** How a session last proved who is holding it. */
export type VerifiedBy = 'password' | 'passkey' | 'totp' | 'recovery' | 'provider'

export interface SessionAge {
  readonly signedInAt?: number
  readonly lastUsedAt?: number
  readonly verifiedAt?: number
  readonly verifiedBy?: VerifiedBy
}

/** Has this session proved itself within the last five minutes — by one of `by`, when given? */
export function freshlyVerified(session: SessionAge | null | undefined, now: number, by?: readonly VerifiedBy[]): boolean {
  if (!session || typeof session.verifiedAt !== 'number') return false
  if (now - session.verifiedAt > FRESH_MS || session.verifiedAt > now + 60_000) return false
  return by === undefined || (session.verifiedBy !== undefined && by.includes(session.verifiedBy))
}

/** Why a session is over, or null while it lives. Missing fields read as "starts now". */
export function sessionEnded(session: SessionAge, now: number): 'idle' | 'absolute' | null {
  if (typeof session.signedInAt === 'number' && now - session.signedInAt > SESSION_ABSOLUTE_MS) return 'absolute'
  if (typeof session.lastUsedAt === 'number' && now - session.lastUsedAt > SESSION_IDLE_MS) return 'idle'
  return null
}

/** When a token minted now must expire: never past the sign-in's thirtieth day. */
export function tokenExpiry(session: SessionAge, now: number, ttlMs: number): number {
  const absolute = typeof session.signedInAt === 'number' ? session.signedInAt + SESSION_ABSOLUTE_MS : now + SESSION_ABSOLUTE_MS
  return Math.min(now + ttlMs, absolute)
}
