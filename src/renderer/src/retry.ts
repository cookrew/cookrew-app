/**
 * Retry a fetch that the canvas cannot do without.
 *
 * The remote canvas asks for its workspace ONCE at boot. A phone boots at the
 * worst possible moment — screen just unlocked, Wi-Fi/tailnet still coming up,
 * desktop app mid-restart — and that single miss left the canvas empty with
 * nothing scheduled to ask again.
 */
export interface RetryOptions {
  /** Delay before each successive attempt; the last value repeats. */
  delaysMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
  /**
   * Whether a failure is worth another attempt. Default: everything except an
   * unpaired/expired credential, which no amount of retrying fixes — that has
   * its own screen.
   */
  retryable?: (error: unknown) => boolean
}

const DEFAULT_DELAYS = [500, 1500, 3000, 6000] as const

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const notAuthFailure = (error: unknown): boolean =>
  (error as { name?: string } | null)?.name !== 'AuthError'

/**
 * Run `attempt` until it resolves or the delays run out; rethrows the last
 * failure. One attempt per delay plus the first, so the default is 5 tries
 * over ~11s.
 */
export async function retry<T>(attempt: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const delays = options.delaysMs ?? DEFAULT_DELAYS
  const sleep = options.sleep ?? defaultSleep
  const retryable = options.retryable ?? notAuthFailure
  let last: unknown
  for (let i = 0; i <= delays.length; i += 1) {
    try {
      return await attempt()
    } catch (error) {
      last = error
      if (i === delays.length || !retryable(error)) throw error
      await sleep(delays[i])
    }
  }
  throw last
}
