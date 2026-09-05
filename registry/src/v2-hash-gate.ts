/**
 * A CEILING ON PASSWORD STRETCHING.
 *
 * scrypt at N=2^15 is deliberately expensive, and node runs it on the same
 * libuv threadpool the rest of the process shares. This registry is not only
 * a login form: it holds the downlink of every door being served. So an
 * unauthenticated route that spends a hash is a route through which a stranger
 * can decide how much of this process's capacity is theirs.
 *
 * Two bounds, both global to the process because the thing being protected is:
 *
 *   IN FLIGHT  at most four hashes at once — the size of the default
 *              threadpool, so the fifth would have been queued by libuv
 *              anyway, invisibly and without a limit.
 *   QUEUED     past a short queue the honest answer is 503 with a retry-after.
 *              A request that waits thirty seconds for a hash has already
 *              failed; saying so is better than making the caller find out.
 */
export class HashGate {
  private readonly inFlight: number
  private readonly queueMax: number
  private running = 0
  private waiting: (() => void)[] = []

  constructor(inFlight = 4, queueMax = 32) {
    this.inFlight = inFlight
    this.queueMax = queueMax
  }

  /** True when the queue is longer than this gate will hold. Ask before entering. */
  get overloaded(): boolean {
    return this.waiting.length > this.queueMax
  }

  /** How many are being stretched right now — for the tests, and for a log line. */
  get active(): number {
    return this.running
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.inFlight) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.running += 1
    try {
      return await work()
    } finally {
      this.running -= 1
      const next = this.waiting.shift()
      if (next) next()
    }
  }
}

/**
 * The one gate the password routes share. A per-deployment instance would be
 * a per-deployment ceiling on a process-wide resource, which is not the thing
 * that needs bounding.
 */
export const passwordGate = new HashGate()
