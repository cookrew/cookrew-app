/**
 * WHERE "TRY AGAIN" IS WIRED, AND WHY IT IS A GATE RATHER THAN AN IMPORT.
 *
 * The race lives inside the switcher's closure on purpose: its one-at-a-time
 * guard is the thing that stops three events landing together from tripling
 * the probes, and a second caller reaching past it would be exactly the bug
 * that guard exists to prevent. So the switcher OFFERS a retry the way it
 * offers the local-network ask (local-network-gate.ts), and the panel presses
 * it. Same shape, same reason: React reads it and a race loop writes it.
 *
 * THE PRESS WAITS FOR THE RACE IT ASKED FOR. A retry that returned
 * immediately would leave the button looking done while the probes were still
 * out, and the whole point of the button is to be the one thing on that panel
 * a reader can do. The handler resolves when the race settles — including the
 * case where a race was already in flight and this press simply joined it.
 *
 * NOTHING IS OFFERED BEFORE THE SWITCHER STARTS, which is the honest state on
 * a desktop that never races: `retryPath` is then a no-op rather than a button
 * that pretends.
 */

type RetryHandler = () => Promise<void>

let retry: RetryHandler | null = null

/** True once the switcher has a race to re-run. */
export const pathRetryOffered = (): boolean => retry !== null

/** Register the retry for the life of the switcher; call the result to drop it. */
export const offerPathRetry = (handler: RetryHandler): (() => void) => {
  retry = handler
  return () => {
    if (retry === handler) retry = null
  }
}

/**
 * The reader pressed TRY AGAIN. Resolves when the race has settled.
 *
 * A rejection is swallowed like the local-network ask's: the handler's whole
 * job is to update the stores the panel is already watching, so a failure has
 * been recorded as whatever those stores now say, and there is nothing a
 * caller could usefully do with the error except draw it twice.
 */
export const retryPath = async (): Promise<void> => {
  const handler = retry
  if (!handler) return
  try {
    await handler()
  } catch {
    // Left as whatever the last race published.
  }
}

/** Test seam: the module is a singleton and a test needs a clean one. */
export const resetPathRetryGate = (): void => {
  retry = null
}
