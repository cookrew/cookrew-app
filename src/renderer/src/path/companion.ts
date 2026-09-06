import { apiPath, clientBase } from '../api-base'
import { isRemoteMode } from '../api'
import { authHeaders, authStore } from '../auth-gate'
import { dataPlane, setDataPlane, subscribeDataPlane, type DataPlane } from '../data-plane'
import { planeFetch } from '../plane-fetch'
import { planeHealth, type LinkHealth } from '../plane-health'
import { followDataPlane } from '../plane-streams'
import { currentOriginState, forgetLatency, setProbing, subscribePathLink } from '../path-link'
import { PLANE_PROBE_EVERY_MS, switchPlaneIfBetter, type HelloClaim } from './plane-switch'
import { startPlaneRecheck } from './plane-recheck'
import {
  PATH_MEMORY_PREFIX,
  askHello,
  pathRank,
  randomNonce,
  startPathSwitching,
  startRaceLoop,
  type ReachCardLite
} from './switch'

/**
 * THE SWITCHERS, PLUGGED INTO A REAL PHONE.
 *
 * switch.ts and plane-switch.ts are the decisions and hold no browser in them;
 * this is the handful of things those decisions need from an actual companion
 * — its plane, the desktop's card, a nonce, the credential, localStorage and
 * either `location.replace` or the data-plane store. Kept apart so the rules
 * ("only better, and only after the Mac proves it is the Mac") are testable
 * without a DOM, which is where a rule can actually be got wrong.
 *
 * WHICH SWITCHER RUNS IS DECIDED BY THE PREFIX, and it is the whole shape of
 * Reach v2.1 in one branch:
 *
 *   AT THE ROOT the page origin IS the transport, so moving to a nearer path
 *   means loading the app at that address. Unchanged, down to the URL it
 *   navigates to — a phone that scanned the Mac's printed LAN link is not
 *   affected by any of this.
 *
 *   UNDER THE RELAY BASE the page never leaves cookrew.dev. The data plane
 *   moves instead, and the badge is the only thing that changes on screen.
 *
 * IT DOES NOTHING ON THE DESKTOP, and nothing on a companion already on the
 * LAN. There is no faster path than the one it is on, and a probe that ran
 * anyway would be pointless requests off a device on battery.
 */

/**
 * WHICH DESKTOP THE PLANE WAS ADOPTED FOR.
 *
 * The re-check has to compare a hello against a device id, and it must not
 * spend a request on `/api/reach` to learn one it already knew. The card is
 * fetched by the switcher on every race up to the moment it switches — after
 * that the switcher is `skipped` and fetches nothing — so the last id seen is
 * exactly the id that was proved. It is only ever overwritten by a fresher
 * card, never by a failed fetch.
 */
let lastDeviceId: string | null = null

/** The desktop this companion is talking to, as far as the card ever said. */
export const cardDeviceId = (): string | null => lastDeviceId

/** The desktop's own reach card, over whatever plane is already working. */
const fetchCard = async (): Promise<ReachCardLite | null> => {
  try {
    const response = await planeFetch(apiPath('/api/reach'), {
      headers: authHeaders(),
      cache: 'no-store'
    })
    if (!response.ok) return null
    const body = (await response.json()) as Partial<ReachCardLite>
    if (typeof body.deviceId !== 'string' || !Array.isArray(body.lan)) return null
    // `trusted` is Reach v2.1's addition and an OLDER MAC WILL NOT HAVE IT.
    // Absent reads as empty, which reads as "no live switch today" — the
    // relay keeps working and nothing announces a downgrade that is really
    // just a desktop that has not been updated yet.
    const trusted = Array.isArray(body.trusted)
      ? body.trusted.filter((origin): origin is string => typeof origin === 'string')
      : []
    lastDeviceId = body.deviceId
    return {
      deviceId: body.deviceId,
      lan: body.lan,
      tailnet: body.tailnet ?? null,
      trusted
    }
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
 * A DEADLINE, BECAUSE THIS RUNS ON A TIMER NOBODY IS WATCHING.
 *
 * `askHello` has had one from the start; this request did not, and the two sit
 * in the same race. Measured on a real phone-width Chrome: the relay's own
 * long-lived streams filled the browser's six connections to the registry's
 * origin, this POST never got a socket, and `switchPlaneIfBetter` sat in an
 * await that could not end — so `probing(false)` never ran, the badge stuck on
 * PROBING for ever, the plane never moved, and every minute the timer started
 * another request that also hung and also held a socket, until the companion's
 * own traffic to cookrew.dev died with it.
 *
 * Longer than HELLO_TIMEOUT_MS on purpose: a hello is one hop across the room
 * and this is a round trip to the registry. Long enough for a slow one, short
 * enough that a stall costs a race rather than the session.
 */
export const VERIFY_TIMEOUT_MS = 4000

/**
 * ASK cookrew.dev WHETHER THAT REPLY CAME FROM MY MAC.
 *
 * The page cannot check the signature itself — the device's public key is a
 * fact the registry holds — so it asks, over its OWN origin, with the account
 * session cookie. Root-relative on purpose and NOT through apiPath: apiPath
 * addresses the desktop (through the relay or directly), and this is the one
 * request in the client that is genuinely for cookrew.dev itself.
 *
 * Anything but a clean `{ok:true}` is a no. A verification that cannot be
 * completed — offline, rate limited, signed out — must leave the phone on the
 * relay rather than on an unproven address.
 */
export const verifyHello = async (claim: HelloClaim, timeoutMs = VERIFY_TIMEOUT_MS): Promise<boolean> => {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const response = await fetch('/v2/verify-hello', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      signal: abort.signal,
      body: JSON.stringify(claim)
    })
    if (!response.ok) return false
    const body = (await response.json()) as { ok?: unknown }
    return body.ok === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * THE LIVE DATA-PLANE SWITCH, for a companion served under the relay base.
 *
 * Everything it does happens below the address bar: it races the Mac's trusted
 * names, has the registry prove one of them, and then points the store that
 * composes every request URL at it. The streams follow (plane-streams.ts), the
 * badge follows (path-link.ts), the token stays where it is, and the page is
 * not reloaded — which is the entire difference between this and the switch
 * that put a phone on a certificate warning.
 */
const startPlaneSwitch = (): (() => void) => {
  const health = planeHealth()
  // The link store announces on EVERY change it holds — latency, probing, the
  // desktop's name — and only the transport's own state is evidence about the
  // plane. Without this the latency recorded by each successful request would
  // read as "the channel is live" and quietly disarm the watchdog that is
  // waiting to see whether a dropped stream comes back.
  let lastLink: LinkHealth | null = null
  /**
   * THE RE-CHECK, on the plane the companion is actually using. One line of
   * wiring; the rule is in path/plane-recheck.ts. It runs on its own five
   * minute clock and on `online`, and is poked below whenever the push stream
   * comes back — a stream that reconnected made a new connection, which is the
   * moment a name could have started answering as somebody else.
   */
  const recheck = startPlaneRecheck({
    deps: {
      plane: dataPlane,
      deviceId: cardDeviceId,
      hello: (origin, nonce) => askHello(origin, nonce, { origin }),
      verify: verifyHello,
      nonce: () => randomNonce((bytes) => window.crypto.getRandomValues(bytes)),
      health: { note: health.note, condemn: health.condemn }
    }
  })
  const offs: (() => void)[] = [
    recheck.stop,
    followDataPlane(),
    // The badge's latency is a measurement of the path it was taken on, and
    // the smoothing that keeps it steady within a path makes it a lie across
    // one. So a switch drops it and the next request re-establishes it.
    subscribeDataPlane(forgetLatency),
    // The push channel is the first thing to notice a plane that has died, so
    // its state is fed to the health watchdog rather than only to the badge.
    subscribePathLink((state) => {
      if (state.link === lastLink) return
      const reconnected = state.link === 'live' && lastLink !== null
      lastLink = state.link
      health.link(state.link)
      // A stream that dropped and came back opened a new connection. Prove the
      // far end is still the Mac before the session keeps using it.
      if (reconnected) recheck.now()
    }),
    startRaceLoop({
      everyMs: PLANE_PROBE_EVERY_MS,
      race: () =>
        switchPlaneIfBetter({
          plane: dataPlane,
          card: fetchCard,
          // The origin is sent so the Mac answers version 2 — a proof bound
          // to the endpoint, which is the only kind this switcher accepts.
          hello: (origin, nonce) => askHello(origin, nonce, { origin }),
          verify: verifyHello,
          adopt: (plane: DataPlane) => setDataPlane(plane),
          nonce: () => randomNonce((bytes) => window.crypto.getRandomValues(bytes)),
          held: () => health.held(),
          probing: setProbing
        })
    })
  ]
  return () => offs.forEach((off) => off())
}

/**
 * Start switching, or answer with a no-op teardown.
 *
 * Called once at boot. The guards are here rather than at the call site so
 * main.tsx does not have to know what a path is.
 */
export const startCompanionPathSwitch = (): (() => void) => {
  const noop = (): void => undefined
  if (!isRemoteMode()) return noop
  if (clientBase() !== '') return startPlaneSwitch()
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
