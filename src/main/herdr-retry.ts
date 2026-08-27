/**
 * herdr can surface macOS EAGAIN (os error 35) when several clients contend
 * for its socket. The server and panes are still alive; callers that only read
 * state may retry after a short backoff instead of treating that sample as a
 * dead server.
 */
const TRANSIENT_HERDR_ERROR =
  /os error 35|temporarily unavailable|resource temporarily|\beagain\b/i

export function isTransientHerdrError(error: unknown): boolean {
  const candidate = error as
    | { code?: unknown; stderr?: unknown; stdout?: unknown; message?: unknown }
    | null
  if (candidate?.code === 'EAGAIN') return true
  return TRANSIENT_HERDR_ERROR.test(
    `${String(candidate?.stderr ?? '')} ${String(candidate?.stdout ?? '')} ${String(candidate?.message ?? '')}`
  )
}

const RETRY_SLEEP_LATCH = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(RETRY_SLEEP_LATCH, 0, 0, ms)
}

/** Retry only a transient herdr EAGAIN, with a short bounded backoff. */
export function runWithHerdrRetry<T>(run: () => T, attempts = 4): T {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return run()
    } catch (error) {
      lastError = error
      if (attempt === attempts - 1 || !isTransientHerdrError(error)) throw error
      sleepSync(25 * (attempt + 1))
    }
  }
  throw lastError
}
