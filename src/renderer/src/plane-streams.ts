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

/** Follow the plane. Called once at boot, from the companion wiring. */
export const followDataPlane = (): (() => void) => subscribeDataPlane(restartPlaneStreams)

/** Test seam: the registry is a singleton and a test needs a clean one. */
export const resetPlaneStreams = (): void => streams.clear()
