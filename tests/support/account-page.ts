import { mePage } from '../../registry/src/site-account'
import type { Page } from '../../registry/src/site-shell'
import type { V2Identity } from '../../registry/src/v2-routes'

/**
 * THE ACCOUNT PAGE, AS IT IS SERVED SINCE 0.6.0 — standalone, on the auth host
 * (registry/src/auth-host.ts · GET /account). The registry's own /me, the
 * market and every other page the account sheet used to ride on are gone, so
 * a suite that pins the page's markup draws it here, from a real registry's
 * own account record, with the same call the auth host makes.
 */
export const STANDALONE = { site: 'https://cookrew.dev', console: 'https://console.cookrew.dev', home: '/account' }

/** Nobody signed in: the 401 that is still a page, with the account sheet behind its one button. */
export const signedOutAccountPage = (): Page => mePage(null, STANDALONE)

/** `username`'s page as the device `currentDeviceId` reads it. */
export function accountPageOf(v2: V2Identity, username: string, currentDeviceId: string): Page {
  const account = v2.accounts.get(username)
  if (account === null) throw new Error(`no account is called ${username}`)
  return mePage({ account, currentDeviceId, factors: v2.factors.store.summary(username) }, STANDALONE)
}
