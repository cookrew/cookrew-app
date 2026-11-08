import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import type { AccountResult } from '../shared/account-v2'
import { OAUTH_SCHEME_HOST } from '../shared/oauth'
import { listenForReturn, type LoopbackListener } from './oauth-loopback'

/**
 * ONE BROWSER TRIP AT A TIME, whoever sent the browser out.
 *
 * Two kinds of trip leave this app: a provider's own page (account-oauth.ts)
 * and the one sign-in page, auth.cookrew.dev (account-browser-auth.ts). Both
 * come back the same way, `cookrew://oauth#…` or the loopback listener, and
 * both must be ended by the same Cancel, the same lock and the same second
 * press. So the slot, the state check, the clock and the cancel count live
 * here once, and both flows hold the same instance.
 *
 * WHAT COMES BACK IS NOT TRUSTED. A return whose state this process did not
 * mint is dropped, and the code or handoff it carries is worth nothing without
 * a verifier that never crossed the browser.
 */

/** Long enough to find a password manager; a forgotten tab must not wait for ever. */
export const TRIP_WAIT_MS = 5 * 60 * 1000

/** How a trip ended. `code` is the sign-in page's, `handoff` a provider's. */
export type Returned = { handoff: string } | { code: string } | { error: string } | { over: 'cancelled' | 'timeout' }

/** The fields of a return. `code` is present only when the return carried one. */
export interface ReturnFields {
  handoff: string | null
  error: string | null
  state: string
  code?: string
}

/** Where the browser goes back to, as the registry is told it. No URL, on purpose. */
export interface TripBack {
  scheme: boolean
  port?: number
}

interface Trip {
  state: string
  settled: boolean
  settle: (returned: Returned) => void
}

/** The one shape a return may have, or null. Never throws. */
export function parseOAuthReturn(raw: string): ReturnFields | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'cookrew:' || url.hostname !== OAUTH_SCHEME_HOST) return null
  if (url.username || url.password || url.search.length > 0) return null
  if (url.pathname !== '' && url.pathname !== '/') return null
  return readReturnFields(new URLSearchParams(url.hash.replace(/^#/, '')))
}

/** Exactly one of handoff, code and error, beside a state. */
export function readReturnFields(fields: URLSearchParams): ReturnFields | null {
  const state = fields.get('state')
  const handoff = fields.get('handoff')
  const code = fields.get('code')
  const error = fields.get('error')
  const carried = [handoff, code, error].filter((value) => value !== null).length
  if (state === null || state === '' || carried !== 1) return null
  return { handoff, error, state, ...(code === null ? {} : { code }) }
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost'])

/**
 * Only somewhere a browser should go. A bad registry answer must not reach
 * `openExternal`: https anywhere, plain http only on this machine (local QA
 * runs the page at http://auth.localhost:<port>).
 */
export function safeToOpen(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  try {
    const url = new URL(raw)
    if (url.username !== '' || url.password !== '') return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && (LOCAL_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost'))
  } catch {
    return false
  }
}

export interface TripPort {
  openBrowser: (url: string) => Promise<void> | void
  schemeHandled: () => boolean
}

export class Trips {
  private readonly port: TripPort
  private trip: Trip | null = null
  /** Waits that are not browser trips (a terminal's poll), ended by the same cancel. */
  private readonly held = new Set<() => void>()
  /** How many cancels there have been. An act remembers the one it began under. */
  private cancels = 0
  private readonly act = new AsyncLocalStorage<number>()

  constructor(port: TripPort) {
    this.port = port
  }

  /** A trip or a held wait ended by the person. True when there was one. */
  cancel(): boolean {
    const running = this.trip !== null || this.held.size > 0
    this.cancels += 1
    this.trip?.settle({ over: 'cancelled' })
    for (const stop of [...this.held]) stop()
    return running
  }

  /** One act, however many trips it takes. A cancel anywhere in it ends it. */
  during<T>(run: () => Promise<T>): Promise<T> {
    if (this.act.getStore() !== undefined) return run()
    this.cancel()
    return this.act.run(this.cancels, run)
  }

  /** Has the act this code is running in been cancelled? */
  ended(): boolean {
    const began = this.act.getStore()
    return began !== undefined && began !== this.cancels
  }

  /** A browser is out. The idle clock waits for it. */
  tripping(): boolean {
    return this.trip !== null
  }

  /** A wait the next cancel must end. Answers the release. */
  hold(stop: () => void): () => void {
    this.held.add(stop)
    return () => {
      this.held.delete(stop)
    }
  }

  /** A `cookrew://oauth#…` link arrived. True when it belonged to this trip. */
  arrive(raw: string): boolean {
    const fields = parseOAuthReturn(raw)
    return fields !== null && this.accept(fields)
  }

  private accept(fields: ReturnFields): boolean {
    const trip = this.trip
    // A return this process did not start is dropped here: that is what stops
    // a stranger's link signing this Mac in to the stranger's account.
    if (trip === null || fields.state !== trip.state) return false
    if (fields.code !== undefined) trip.settle({ code: fields.code })
    else if (fields.handoff !== null) trip.settle({ handoff: fields.handoff })
    else trip.settle({ error: fields.error ?? 'provider' })
    return true
  }

  /**
   * THE BROWSER ROUND TRIP. `start` is told the state and the way back, asks the
   * registry, and answers the URL to open. What comes back is how the trip
   * ended, which the caller reads; a refusal from `start` is passed through.
   */
  async travel(
    start: (state: string, back: TripBack) => Promise<AccountResult<string>>,
  ): Promise<AccountResult<Returned>> {
    if (this.ended()) return { ok: false, reason: 'cancelled' }
    const state = randomBytes(32).toString('base64url')
    const { trip, returned } = this.begin(state)
    let listener: LoopbackListener | null = null
    try {
      listener = await listenForReturn((query) => {
        const fields = readReturnFields(query)
        return fields !== null && this.accept(fields)
      })
      const handled = this.port.schemeHandled()
      const back: TripBack = {
        scheme: handled || listener === null,
        ...(listener === null ? {} : { port: listener.port }),
      }
      const started = await start(state, back)
      // Ended while the registry was being asked: the browser never opens.
      if (trip.settled) return { ok: true, value: await returned }
      if (!started.ok) return started
      const url = started.value
      if (!safeToOpen(url)) return { ok: false, reason: 'unknown' }
      Promise.resolve()
        .then(() => this.port.openBrowser(url))
        .catch(() => trip.settle({ error: 'provider' }))
      return { ok: true, value: await returned }
    } finally {
      // Every way out ends the trip; settling twice is nothing.
      trip.settle({ over: 'cancelled' })
      listener?.close()
    }
  }

  /** Registered at once, ending the one before. Its timer can only end itself. */
  private begin(state: string): { trip: Trip; returned: Promise<Returned> } {
    this.trip?.settle({ over: 'cancelled' })
    let trip: Trip | null = null
    const returned = new Promise<Returned>((resolve) => {
      const held: Trip = {
        state,
        settled: false,
        settle: (answer) => {
          if (held.settled) return
          held.settled = true
          clearTimeout(timer)
          if (this.trip === held) this.trip = null
          resolve(answer)
        },
      }
      const timer = setTimeout(() => held.settle({ over: 'timeout' }), TRIP_WAIT_MS)
      timer.unref()
      trip = held
    })
    this.trip = trip
    return { trip: trip as unknown as Trip, returned }
  }
}
