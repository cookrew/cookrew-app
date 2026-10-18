/**
 * IS THIS DIRECT PATH ACTUALLY BETTER THAN THE RELAY?
 *
 * The plane ranks LAN > tailnet > relay because a direct path is usually
 * nearer. A tailnet is not always: from the owner's iPhone on 5G on
 * 2026-10-18 it ran through a Tailscale relay server, answered one hello in
 * 2.4 s and timed out on the rest, and once adopted it carried nothing — a
 * black terminal under a TAILNET badge, while the cookrew.dev relay was
 * working fine. Answering once is not being better.
 *
 * So a tailnet that won its race is timed on its now-warm connection (two
 * more hellos, the faster counts) and adopted only when that round trip is
 * no worse than the relay's own (path-link.ts · latencyMs, the smoothed time
 * of the requests the companion has been making) and under a ceiling no
 * session can live with. The LAN is not asked: it is the same Wi-Fi.
 */

/** A warm round trip past this is not a path to move a session onto, whatever the relay does. */
export const TAILNET_WARM_MAX_MS = 900
/** Below this a tailnet is taken without comparing: it is plainly fast. */
export const TAILNET_WARM_FAST_MS = 200

export const tailnetWorthIt = (warmMs: number | null, relayMs: number | null): boolean => {
  if (warmMs === null || warmMs > TAILNET_WARM_MAX_MS) return false
  if (warmMs <= TAILNET_WARM_FAST_MS) return true
  return relayMs === null || warmMs <= relayMs
}

/** The faster of `tries` timed calls; null when none of them answered. */
export const warmRoundTrip = async (
  ask: () => Promise<boolean>,
  tries = 2,
  now: () => number = () => performance.now()
): Promise<number | null> => {
  let best: number | null = null
  for (let i = 0; i < tries; i += 1) {
    const started = now()
    const ok = await ask().catch(() => false)
    const ms = now() - started
    if (ok && (best === null || ms < best)) best = ms
  }
  return best === null ? null : Math.round(best)
}
