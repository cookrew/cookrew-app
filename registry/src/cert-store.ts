import { X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * WHAT WE HOLD FOR EACH MAC: a chain, an order in flight, or a reason it failed.
 *
 * Two halves with deliberately different lifetimes.
 *
 * THE CHAIN IS PERSISTED. A certificate survives a rollout — it is public
 * anyway (it is in the CT logs the moment it is issued) and losing it would
 * mean asking Let's Encrypt for another one against a 50-a-week ceiling.
 *
 * THE CHALLENGE TABLE IS NOT. A dns-01 digest is only meaningful while the
 * order that produced it is in flight, and an order does not survive this
 * process: the client holding it dies with the pod. A TXT record that outlived
 * its order would be a name answering a question nobody will ever ask again,
 * so it lives in memory and dies with the thing it belongs to. The Mac simply
 * asks again.
 *
 * THE RATE LEDGER IS PERSISTED, because it exists precisely to survive the
 * restart that would otherwise reset it. Let's Encrypt's own limits are per
 * account and per week; ours are tighter and per device, so a single Mac in a
 * retry loop cannot spend the account's whole allowance.
 */

const FILE = 'certs.json'
/** Renew from 30 days out — the window the reach design names. */
export const RENEW_WITHIN_MS = 30 * 24 * 60 * 60 * 1000
export const ORDERS_PER_HOUR = 1
export const ORDERS_PER_DAY = 5
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
/** An order that never settled must not hold the door shut for ever. */
export const IN_FLIGHT_MAX_MS = 5 * 60 * 1000

export interface IssuedCert {
  /** Leaf first, then its issuers, PEM. */
  chain: string
  /** Epoch ms — read out of the leaf, never taken from the CA's word for it. */
  notAfter: number
  issuedAt: number
}

export type CertState =
  | { status: 'none' }
  | { status: 'pending'; order: string; startedAt: number }
  | { status: 'issued'; chain: string; notAfter: number }
  | { status: 'failed'; reason: string; at: number }

interface DeviceRecord {
  issued?: IssuedCert
  failure?: { reason: string; at: number }
  /** Epoch ms of each order STARTED, for the rate ledger. Pruned to a day. */
  orders: number[]
}

interface Persisted {
  version: 1
  devices: Record<string, DeviceRecord>
}

/** When the leaf stops being valid, or null when it is not a certificate. */
export function notAfterOf(chain: string): number | null {
  try {
    const at = new X509Certificate(chain).validTo
    const ms = Date.parse(at)
    return Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}

export class CertStore {
  private readonly file: string
  private devices: Record<string, DeviceRecord> = {}
  /** deviceId → the digests standing for it right now. Memory only, on purpose. */
  private readonly challenges = new Map<string, readonly string[]>()
  /** deviceId → the order id in flight. Memory only, for the same reason. */
  private readonly inFlight = new Map<string, { order: string; startedAt: number }>()
  private changed: number

  constructor(
    base: string,
    private readonly now: () => number = Date.now,
    /** Operational notes. Never a chain, never a device id. */
    private readonly note: (message: string) => void = () => undefined
  ) {
    mkdirSync(base, { recursive: true })
    this.file = path.join(base, FILE)
    this.changed = this.now()
    if (existsSync(this.file)) {
      try {
        const held = JSON.parse(readFileSync(this.file, 'utf8')) as Persisted
        if (held.version === 1 && typeof held.devices === 'object' && held.devices !== null) {
          this.devices = held.devices
        }
      } catch {
        // A torn file loses the chains, not the process. Every Mac asks again,
        // which is a rate-limit cost and never a wrong answer.
        this.devices = {}
      }
    }
  }

  /**
   * WRITE-THROUGH, AND A FAILURE TO WRITE IS NOT A FAILURE TO SERVE.
   *
   * The in-memory state is already correct by the time this runs; the file is
   * how it survives a rollout. A full volume, a read-only mount or a directory
   * that vanished under a test must therefore be a line in the log — a throw
   * here escapes into the background order that called it and takes the whole
   * process down as an unhandled rejection, which is a far worse outcome than
   * a chain that has to be ordered again after a restart.
   */
  private save(): void {
    try {
      const body: Persisted = { version: 1, devices: this.devices }
      const temporary = `${this.file}.tmp`
      writeFileSync(temporary, JSON.stringify(body), { mode: 0o600 })
      renameSync(temporary, this.file)
    } catch {
      this.note('certs: the certificate store could not be written')
    }
  }

  private record(deviceId: string): DeviceRecord {
    return this.devices[deviceId] ?? { orders: [] }
  }

  /** Epoch ms of the last change to anything this store answers with. */
  changedAt(): number {
    return this.changed
  }

  private touch(): void {
    this.changed = this.now()
  }

  // ── what a Mac has ─────────────────────────────────────────────────────

  issued(deviceId: string): IssuedCert | null {
    const held = this.devices[deviceId]?.issued
    return held === undefined || held.notAfter <= this.now() ? null : held
  }

  /** True while a live certificate exists — the `names` bit on a reach card. */
  hasNames(deviceId: string): boolean {
    return this.issued(deviceId) !== null
  }

  /** A chain still far enough from expiry that a new order would be waste. */
  fresh(deviceId: string): IssuedCert | null {
    const held = this.issued(deviceId)
    return held !== null && held.notAfter - this.now() > RENEW_WITHIN_MS ? held : null
  }

  state(deviceId: string): CertState {
    const flight = this.flight(deviceId)
    if (flight !== null) return { status: 'pending', order: flight.order, startedAt: flight.startedAt }
    const held = this.issued(deviceId)
    if (held !== null) return { status: 'issued', chain: held.chain, notAfter: held.notAfter }
    const failure = this.devices[deviceId]?.failure
    if (failure !== undefined) return { status: 'failed', reason: failure.reason, at: failure.at }
    return { status: 'none' }
  }

  private flight(deviceId: string): { order: string; startedAt: number } | null {
    const held = this.inFlight.get(deviceId)
    if (held === undefined) return null
    // An order whose client died mid-flight would otherwise answer 409 for
    // ever, and the Mac would never be able to ask again.
    if (this.now() - held.startedAt > IN_FLIGHT_MAX_MS) {
      this.inFlight.delete(deviceId)
      return null
    }
    return held
  }

  // ── ordering ───────────────────────────────────────────────────────────

  /** May this Mac start an order now, and if not, in how long. */
  mayOrder(deviceId: string): { ok: true } | { ok: false; retryAfter: number } {
    const at = this.now()
    const recent = this.record(deviceId).orders.filter((one) => at - one < DAY_MS)
    const hour = recent.filter((one) => at - one < HOUR_MS)
    if (hour.length >= ORDERS_PER_HOUR) {
      return { ok: false, retryAfter: Math.ceil((HOUR_MS - (at - Math.min(...hour))) / 1000) }
    }
    if (recent.length >= ORDERS_PER_DAY) {
      return { ok: false, retryAfter: Math.ceil((DAY_MS - (at - Math.min(...recent))) / 1000) }
    }
    return { ok: true }
  }

  /** Records the attempt against the ledger and marks the device in flight. */
  beginOrder(deviceId: string, order: string): void {
    const at = this.now()
    const held = this.record(deviceId)
    this.devices = {
      ...this.devices,
      [deviceId]: { ...held, orders: [...held.orders.filter((one) => at - one < DAY_MS), at] }
    }
    this.inFlight.set(deviceId, { order, startedAt: at })
    this.save()
    this.touch()
  }

  /** The chain, checked against its own notAfter before it is believed. */
  settle(deviceId: string, chain: string): IssuedCert | null {
    const notAfter = notAfterOf(chain)
    if (notAfter === null) {
      this.fail(deviceId, 'the CA answered something that is not a certificate')
      return null
    }
    const issued: IssuedCert = { chain, notAfter, issuedAt: this.now() }
    const held = this.record(deviceId)
    this.devices = { ...this.devices, [deviceId]: { orders: held.orders, issued } }
    this.inFlight.delete(deviceId)
    this.challenges.delete(deviceId)
    this.save()
    this.touch()
    return issued
  }

  fail(deviceId: string, reason: string): void {
    const held = this.record(deviceId)
    this.devices = {
      ...this.devices,
      [deviceId]: { ...held, failure: { reason, at: this.now() } }
    }
    this.inFlight.delete(deviceId)
    this.challenges.delete(deviceId)
    this.save()
    this.touch()
  }

  // ── the challenge table the zone reads ─────────────────────────────────

  publish(deviceId: string, digests: readonly string[]): void {
    this.challenges.set(deviceId, [...digests])
    this.touch()
  }

  retract(deviceId: string): void {
    this.challenges.delete(deviceId)
    this.touch()
  }

  textsFor(deviceId: string): readonly string[] {
    return this.challenges.get(deviceId) ?? []
  }
}
