// Backoff state for the browser-thumbnail capturePage() loop. A rejected
// capture usually means the GPU process is degraded (IOSurface exhaustion,
// wedged command buffer) — hot-retrying every tick makes that worse, so
// failures push the next attempt out exponentially. Pure so it unit-tests
// without a webview.

export const INITIAL_BACKOFF_MS = 10_000
export const MAX_BACKOFF_MS = 5 * 60_000

export interface CaptureBackoff {
  /** Consecutive failed captures; 0 = healthy. */
  failures: number
  /** Epoch ms before which no capture may run; 0 = unrestricted. */
  notBefore: number
}

export const initialBackoff: CaptureBackoff = { failures: 0, notBefore: 0 }

/** True when a capture may run at `now`. */
export function canCapture(state: CaptureBackoff, now: number): boolean {
  return now >= state.notBefore
}

/** A capture succeeded — the GPU path is healthy again, drop all backoff. */
export function recordSuccess(): CaptureBackoff {
  return initialBackoff
}

/** A capture failed — 10s after the first failure, doubling to a 5min cap. */
export function recordFailure(state: CaptureBackoff, now: number): CaptureBackoff {
  const failures = state.failures + 1
  const delay = Math.min(INITIAL_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS)
  return { failures, notBefore: now + delay }
}
