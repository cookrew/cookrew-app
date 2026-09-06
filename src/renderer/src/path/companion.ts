import { apiPath, clientBase } from '../api-base'
import { isRemoteMode } from '../api'
import { authHeaders, authStore } from '../auth-gate'
import { dataPlane, setDataPlane, subscribeDataPlane, type DataPlane } from '../data-plane'
import type { LocalNetworkState } from '../local-network'
import { isLocalOrigin, localNetworkState, requestLocalNetwork } from '../local-network'
import { offerLocalNetwork, setLocalNetwork } from '../local-network-gate'
import { recordAttempts, type PathAttempt } from '../path-attempts'
import { createPathMemory, watchNetwork, type PathMemory, type PathMemoryDeps } from '../path-memory'
import { planeFetch } from '../plane-fetch'
import { planeHealth, type LinkHealth } from '../plane-health'
import { followDataPlane } from '../plane-streams'
import { currentOriginState, forgetLatency, setProbing, subscribePathLink } from '../path-link'
import {
  PLANE_PROBE_EVERY_MS,
  planeCandidates,
  switchPlaneIfBetter,
  type HelloClaim
} from './plane-switch'
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

/**
 * WHAT THIS PHONE CAN CHEAPLY SAY ABOUT ITS OWN CONNECTION.
 *
 * `navigator.connection` is the Network Information API — Chrome and the
 * Android web view have it, Safari does not — and `type`/`effectiveType` are
 * the two members that change when a phone moves from Wi-Fi to a radio. Null
 * where there is nothing to read, which is a DIFFERENT answer from "unknown
 * network" and is why path-memory.ts keeps two lifetimes rather than one.
 */
const connectionHint = (): string | null => {
  try {
    const link = (window as unknown as {
      navigator?: { connection?: { type?: string; effectiveType?: string } }
    }).navigator?.connection
    if (!link) return null
    const described = [link.type, link.effectiveType].filter(Boolean).join('/')
    return described.length > 0 ? described : null
  } catch {
    return null
  }
}

/**
 * The path memory over this phone's real storage.
 *
 * Private-mode Safari THROWS on storage access rather than returning null, so
 * the whole surface is probed once here and every method inside path-memory.ts
 * is guarded again — a hint is worth one saved probe and is never worth an
 * exception on a boot path.
 */
const memory = (): PathMemory => {
  const dead: PathMemoryDeps = {
    read: () => null,
    write: () => undefined,
    remove: () => undefined,
    now: () => Date.now(),
    network: connectionHint,
    keys: () => []
  }
  try {
    const storage = window.localStorage
    storage.getItem(PATH_MEMORY_PREFIX)
    return createPathMemory({
      ...dead,
      read: (key) => storage.getItem(key),
      write: (key, value) => storage.setItem(key, value),
      remove: (key) => storage.removeItem(key),
      keys: () => Object.keys(storage)
    })
  } catch {
    return createPathMemory(dead)
  }
}

/** window, as the two watchers here need it. */
const listen = (event: string, listener: () => void): (() => void) => {
  window.addEventListener(event, listener)
  return () => window.removeEventListener(event, listener)
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
/**
 * READ THE LOCAL-NETWORK PERMISSION, AND TELL THE REST OF THE APP.
 *
 * One read per race, and the store it updates is what the badge's sentence and
 * the explainer row both hang off — so there is exactly one moment in the
 * companion where this fact is established and everything else follows it.
 */
const readLocalNetwork = async (): Promise<LocalNetworkState> => {
  const state = await localNetworkState()
  setLocalNetwork(state)
  return state
}

/**
 * THE ONE ASK, aimed at the best trusted name the desktop currently publishes.
 *
 * A permission prompt has to be raised by a real request, and a request to
 * nowhere would spend the single ask a reader will ever grant. So the card is
 * fetched first and the ask is simply not offered when the Mac has no trusted
 * name — which is the honest state on a desktop with no certificate yet.
 */
const askForLocalNetwork = async (): Promise<void> => {
  const card = await fetchCard()
  // The first LOCAL candidate, not simply the first: a prompt is only raised
  // by a request the permission covers, and probing a CGNAT tailnet address
  // would spend the press without ever showing a dialog.
  const best = card
    ? planeCandidates(card, dataPlane().kind).find((candidate) => isLocalOrigin(candidate.origin))
    : undefined
  if (!best) {
    await readLocalNetwork()
    return
  }
  setLocalNetwork(await requestLocalNetwork({ url: best.origin }))
}

const startPlaneSwitch = (): (() => void) => {
  const health = planeHealth()
  // Set by the loop at start; the ONE-AT-A-TIME guard stays the loop's, so a
  // press cannot start a second race beside the timer's.
  let raceNow: () => void = () => undefined
  // True for exactly one race: the one a person asked for by pressing ALLOW.
  // Every other race — the timer, `online`, a tab coming back — must never
  // raise a dialog at a phone nobody is looking at.
  let pressed = false
  // The link store announces on EVERY change it holds — latency, probing, the
  // desktop's name — and only the transport's own state is evidence about the
  // plane. Without this the latency recorded by each successful request would
  // read as "the channel is live" and quietly disarm the watchdog that is
  // waiting to see whether a dropped stream comes back.
  let lastLink: LinkHealth | null = null
  const offs: (() => void)[] = [
    followDataPlane(),
    // The badge's latency is a measurement of the path it was taken on, and
    // the smoothing that keeps it steady within a path makes it a lie across
    // one. So a switch drops it and the next request re-establishes it.
    subscribeDataPlane(forgetLatency),
    // The push channel is the first thing to notice a plane that has died, so
    // its state is fed to the health watchdog rather than only to the badge.
    subscribePathLink((state) => {
      if (state.link === lastLink) return
      lastLink = state.link
      health.link(state.link)
    }),
    offerLocalNetwork(async () => {
      await askForLocalNetwork()
      // Whatever the browser decided, look again immediately — a grant that
      // waited up to a minute for the next tick would read as a button that
      // did nothing.
      pressed = true
      raceNow()
    }),
    startRaceLoop({
      everyMs: PLANE_PROBE_EVERY_MS,
      ready: (run) => void (raceNow = run),
      race: () =>
        switchPlaneIfBetter({
          plane: dataPlane,
          card: fetchCard,
          hello: (origin, nonce) => askHello(origin, nonce),
          verify: verifyHello,
          adopt: (plane: DataPlane) => setDataPlane(plane),
          nonce: () => randomNonce((bytes) => window.crypto.getRandomValues(bytes)),
          held: () => health.held(),
          probing: setProbing,
          note: (rows) =>
            recordAttempts(
              // The two shapes are the same fact and are kept apart on
              // purpose: plane-switch.ts must not import a renderer store, or
              // the rule stops being testable without one.
              rows as readonly PathAttempt[],
              dataPlane().kind === 'lan' ? 'LAN' : dataPlane().kind === 'tailnet' ? 'TAILNET' : 'RELAY'
            ),
          permission: readLocalNetwork,
          mayPrompt: () => {
            const may = pressed
            pressed = false
            return may
          }
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
  // The hint is flushed by the same two events that start a race, and it is
  // flushed FIRST: a race that read a stale hint would put an address from the
  // last network at the front of the queue on this one.
  const unwatch = watchNetwork(store, listen)

  const stop = startPathSwitching({
    deps: {
      current: currentOriginState,
      card: fetchCard,
      hello: (url, nonce) => askHello(url, nonce),
      credential: () => authStore().token(),
      go: (url) => window.location.replace(url),
      nonce: () => randomNonce((bytes) => window.crypto.getRandomValues(bytes)),
      remembered: (deviceId) => store.remembered(deviceId),
      remember: (deviceId, url) => store.remember(deviceId, url),
      probing: setProbing
    }
  })
  return () => {
    unwatch()
    stop()
  }
}
