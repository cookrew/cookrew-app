import { buildCsr } from './csr-build'
import type { HeldCert, NameCertStore } from './name-cert-store'
import { DEFAULT_NAME_ZONE, wildcardFor } from '../shared/reach-names'

/**
 * ASKING cookrew.dev FOR A REAL CERTIFICATE, AND KNOWING WHEN NOT TO.
 *
 * The registry runs ACME against Let's Encrypt on this Mac's behalf and hands
 * back a chain for `*.<deviceId>.<zone>` (registry/src/v2-cert-routes.ts). The
 * private key is made here and stays here; what travels is a request and a
 * chain, neither of which is worth stealing.
 *
 * THE STATE MACHINE IS SMALL BECAUSE THE COST IS NOT.
 *
 *   ORDER ONLY WHEN THERE IS SOMETHING TO ORDER. An account with a live
 *   session, a device id, and no held chain with more than 30 days left. A
 *   Mac that asks again because it forgot to look spends one of the account's
 *   50 certificates a week, and the registry counts new certificates rather
 *   than requests — so "ask and see" is not free the way an idempotent GET is.
 *
 *   503 names_disabled IS AN ANSWER, NOT AN ERROR. A registry without a DNS
 *   zone has not lost the route, it has not been given a zone to certify names
 *   in. So: say it once, stop for a day, and keep serving the self-signed
 *   certificate — which is exactly what this Mac did before names existed.
 *
 *   429 IS THE CA'S CLOCK, NOT OURS. `retry-after` is honoured verbatim; a
 *   backoff of our own invention would be a second opinion about a limit only
 *   the registry can see.
 *
 * NOTHING HERE IS FATAL. Every failure is a log line and a self-signed
 * certificate — the state the app has always been in. A Mac whose owner is
 * offline, whose session expired, or whose registry is down must still open.
 */

/** Renew with a month to spare: the design's number, and the registry's. */
export const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000
/** How often to look. An order takes seconds; an expiry takes months. */
export const CHECK_EVERY_MS = 60 * 60 * 1000
/** After a refusal that will not change today. */
export const QUIET_MS = 24 * 60 * 60 * 1000
/** Polls of a pending order, and the gaps between them. */
export const POLL_BACKOFF_MS = [2_000, 3_000, 5_000, 8_000, 13_000, 21_000, 30_000, 30_000] as const

export type CertOutcome =
  | 'held'
  | 'issued'
  | 'pending'
  | 'skipped'
  | 'disabled'
  | 'rate_limited'
  | 'refused'
  | 'offline'
  | 'failed'

/**
 * One authenticated call to the registry — exactly `Accounts.authedResponse`.
 * Taken as a function so this file holds no session, no token and no origin.
 */
export type AuthedFetch = (
  pathname: string,
  init?: { method?: string; body?: string }
) => Promise<{ ok: true; response: Response } | { ok: false; reason: string }>

export interface DesktopCertDeps {
  readonly store: NameCertStore
  readonly fetch: AuthedFetch
  /** This Mac's device id at the registry, or null when it has no account. */
  readonly deviceId: () => string | null
  readonly zone?: string
  readonly now?: () => number
  readonly log?: (message: string) => void
  /** Test seams: the sleep between polls and the renewal timer. */
  readonly wait?: (ms: number) => Promise<void>
  readonly pollBackoffMs?: readonly number[]
  readonly setInterval?: (fn: () => void, ms: number) => { unref?: () => void }
  readonly clearInterval?: (handle: unknown) => void
}

export interface DesktopCert {
  /** The chain to serve for this Mac's names, or null. Read per handshake. */
  readonly held: () => HeldCert | null
  /** The one name a certificate here may cover, or null without an account. */
  readonly wildcard: () => string | null
  /**
   * The device id and zone to SPELL names with — null unless a valid chain is
   * held right now. One reader for "may this Mac print a trusted URL", so the
   * printed name, the published `trusted` list, the CORS allow-list and the
   * SNI answer can never disagree about whether a certificate exists.
   */
  readonly naming: () => { deviceId: string; zone: string } | null
  /** One pass. Never throws; the outcome is the whole report. */
  readonly ensure: (reason: string) => Promise<CertOutcome>
  /** Check hourly, order at thirty days left. Returns the stop function. */
  readonly watch: () => () => void
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The registry's answers, as this file needs to read them. */
type CertBody = {
  status?: unknown
  chain?: unknown
  notAfter?: unknown
  order?: unknown
  reason?: unknown
  error?: unknown
  detail?: unknown
}

const bodyOf = async (response: Response): Promise<CertBody> => {
  try {
    const parsed: unknown = await response.json()
    return typeof parsed === 'object' && parsed !== null ? (parsed as CertBody) : {}
  } catch {
    return {}
  }
}

/** `retry-after` in seconds, clamped to something a running app can wait for. */
const retryAfterMs = (response: Response): number => {
  const raw = Number(response.headers.get('retry-after'))
  if (!Number.isFinite(raw) || raw <= 0) return QUIET_MS
  return Math.min(Math.floor(raw) * 1000, QUIET_MS)
}

export function createDesktopCert(deps: DesktopCertDeps): DesktopCert {
  const now = deps.now ?? Date.now
  const note = deps.log ?? ((): void => undefined)
  const pause = deps.wait ?? sleep
  const backoff = deps.pollBackoffMs ?? POLL_BACKOFF_MS
  const zone = deps.zone ?? DEFAULT_NAME_ZONE
  let current: HeldCert | null = null
  /** Nothing will change before this moment, so do not ask again until it. */
  let quietUntil = 0
  /** The last refusal SAID OUT LOUD, so a daily loop is not a log flood. */
  let announced: string | null = null
  let running = false

  const wildcard = (): string | null => {
    const id = deps.deviceId()
    return id === null ? null : wildcardFor(id, zone)
  }

  const sayOnce = (message: string): void => {
    if (announced === message) return
    announced = message
    note(message)
  }

  const quiet = (ms: number): void => {
    quietUntil = now() + ms
  }

  /** Adopt a chain the registry answered with, or say why it was unusable. */
  const take = (chain: unknown, name: string): CertOutcome => {
    const saved = deps.store.save(chain, name, now())
    if (saved === null) {
      sayOnce('names: the certificate cookrew.dev answered with is not this Mac’s — ignored')
      quiet(QUIET_MS)
      return 'failed'
    }
    current = saved
    announced = null
    quietUntil = 0
    note(`names: a certificate for ${name} is held until ${new Date(saved.notAfter).toISOString()}`)
    return 'issued'
  }

  const poll = async (name: string): Promise<CertOutcome> => {
    const path = `/v2/me/desktops/${encodeURIComponent(deps.deviceId() ?? '')}/cert`
    for (const wait of backoff) {
      await pause(wait)
      const sent = await deps.fetch(path)
      if (!sent.ok) return 'offline'
      const response = sent.response
      // The order is simply gone — the next hourly pass starts a new one.
      if (response.status === 404) return 'failed'
      if (!response.ok) return 'failed'
      const body = await bodyOf(response)
      if (body.status === 'issued') return take(body.chain, name)
      if (body.status === 'failed') {
        // The ORDER failed, this request did not. The sentence is the only
        // thing that tells the owner whether to fix something or wait.
        sayOnce(`names: cookrew.dev could not issue a certificate (${String(body.reason ?? 'no reason given')})`)
        quiet(QUIET_MS)
        return 'failed'
      }
    }
    // Still pending after the whole ladder: not a failure, just slower than
    // this pass. The hourly check finds it issued and adopts it.
    return 'pending'
  }

  const order = async (name: string, id: string): Promise<CertOutcome> => {
    const csr = buildCsr({
      privateKey: deps.store.key(),
      publicKey: deps.store.publicKey(),
      names: [name]
    })
    const sent = await deps.fetch(`/v2/me/desktops/${encodeURIComponent(id)}/cert`, {
      method: 'POST',
      body: JSON.stringify({ csr })
    })
    if (!sent.ok) return 'offline'
    const response = sent.response
    if (response.status === 503) {
      sayOnce('names: cookrew.dev is not issuing certificates — this Mac keeps its self-signed one')
      quiet(retryAfterMs(response))
      return 'disabled'
    }
    if (response.status === 429) {
      quiet(retryAfterMs(response))
      sayOnce('names: cookrew.dev asked this Mac to wait before ordering again')
      return 'rate_limited'
    }
    if (response.status === 409) return poll(name)
    if (!response.ok) {
      const body = await bodyOf(response)
      const said = `${String(body.error ?? response.status)}${
        typeof body.detail === 'string' ? `: ${body.detail}` : ''
      }`
      // A 5xx is the registry having a bad minute, not a verdict on this
      // request — the hourly check tries again. A 4xx IS a verdict (a CSR it
      // will never accept, a session that is not this desktop's), and asking
      // again inside the hour would only spend the ledger.
      if (response.status >= 500) {
        sayOnce(`names: cookrew.dev could not answer the certificate request (${said})`)
        return 'failed'
      }
      sayOnce(`names: cookrew.dev refused the certificate request (${said})`)
      quiet(QUIET_MS)
      return 'refused'
    }
    const body = await bodyOf(response)
    if (body.status === 'issued') return take(body.chain, name)
    return poll(name)
  }

  const ensure = async (reason: string): Promise<CertOutcome> => {
    // One pass at a time. Two overlapping orders would each see "nothing
    // held", and the registry's in-flight lock would turn the second into a
    // 409 that polls the first — harmless, but it spends a request per hour
    // for no reason.
    if (running) return 'skipped'
    const name = wildcard()
    if (name === null) return 'skipped'
    if (now() < quietUntil) return 'skipped'
    const id = deps.deviceId()
    if (id === null) return 'skipped'
    current = deps.store.held(name, now())
    if (current !== null && current.notAfter - now() > RENEW_BEFORE_MS) return 'held'
    running = true
    try {
      note(`names: asking cookrew.dev for a certificate (${reason})`)
      return await order(name, id)
    } catch (error) {
      // A throw from in here would be an unhandled rejection and a Mac with
      // no certificate; neither is worth taking the app down for.
      note(`names: the certificate order ended unexpectedly (${(error as Error).message})`)
      quiet(QUIET_MS)
      return 'failed'
    } finally {
      running = false
    }
  }

  const held = (): HeldCert | null => {
    const name = wildcard()
    if (name === null) return null
    // Cached rather than re-read: this is called per TLS handshake, and a
    // renewal replaces the cached value the moment it lands.
    if (current !== null && current.wildcard === name && current.notAfter > now()) return current
    current = deps.store.held(name, now())
    return current
  }

  return {
    held,
    wildcard,
    naming: () => {
      const id = deps.deviceId()
      return id === null || held() === null ? null : { deviceId: id, zone }
    },
    ensure,
    watch: () => {
      const start = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
      const stop = deps.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout))
      const handle = start(() => void ensure('renewal check'), CHECK_EVERY_MS)
      handle.unref?.()
      return () => stop(handle)
    }
  }
}
