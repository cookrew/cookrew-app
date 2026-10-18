import { subscribeDataPlane } from './data-plane'

/**
 * THE CONNECTIONS THAT DO NOT RE-READ THEIR OWN URL.
 *
 * A fetch composes its URL every time it is made, so moving the data plane
 * moves every fetch for free. A stream does not: an EventSource opened over
 * the relay stays open over the relay, and a phone that has just switched onto
 * the LAN would keep its canvas fed through cookrew.dev — a switch that
 * measurably did nothing, and the kind that reads as working.
 *
 * So the long-lived connections register here and are restarted, deliberately
 * and all at once, whenever the plane changes. `revive()` is not enough: it is
 * for a channel that is DOWN and leaves a healthy one alone, which is exactly
 * the case here — the relay stream is perfectly alive, it is simply on the
 * wrong path now.
 *
 * Restarting a live stream costs one full state re-send. That is the price of
 * the switch and it is paid once, against a session that then runs on the
 * near path for as long as the phone stays in the house.
 */

export interface PlaneStream {
  /** Drop the current connection and open a new one at today's URL. */
  restart: () => void
  /** Reconnect now if the connection is down; a live one is left alone. */
  revive?: () => void
}

const streams = new Set<PlaneStream>()

/** Register a stream for the life of its connection; call the result to drop it. */
export const registerPlaneStream = (stream: PlaneStream): (() => void) => {
  streams.add(stream)
  return () => void streams.delete(stream)
}

export const restartPlaneStreams = (): void => {
  for (const stream of streams) {
    try {
      stream.restart()
    } catch {
      // One stream that will not restart must not strand the others; the
      // reconnect loop inside it will pick the new URL up on its next try.
    }
  }
}

/**
 * A REQUEST JUST WORKED, so the network is there: a stream sitting out its
 * backoff after a drop (a VPN switch reset every connection the phone had)
 * reconnects now rather than in up to 8 s. Throttled, because a burst of
 * requests is one piece of evidence, not twenty.
 */
const REVIVE_EVERY_MS = 2_000
let lastRevive = 0
export const reviveStreams = (now: number = Date.now()): void => {
  if (now - lastRevive < REVIVE_EVERY_MS) return
  lastRevive = now
  for (const stream of streams) {
    try {
      stream.revive?.()
    } catch {
      // As above: one stream must not strand the others.
    }
  }
}

/** Follow the plane. Called once at boot, from the companion wiring. */
export const followDataPlane = (): (() => void) => subscribeDataPlane(restartPlaneStreams)

/** Test seam: the registry is a singleton and a test needs a clean one. */
export const resetPlaneStreams = (): void => {
  streams.clear()
  lastRevive = 0
}
