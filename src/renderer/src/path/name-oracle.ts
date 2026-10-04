/**
 * THE QUESTION A PHONE ASKS WHEN A PROBE DIES WITHOUT A CAUSE.
 *
 * A failed fetch is a bare TypeError in every browser: the same object for a
 * Local Network Access refusal, a certificate it would not trust, and a
 * resolver answering "no such name". hello-result.ts tells the first from the
 * rest by the clock, and on 2026-10-04 the clock lied — the owner's Mac had
 * stopped publishing its card, the zone had forgotten its names, and the
 * phone's resolver served the negative answer from cache in 4 ms. The sheet
 * said "refused by the browser before connecting" over a Mac three metres
 * away, for five days.
 *
 * THE ZONE KNOWS. `GET /v2/names/<host>` on the registry answers the one bit
 * the phone cannot see: is this name being answered right now. It is asked
 * of the PAGE'S OWN ORIGIN — the companion under a relay base is served by
 * the registry, or a self-host of it, and that is the registry whose zone
 * the name lives in. A verdict is 200 with `live`; anything else, including
 * no network, is `unknown`, and an unknown never becomes a claim
 * (plane-race.ts · settleNames).
 */

export type NameVerdict = 'live' | 'dead' | 'unknown'

/** A registry that has not answered in this long is not going to settle anything. */
export const NAME_TIMEOUT_MS = 3000

export interface NameOracleDeps {
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
}

export const nameLive = async (origin: string, deps: NameOracleDeps = {}): Promise<NameVerdict> => {
  let host: string
  try {
    host = new URL(origin).hostname
  } catch {
    return 'unknown'
  }
  const call = deps.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch
  if (!call) return 'unknown'
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), deps.timeoutMs ?? NAME_TIMEOUT_MS)
  try {
    const response = await call(`/v2/names/${encodeURIComponent(host)}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: abort.signal
    })
    if (!response.ok) return 'unknown'
    const body = (await response.json()) as { live?: unknown }
    return body.live === true ? 'live' : body.live === false ? 'dead' : 'unknown'
  } catch {
    return 'unknown'
  } finally {
    clearTimeout(timer)
  }
}
