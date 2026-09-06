// The circuit breaker in front of Sous (the local title model).
//
// Ollama can be up and still unable to answer inside the request budget —
// a machine at load 70-120 per ten cores was the case that made this exist.
// Without a breaker every title refresh and every backfill tick started a
// request that held an Ollama generate slot for the whole timeout, died,
// logged a line, and was retried by the next tick: a storm that fed the
// load it was failing under. The breaker turns that into a bounded number
// of probes on a widening schedule, one log line when it opens and one when
// it closes, and a state the health route can show.

/** How a guarded attempt ended: the value, or why the server did not answer. */
export type SousAttempt<T> = { ok: true; value: T } | { ok: false; reason: string }

/** What a caller may expect right now, so it can pick its own retry delay. */
export type SousReadiness = 'ready' | 'busy' | 'open'

export interface SousBreakerOptions {
  /** Consecutive failures that open the breaker. */
  threshold?: number
  /** Open windows per consecutive trip; past the last, `capMs`. */
  windowsMs?: readonly number[]
  capMs?: number
  /** Requests admitted at once while closed; the rest are refused at once. */
  maxInFlight?: number
  /** A half-open probe that has not settled by then no longer blocks the next. */
  probeTimeoutMs?: number
  now?: () => number
  /** Where the open and close lines go. */
  log?: (line: string) => void
}

export interface SousBreakerState {
  state: 'closed' | 'open' | 'half-open'
  consecutiveFailures: number
  inFlight: number
  openedAt: number | null
  openUntil: number | null
  windowMs: number | null
  /** Times the breaker opened since start. */
  trips: number
  /** Calls answered null without a request. */
  refused: number
  /** Requests admitted. */
  requests: number
  /** Redacted and clamped: never a URL, never a credential. */
  lastFailure: string | null
  lastFailureAt: number | null
  lastSuccessAt: number | null
}

export interface SousBreaker {
  /** Would a call be admitted right now, and if not, why? Read-only. */
  readiness(): SousReadiness
  /** Run `attempt` if admitted; null without a request otherwise. */
  guard<T>(attempt: () => Promise<SousAttempt<T>>): Promise<T | null>
  state(): SousBreakerState
}

export const SOUS_BREAKER_THRESHOLD = 3
export const SOUS_BREAKER_WINDOWS_MS = [30_000, 120_000, 600_000] as const
export const SOUS_BREAKER_CAP_MS = 1_800_000
export const SOUS_BREAKER_MAX_IN_FLIGHT = 2
/** Twice the cold request budget: a probe cannot legitimately outlive it. */
export const SOUS_BREAKER_PROBE_TIMEOUT_MS = 60_000
const REASON_MAX_CHARS = 160

/**
 * A failure reason as it may be logged and served on /api/health: no URL
 * (a Sous URL may carry credentials), no credential form, and short.
 */
export function redactReason(reason: string): string {
  return reason
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
    .replace(/\/\/[^@\s/]+@/g, '//<redacted>@')
    .slice(0, REASON_MAX_CHARS)
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = (error as { cause?: { code?: string } }).cause
  const code = cause && typeof cause.code === 'string' ? ` (${cause.code})` : ''
  return `${error.name}: ${error.message}${code}`
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms - minutes * 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

class Breaker implements SousBreaker {
  private readonly threshold: number
  private readonly windows: readonly number[]
  private readonly capMs: number
  private readonly maxInFlight: number
  private readonly probeTimeoutMs: number
  private readonly now: () => number
  private readonly log: (line: string) => void

  private phase: SousBreakerState['state'] = 'closed'
  private consecutiveFailures = 0
  private inFlight = 0
  private openedAt: number | null = null
  private openUntil: number | null = null
  private windowMs: number | null = null
  private probeStartedAt: number | null = null
  /** Consecutive trips without a success in between: the rung of the ladder. */
  private rung = 0
  /**
   * Bumped on every open and close. A request admitted in an earlier epoch
   * is a straggler: it says nothing about the world after the trip, so its
   * outcome adjusts the in-flight count and the diagnostics, and no state.
   */
  private epoch = 0
  private trips = 0
  private refused = 0
  private requests = 0
  private lastFailure: string | null = null
  private lastFailureAt: number | null = null
  private lastSuccessAt: number | null = null

  constructor(options: SousBreakerOptions) {
    this.threshold = options.threshold ?? SOUS_BREAKER_THRESHOLD
    this.windows = options.windowsMs ?? SOUS_BREAKER_WINDOWS_MS
    this.capMs = options.capMs ?? SOUS_BREAKER_CAP_MS
    this.maxInFlight = options.maxInFlight ?? SOUS_BREAKER_MAX_IN_FLIGHT
    this.probeTimeoutMs = options.probeTimeoutMs ?? SOUS_BREAKER_PROBE_TIMEOUT_MS
    this.now = options.now ?? (() => Date.now())
    this.log = options.log ?? ((line: string) => console.error(line))
  }

  readiness(): SousReadiness {
    if (this.phase === 'closed') return this.inFlight < this.maxInFlight ? 'ready' : 'busy'
    if (this.phase === 'half-open') {
      const probeExpired = this.probeStartedAt !== null && this.now() - this.probeStartedAt >= this.probeTimeoutMs
      return probeExpired ? 'ready' : 'open'
    }
    return this.openUntil !== null && this.now() >= this.openUntil ? 'ready' : 'open'
  }

  state(): SousBreakerState {
    return {
      state: this.phase,
      consecutiveFailures: this.consecutiveFailures,
      inFlight: this.inFlight,
      openedAt: this.openedAt,
      openUntil: this.openUntil,
      windowMs: this.windowMs,
      trips: this.trips,
      refused: this.refused,
      requests: this.requests,
      lastFailure: this.lastFailure,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt
    }
  }

  async guard<T>(attempt: () => Promise<SousAttempt<T>>): Promise<T | null> {
    const admitted = this.admit()
    if (admitted === null) return null
    try {
      const outcome = await attempt()
      if (outcome.ok) {
        this.success(admitted)
        return outcome.value
      }
      this.failure(admitted, outcome.reason)
      return null
    } catch (error) {
      this.failure(admitted, describeError(error))
      return null
    }
  }

  /** Admit one call and return its epoch; a call admitted from 'open' is the window's single probe. */
  private admit(): number | null {
    if (this.readiness() !== 'ready') {
      this.refused += 1
      return null
    }
    if (this.phase !== 'closed') {
      this.phase = 'half-open'
      this.probeStartedAt = this.now()
    }
    this.inFlight += 1
    this.requests += 1
    return this.epoch
  }

  private success(epoch: number): void {
    this.inFlight -= 1
    this.lastSuccessAt = this.now()
    if (epoch !== this.epoch) return
    this.consecutiveFailures = 0
    if (this.phase !== 'closed') this.close()
  }

  private failure(epoch: number, reason: string): void {
    this.inFlight -= 1
    this.lastFailure = redactReason(reason)
    this.lastFailureAt = this.now()
    if (epoch !== this.epoch) return
    this.consecutiveFailures += 1
    if (this.phase === 'half-open') {
      this.open(true) // the probe failed: next rung
      return
    }
    if (this.phase === 'closed' && this.consecutiveFailures >= this.threshold) this.open(false)
  }

  private open(probeFailed: boolean): void {
    const at = this.now()
    this.windowMs = this.rung < this.windows.length ? this.windows[this.rung] : this.capMs
    this.rung += 1
    this.trips += 1
    this.epoch += 1
    this.phase = 'open'
    this.probeStartedAt = null
    this.openedAt = probeFailed && this.openedAt !== null ? this.openedAt : at
    this.openUntil = at + this.windowMs
    const held = formatDuration(this.windowMs)
    this.log(
      probeFailed
        ? `Sous: probe failed (${this.lastFailure}); circuit stays open for ${held}`
        : `Sous: circuit open after ${this.threshold} consecutive failures (${this.lastFailure}); no title requests for ${held}`
    )
  }

  private close(): void {
    const heldFor = this.openedAt === null ? 0 : this.now() - this.openedAt
    this.phase = 'closed'
    this.rung = 0
    this.epoch += 1
    this.openedAt = null
    this.openUntil = null
    this.windowMs = null
    this.probeStartedAt = null
    this.log(`Sous: circuit closed after ${formatDuration(heldFor)}; titles resume`)
  }
}

export function createSousBreaker(options: SousBreakerOptions = {}): SousBreaker {
  return new Breaker(options)
}
