import { livesUntilRevoked, type V2Account } from './v2-accounts'
import { sessionEnded } from './v2-session-age'
import type { PushSubscriptionRecord } from './v2-push-store'

/**
 * PHONE PUSH — A SUBSCRIPTION LIVES AS LONG AS THE SIGN-IN THAT MADE IT
 * (security review 2026-11-17, M2).
 *
 * Each row names the device that filed it and the sign-in (the sitting, which
 * a renewal carries forward) it was filed under. A row is live while that
 * device is still on the account and that sitting still has a session the
 * registry would take: not signed out, not ended by "Not me", a password
 * change or a recovery, not revoked with its device, and not run out on the
 * clock. The account store says when sessions end (v2-accounts.ts · replace)
 * and the rows go then; every read filters again, for a sitting that ran out
 * on the clock with nobody asking.
 */

export function liveRows<Row extends Pick<PushSubscriptionRecord, 'dev' | 'sid'>>(
  rows: readonly Row[],
  account: Pick<V2Account, 'devices' | 'sessions'>,
  now: number
): Row[] {
  return rows.filter((row) => {
    const device = account.devices.find((d) => d.id === row.dev)
    if (device === undefined) return false
    return account.sessions.some(
      (s) => s.dev === row.dev && (s.sitting ?? s.jti) === row.sid && ((livesUntilRevoked(device) && s.via !== 'console') || sessionEnded(s, now) === null)
    )
  })
}
