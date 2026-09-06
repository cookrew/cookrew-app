import { randomUUID } from 'node:crypto'
import type { AcmeClient } from './acme-client'
import { CertStore, type CertState } from './cert-store'
import { readCsr } from './csr-read'
import { createZone, type NameServer, type ReachLookup, type Responder } from './dns-zone'
import type { V2Desktop } from './v2-accounts'

/**
 * NAMES — the DNS zone, the certificate store and the ACME client, wired once.
 *
 * The three files under this each know one thing and nothing about the others:
 * the zone answers questions, the store remembers chains, the client talks to
 * a CA. This is the only place that knows they belong together, which is what
 * lets the route above stay a route and the tests below stay unit tests.
 *
 * THE WHOLE FEATURE IS OPTIONAL. `createNames` is called only when the flags
 * are there; without them nothing listens, no key is written, and the cert
 * routes answer 503. That is the same shape every other half of this registry
 * has (doors, relay, v2) and for the same reason: a deployment that did not
 * ask for something should be byte-identical to one from before it existed.
 */

export interface DesktopLookup {
  /** The desktop with this device id, whoever owns it — or null. */
  find: (deviceId: string) => V2Desktop | null
  /** Epoch ms of the most recent change to any desktop. The SOA serial's half. */
  changedAt: () => number
}

export interface NamesOptions {
  zone: string
  ns: readonly NameServer[]
  dataDir: string
  desktops: DesktopLookup
  acme: AcmeClient
  now?: () => number
  log?: (message: string) => void
  reachTtlMs?: number
  /** New certificates this registry may order in a week, across every Mac. */
  weeklyBudget?: number
  /** How many CA conversations may be in flight at once. */
  concurrency?: number
}

/**
 * AT MOST `width` ORDERS AT ONCE, in the order they were asked for.
 *
 * Nothing above this queues: the route answers 202 and the CA conversation
 * runs behind it, so twenty Macs coming back from a rollout at the same moment
 * were twenty simultaneous ACME orders — twenty sets of TXT records standing
 * in the zone at once, twenty poll loops, and a CA whose own concurrency
 * limits answer all of them at once with a refusal we then record as a
 * failure. Three is a rate a CA reads as an ordinary client; the rest wait,
 * and they are already recorded as pending with the Mac already polling.
 */
export function semaphore(width: number): (task: () => Promise<void>) => Promise<void> {
  let running = 0
  const waiting: (() => void)[] = []
  return async (task) => {
    if (running >= width) await new Promise<void>((resolve) => waiting.push(resolve))
    running += 1
    try {
      await task()
    } finally {
      running -= 1
      waiting.shift()?.()
    }
  }
}

export type CertRequest =
  | { ok: true; status: 'issued'; chain: string; notAfter: number }
  | { ok: true; status: 'pending'; order: string }
  | { ok: false; code: 400; error: 'bad_csr'; detail: string }
  | { ok: false; code: 409; error: 'in_flight' }
  | { ok: false; code: 429; error: 'rate_limited'; retryAfter: number }

export interface NamesFeature {
  zone: string
  /** The DNS responder, for dns-server.ts. */
  respond: Responder
  /** The wildcard a Mac's CSR must ask for and nothing else. */
  wildcardFor: (deviceId: string) => string
  /** Does that Mac have a live certificate — the `names` bit on a reach card. */
  hasNames: (deviceId: string) => boolean
  state: (deviceId: string) => CertState
  /** Start (or answer for) an order. Never throws; the CA work runs behind it. */
  request: (deviceId: string, csr: unknown) => CertRequest
}

/** The host out of a reach card's origin: `https://192.168.2.40:8643` → the IP. */
const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return null
  }
}

const RSA_BITS_MIN = 2048
/** Orders in flight at once. See `semaphore`. */
const CONCURRENT_ORDERS = 3

export function createNames(options: NamesOptions): NamesFeature {
  const zone = options.zone.toLowerCase().replace(/\.$/, '')
  const now = options.now ?? Date.now
  const note = options.log ?? ((): void => undefined)
  const certs = new CertStore(options.dataDir, now, note, options.weeklyBudget)
  const queue = semaphore(options.concurrency ?? CONCURRENT_ORDERS)
  const wildcardFor = (deviceId: string): string => `*.${deviceId}.${zone}`
  /** `_acme-challenge.<id>.<zone>` back to the id the store is keyed by. */
  const deviceOf = (host: string): string | null => {
    const found = new RegExp(`^_acme-challenge\\.([^.]+)\\.${zone.replace(/\./g, '\\.')}$`).exec(host.toLowerCase())
    return found?.[1] ?? null
  }

  /**
   * THE GATE, READ OFF THE SIGNED CARD. Only the addresses a desktop is
   * currently publishing, flattened to bare hosts; a `.ts.net` or `.local`
   * name simply never matches an address label, which is right — those names
   * already resolve elsewhere and are nobody's to re-answer.
   */
  const reach: ReachLookup = {
    find: (deviceId) => {
      const held = options.desktops.find(deviceId)
      const card = held?.reach ?? null
      if (card === null || held === null) return null
      const at = Date.parse(card.at)
      if (!Number.isFinite(at)) return null
      const addresses = [...card.lan.map((a) => a.url), ...(card.tailnet === null ? [] : [card.tailnet.url])]
        .map(hostOf)
        .filter((host): host is string => host !== null)
      /**
       * THE OLDER OF THE TWO CLOCKS, and one of them is not ours.
       *
       * The zone drops a card older than the reach TTL so that a Mac somebody
       * unplugged stops pointing a public name into whoever's network now
       * holds that address. Measured against the `at` the DESKTOP wrote, that
       * is a promise the desktop gets to break: a card dated 2099 is never
       * stale, and a machine off for a month keeps its name for seventy years.
       * `updatedAt` is stamped by putDesktop here, so it is the half nobody
       * outside this process can move — and a card cannot be fresher than the
       * last time it was actually handed to us.
       */
      return { addresses, at: Math.min(at, held.updatedAt) }
    }
  }

  const respond = createZone({
    zone,
    ns: options.ns,
    reach,
    challenges: { textsFor: (deviceId) => certs.textsFor(deviceId) },
    changedAt: () => Math.max(options.desktops.changedAt(), certs.changedAt()),
    now,
    ...(options.reachTtlMs === undefined ? {} : { reachTtlMs: options.reachTtlMs })
  })

  /**
   * IS THIS REQUEST FOR THIS MAC'S NAME AND NOTHING ELSE?
   *
   * Exactly one SAN, exactly the wildcard for the device whose own session is
   * asking. Not a superset, not a second name "while we are here": every name
   * in here ends up in a public certificate under cookrew.dev and in the
   * Certificate Transparency logs, signed by a CA that trusted us to have
   * checked.
   */
  const check = (deviceId: string, csr: unknown): { ok: true; der: Uint8Array } | { ok: false; detail: string } => {
    const read = readCsr(csr)
    if (!read.ok) return { ok: false, detail: read.reason }
    const wildcard = wildcardFor(deviceId)
    if (read.csr.dnsNames.length !== 1 || read.csr.dnsNames[0] !== wildcard) {
      return { ok: false, detail: `the request must name exactly ${wildcard}` }
    }
    const cn = read.csr.commonName?.toLowerCase() ?? null
    if (cn !== null && cn !== wildcard) return { ok: false, detail: 'the common name is not this Mac’s name' }
    const key = read.csr.key
    if (key.kind === 'ec' && key.curve !== 'P-256') return { ok: false, detail: 'an EC key must be P-256' }
    if (key.kind === 'rsa' && key.bits < RSA_BITS_MIN) {
      return { ok: false, detail: `an RSA key must be ${RSA_BITS_MIN} bits or more` }
    }
    return { ok: true, der: read.csr.der }
  }

  /**
   * The CA conversation, behind the answer.
   *
   * The route answers 202 and this runs on: an ACME order is seconds of
   * polling at best and the caller is a Mac on somebody's Wi-Fi. Every way it
   * can end is recorded — a chain, or a reason — so the GET afterwards can
   * say something true rather than "still pending" for ever.
   */
  const run = (deviceId: string, der: Uint8Array): Promise<void> =>
    queue(async () => {
      try {
        const out = await options.acme.issue({
          identifiers: [wildcardFor(deviceId)],
          csrDer: der,
          publish: (host, digests) => {
            const id = deviceOf(host)
            if (id !== null) certs.publish(id, digests)
          },
          retract: (host) => {
            const id = deviceOf(host)
            if (id !== null) certs.retract(id)
          }
        })
        if (!out.ok) {
          certs.fail(deviceId, `${out.reason}: ${out.detail}`)
          note(`names: order failed (${out.reason})`)
          return
        }
        const settled = certs.settle(deviceId, out.value.chain)
        note(settled === null ? 'names: the CA answered no usable chain' : 'names: a certificate was issued')
      } catch (error) {
        // A throw from in here would be an unhandled rejection and nothing else;
        // the Mac would poll a pending order that no longer exists.
        certs.fail(deviceId, error instanceof Error ? error.message : 'the order ended unexpectedly')
        note('names: an order ended unexpectedly')
      }
    })

  return {
    zone,
    respond,
    wildcardFor,
    hasNames: (deviceId) => certs.hasNames(deviceId),
    state: (deviceId) => certs.state(deviceId),
    request: (deviceId, csr) => {
      const checked = check(deviceId, csr)
      if (!checked.ok) return { ok: false, code: 400, error: 'bad_csr', detail: checked.detail }
      // A chain with more than the renewal window left is the answer, not a
      // reason for another order: Let's Encrypt counts new certificates, not
      // requests, and a Mac that asks twice must not spend two of them.
      const fresh = certs.fresh(deviceId)
      if (fresh !== null) return { ok: true, status: 'issued', chain: fresh.chain, notAfter: fresh.notAfter }
      const state = certs.state(deviceId)
      if (state.status === 'pending') return { ok: false, code: 409, error: 'in_flight' }
      const may = certs.mayOrder(deviceId)
      if (!may.ok) return { ok: false, code: 429, error: 'rate_limited', retryAfter: may.retryAfter }
      const order = randomUUID()
      certs.beginOrder(deviceId, order)
      // `.catch` as well as the try/catch inside `run`: the recovery path in
      // there writes to the store, and a store that cannot be written must not
      // become an unhandled rejection in a process with no route above it.
      void run(deviceId, checked.der).catch(() => note('names: an order could not even be recorded'))
      return { ok: true, status: 'pending', order }
    }
  }
}
