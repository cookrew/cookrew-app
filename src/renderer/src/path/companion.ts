import { apiPath, clientBase } from '../api-base'
import { isRemoteMode } from '../api'
import { authHeaders, authStore } from '../auth-gate'
import { currentOriginState, setProbing } from '../path-link'
import {
  PATH_MEMORY_PREFIX,
  askHello,
  pathRank,
  randomNonce,
  startPathSwitching,
  type ReachCardLite
} from './switch'

/**
 * THE SWITCHER, PLUGGED INTO A REAL PHONE.
 *
 * switch.ts is the decision and holds no browser in it; this is the six things
 * that decision needs from an actual companion — its origin, the desktop's
 * card, a nonce, the credential, localStorage and `location.replace`. Kept
 * apart so the rule ("only better, and only after the Mac proves it is the
 * Mac") is testable without a DOM, which is where the rule can actually be got
 * wrong.
 *
 * IT DOES NOTHING ON THE DESKTOP, and nothing on a companion that is already
 * on the LAN. There is no faster path than the one it is on, and a probe that
 * ran anyway would be 120 pointless requests an hour from a device on battery.
 */

/** The desktop's own reach card, over whatever path is already working. */
const fetchCard = async (): Promise<ReachCardLite | null> => {
  try {
    const response = await fetch(apiPath('/api/reach'), {
      headers: authHeaders(),
      cache: 'no-store'
    })
    if (!response.ok) return null
    const body = (await response.json()) as Partial<ReachCardLite>
    if (typeof body.deviceId !== 'string' || !Array.isArray(body.lan)) return null
    return { deviceId: body.deviceId, lan: body.lan, tailnet: body.tailnet ?? null }
  } catch {
    return null
  }
}

/** Private-mode Safari throws on storage access rather than returning null. */
const memory = (): { read: (key: string) => string | null; write: (key: string, value: string) => void } => {
  try {
    const storage = window.localStorage
    storage.getItem(PATH_MEMORY_PREFIX)
    return {
      read: (key) => storage.getItem(key),
      write: (key, value) => storage.setItem(key, value)
    }
  } catch {
    return { read: () => null, write: () => undefined }
  }
}

/**
 * Start racing for a better path, or answer with a no-op teardown.
 *
 * Called once at boot. The guard is here rather than at the call site so
 * main.tsx does not have to know what a path is.
 */
export const startCompanionPathSwitch = (): (() => void) => {
  const noop = (): void => undefined
  if (!isRemoteMode()) return noop
  // A COMPANION LOADED UNDER cookrew.dev NEVER LEAVES cookrew.dev.
  //
  // The race below ends in `location.replace(<direct URL>)`, and a page served
  // through the relay that does that walks off the account's origin onto the
  // Mac's own listener. Until Reach v2.1's certificates exist (R1/R2) that
  // listener answers with a self-signed certificate, so the owner's phone
  // landed mid-session on ERR_CERT_AUTHORITY_INVALID — an interstitial telling
  // the reader not to trust the page, with the pairing token in the address
  // bar. The certificate problem is the product's to solve, never the
  // reader's.
  //
  // So under a relay prefix this does nothing at all. It is NOT the fix: the
  // fix is phase C3, where the data plane (fetch base, EventSource, WebSocket)
  // moves to a verified direct path with no navigation and no change to the
  // address bar. The decision in switch.ts is left whole and tested for that.
  if (clientBase() !== '') return noop
  // Already as close as it gets. Nothing on the card can beat this origin.
  if (pathRank(currentOriginState()) >= pathRank('LAN')) return noop
  const store = memory()

  return startPathSwitching({
    deps: {
      current: currentOriginState,
      card: fetchCard,
      hello: (url, nonce) => askHello(url, nonce),
      credential: () => authStore().token(),
      go: (url) => window.location.replace(url),
      nonce: () => randomNonce((bytes) => window.crypto.getRandomValues(bytes)),
      remembered: (deviceId) => store.read(`${PATH_MEMORY_PREFIX}${deviceId}`),
      remember: (deviceId, url) => store.write(`${PATH_MEMORY_PREFIX}${deviceId}`, url),
      probing: setProbing
    }
  })
}
