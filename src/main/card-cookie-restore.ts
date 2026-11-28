/**
 * KEPT COOKIES GO BACK INTO A CARD'S CHROME before its first page loads
 * (headless-chrome.ts · start), from the card's vault (card-cookie-vault.ts).
 *
 * Who wins, so a restore is never worse than no restore:
 *   1. a cookie main primed this run (magpie-card-open.ts): set after, always;
 *   2. a cookie Chrome kept in its own profile: Chrome's copy is at least as
 *      new — it flushed it at the close that followed the capture, or later;
 *   3. the vault fills what is left, which is what Chrome drops on every
 *      restart: the session cookies (Aliyun's login is one, 11-28).
 *
 * Chrome refuses a whole Storage.setCookies batch for one cookie it does not
 * like, so a refused batch is retried a cookie at a time. Nothing here throws:
 * a card with a bad vault starts signed out, never not at all.
 */

import type { HeadlessCookie } from './headless-chrome'
import { cookieKey, cookieParamFor, vaultCookieFrom, type VaultCookie } from './card-cookie-shape'

export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>

const say = (line: string): void => console.error(line)

function cookiesIn(answer: unknown): readonly unknown[] {
  const cookies = (answer as { cookies?: unknown } | null)?.cookies
  return Array.isArray(cookies) ? cookies : []
}

const sets = (send: CdpSend, cookies: readonly HeadlessCookie[]): Promise<boolean> =>
  send('Storage.setCookies', { cookies }).then(
    () => true,
    () => false
  )

/** How many kept cookies went back in. */
export async function restoreCardCookies(
  send: CdpSend,
  kept: readonly VaultCookie[],
  primed: readonly HeadlessCookie[],
  log: (line: string) => void = say
): Promise<number> {
  if (kept.length === 0) return 0
  const answer = await send('Storage.getCookies', {}).catch(() => null)
  if (answer === null) {
    log('cookie vault: the card Chrome could not list its cookies, so none were restored')
    return 0
  }
  const taken = new Set<string>(primed.map(cookieKey))
  for (const raw of cookiesIn(answer)) {
    const cookie = vaultCookieFrom(raw)
    if (cookie) taken.add(cookieKey(cookie))
  }
  const missing = kept.filter((cookie) => !taken.has(cookieKey(cookie))).map(cookieParamFor)
  if (missing.length === 0) return 0
  if (await sets(send, missing)) return missing.length

  let restored = 0
  for (const cookie of missing) {
    if (await sets(send, [cookie])) restored += 1
  }
  log(`cookie vault: Chrome refused ${missing.length - restored} of ${missing.length} kept cookies; the rest were restored`)
  return restored
}
