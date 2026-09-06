import { readHelloReply } from '../../../shared/hello-proof'
import type { DataPlane } from '../data-plane'
import type { HelloClaim } from './plane-switch'
import type { HelloReply } from './switch'

/**
 * VERIFIED ONCE IS NOT VERIFIED.
 *
 * The switcher proves a name is the Mac and then the companion keeps using
 * that name for the rest of the session. Everything after the proof is taken
 * on trust — and a NAME is not a machine. The Local Network Access
 * specification requires the address-space check "for each new connection made"
 * for exactly this reason: DNS answers expire, and the second answer does not
 * have to be the first one. A record with a short time to live can point at
 * the Mac while the proof is taken and at somebody else a minute later; every
 * request after that carries the pairing token to the new address, and nothing
 * on screen changes.
 *
 * So the proof is repeated on the plane the companion is actually using:
 *
 *   EVERY FIVE MINUTES, which is a rebinding window measured in one request an
 *   hour-twelfth rather than a probe per request. Per-connection re-proof is
 *   what the specification asks for and what a browser cannot give us from a
 *   page: `fetch` hands us no socket and no peer address. Five minutes bounds
 *   the exposure without turning the session into a probe loop.
 *
 *   AND AT THE TWO MOMENTS A PATH ACTUALLY CHANGES UNDER US — coming back
 *   online, and a push stream that dropped and came back. Both mean new
 *   connections were just made, which is precisely when the check is owed.
 *
 * WHAT A FAILURE MEANS, and it is two different things:
 *
 *   AN ANSWER THAT IS NOT THE MAC'S — a signature naming another origin, a
 *   different device, a registry that says no — is proof that this plane is
 *   the wrong machine. It is condemned at once: back to the relay, and the
 *   switcher holds off so it cannot be re-adopted on the next tick.
 *
 *   NO ANSWER AT ALL is the transport's business, not this one's. A Wi-Fi
 *   hiccup is not evidence about identity, so it is fed to the same counter
 *   that every other failed request goes to (plane-health.ts) and falls back
 *   only if the plane really is gone.
 *
 * ONE REQUEST, and only on a direct plane. On the relay there is nothing to
 * re-prove: the page came over it.
 */

/** How often a live direct plane is asked to prove itself again. */
export const RECHECK_EVERY_MS = 300_000

export type RecheckOutcome =
  /** On the relay, or the desktop this plane belongs to is not known. */
  | 'skipped'
  /** Still the Mac. */
  | 'proved'
  /** Answered, and was not the Mac. Condemned. */
  | 'unproven'
  /** Did not answer. Counted as a failed request and left to the watchdog. */
  | 'unreachable'

/** The part of plane-health this needs, so a test needs no singleton. */
export interface RecheckHealth {
  /** One request finished. `ok` is false ONLY for a transport failure. */
  readonly note: (ok: boolean) => void
  /** This plane is not the Mac. Fall back now and hold. */
  readonly condemn: () => void
}

export interface PlaneRecheckDeps {
  readonly plane: () => DataPlane
  /** The desktop this plane was adopted for. Null = nothing to compare against. */
  readonly deviceId: () => string | null
  /** `GET <origin>/api/hello?nonce=&origin=`, with a short deadline. */
  readonly hello: (origin: string, nonce: string) => Promise<HelloReply | null>
  /** `POST /v2/verify-hello` at the registry. False on anything but a yes. */
  readonly verify: (claim: HelloClaim) => Promise<boolean>
  readonly nonce: () => string
  readonly health: RecheckHealth
  readonly log?: (message: string) => void
}

/**
 * One re-check. Never throws: it runs on a timer nobody is watching, and a
 * rejection here would leave the loop's one-at-a-time latch stuck shut.
 */
export const recheckPlane = async (deps: PlaneRecheckDeps): Promise<RecheckOutcome> => {
  const plane = deps.plane()
  const deviceId = deps.deviceId()
  if (plane.kind === 'relay' || plane.origin === '' || deviceId === null) return 'skipped'

  const nonce = deps.nonce()
  const reply = await deps.hello(plane.origin, nonce).catch(() => null)
  if (reply === null) {
    // Silence is not evidence about identity. The transport counter decides.
    deps.health.note(false)
    return 'unreachable'
  }
  const read = readHelloReply(reply, { origin: plane.origin, deviceId, nonce })
  if (!read.ok) {
    deps.log?.(`plane recheck: ${plane.origin} answered ${read.reason}`)
    deps.health.condemn()
    return 'unproven'
  }
  const proved = await deps.verify({ deviceId, nonce, ...read.proof }).catch(() => null)
  if (proved === null) {
    // The REGISTRY could not be reached — offline, rate limited, signed out.
    // That is not a verdict about the plane, and condemning on it would drop
    // a working LAN session every time cookrew.dev hiccuped.
    return 'unreachable'
  }
  if (!proved) {
    deps.log?.(`plane recheck: the registry no longer vouches for ${plane.origin}`)
    deps.health.condemn()
    return 'unproven'
  }
  deps.health.note(true)
  return 'proved'
}

export interface PlaneRecheckOptions {
  readonly deps: PlaneRecheckDeps
  readonly everyMs?: number
  /** window, or a stand-in with the one listener this uses. */
  readonly on?: (event: string, listener: () => void) => () => void
  readonly setInterval?: (fn: () => void, ms: number) => () => void
}

export interface PlaneRecheck {
  readonly stop: () => void
  /**
   * Re-check now — for the caller that knows a connection was just remade.
   * The push stream is the one that matters and only the companion's wiring
   * can see it, so it is pushed in here rather than listened for.
   */
  readonly now: () => void
}

/**
 * The loop. Same one-at-a-time rule as the switcher's: coming back online can
 * fire the timer and the listener together, and two re-checks in flight would
 * be two requests and two chances to condemn a plane twice.
 */
export const startPlaneRecheck = (options: PlaneRecheckOptions): PlaneRecheck => {
  let running = false
  const run = (): void => {
    if (running) return
    running = true
    void recheckPlane(options.deps)
      .catch(() => undefined)
      .finally(() => void (running = false))
  }

  const every =
    options.setInterval ??
    ((fn, ms): (() => void) => {
      const handle = setInterval(fn, ms)
      return () => clearInterval(handle)
    })
  const listen =
    options.on ??
    ((event, listener): (() => void) => {
      window.addEventListener(event, listener)
      return () => window.removeEventListener(event, listener)
    })

  const offs: (() => void)[] = [every(run, options.everyMs ?? RECHECK_EVERY_MS), listen('online', run)]
  return {
    stop: () => offs.forEach((off) => off()),
    now: run
  }
}
