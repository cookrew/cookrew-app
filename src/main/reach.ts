import { X509Certificate, createHash } from 'node:crypto'
import { canonicalJson } from '../shared/canonical-json'
import type { AccountFile } from './account-v2'
import { signWithDevice } from './account-v2'
import { isTailnetHost } from './tailscale'

/**
 * THE REACH CARD: how to get to this Mac, said once, signed.
 *
 * cookrew.dev stores directory facts, never canvas content (architecture P1),
 * and "where this desktop answers" is exactly such a fact. The phone gets the
 * card, races the addresses in it, and keeps the first one whose certificate
 * matches the fingerprint the card names — so a direct connection is never
 * trust-on-first-use, and the registry cannot silently point a phone at
 * something else. That is what the signature is for: the registry is a
 * repeater here, not an authority.
 *
 * THREE RULES THAT ARE EASY TO GET WRONG:
 *
 *   HTTPS ONLY. The plain-HTTP listener exists so a mistyped scheme can be
 *   redirected; it has no certificate and therefore no way to be verified.
 *   Publishing it would hand out an address that cannot be checked.
 *
 *   NO TOKEN. mobileEndpointList spells its URLs with `?token=` on them, ready
 *   to be printed by `cookrew mobile`. Those exact strings must never reach
 *   the registry — the reach card is a directory entry, not a credential.
 *
 *   NOTHING WITHOUT AN ACCOUNT, AND NOTHING WHEN REACHABILITY IS OFF. Both are
 *   the owner saying no, and a publish that ignores either is a Mac that
 *   advertises itself after being told not to.
 *
 * AND ONE MORE, LEARNED THE EXPENSIVE WAY: `at` is an ISO 8601 STRING. It was
 * a number here, which the registry refuses with 400 bad_reach — and because
 * `registerDesktop` ANSWERS a refusal rather than throwing one, the publisher
 * logged "reach published", cached the card as sent, and then never tried
 * again because nothing had changed. A publish path that cannot tell a 204
 * from a 400 will happily report success forever, so `last` is now set only
 * after the registry has actually taken the card.
 */

export type ReachAddress = {
  readonly url: string
  readonly certFp: string
}

export type ReachCard = {
  readonly deviceId: string
  readonly lan: readonly ReachAddress[]
  readonly tailnet: ReachAddress | null
  readonly relay: boolean
  /** ISO 8601 to the millisecond — the registry's `at` is a string. */
  readonly at: string
}

/** More addresses than a machine with three interfaces has; the registry's cap. */
export const LAN_MAX = 8

export type SignedReach = {
  readonly reach: ReachCard
  readonly sig: string
}

/** The certificate's SHA-256, over its DER — the same bytes a TLS peer sees. */
export const certFingerprint = (certPem: Buffer | string): string =>
  createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex')

/** The endpoint shape reach needs, kept structural so tests need no server. */
export type ReachEndpoint = {
  readonly url: string
  readonly kind: string
  readonly host: string
}

/** `https://host:8643/?token=…` → `https://host:8643` */
const withoutQuery = (raw: string): string | null => {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return null
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

export type ReachInput = {
  readonly deviceId: string
  readonly endpoints: readonly ReachEndpoint[]
  readonly certFp: string | null
  readonly relay: boolean
  /** Milliseconds, as every clock in this process speaks; ISO on the wire. */
  readonly at: number
}

/**
 * The card. Tailnet first because there is at most one and it is the address
 * that works off the LAN; everything else direct and verifiable is `lan`.
 *
 * The LAN list is capped at the registry's own limit rather than sent long and
 * refused whole: a machine that briefly has nine interfaces (a VM bridge, a
 * VPN coming up) would otherwise lose its reach card entirely, and the ninth
 * address is never the one that matters.
 */
export const reachCard = (input: ReachInput): ReachCard => {
  const lan: ReachAddress[] = []
  let tailnet: ReachAddress | null = null
  const seen = new Set<string>()
  for (const endpoint of input.endpoints) {
    if (endpoint.kind === 'loopback') continue
    const url = withoutQuery(endpoint.url)
    if (!url || !input.certFp || seen.has(url)) continue
    seen.add(url)
    const address: ReachAddress = { url, certFp: input.certFp }
    // `kind` is the server's own classification; the host check is the
    // backstop for an endpoint list that grew a new kind name.
    if (endpoint.kind === 'tailscale' || isTailnetHost(endpoint.host)) {
      if (!tailnet) tailnet = address
      continue
    }
    lan.push(address)
  }
  return {
    deviceId: input.deviceId,
    lan: lan.slice(0, LAN_MAX),
    tailnet,
    relay: input.relay,
    at: new Date(input.at).toISOString()
  }
}

export const signReach = (account: AccountFile, reach: ReachCard): SignedReach => ({
  reach,
  sig: signWithDevice(account, canonicalJson(reach))
})

/** Two cards are the same publish if everything but the timestamp matches. */
export const sameReach = (a: ReachCard | null, b: ReachCard): boolean =>
  a !== null && canonicalJson({ ...a, at: '' }) === canonicalJson({ ...b, at: '' })

export type PublishOutcome = 'published' | 'unchanged' | 'refused' | 'skipped'

export type ReachPublisher = {
  /** Publish if there is anything to publish and it has changed. */
  readonly publish: (reason: string) => Promise<PublishOutcome>
  /** Publish even if nothing changed — boot, and the reachability toggle. */
  readonly republish: (reason: string) => Promise<PublishOutcome>
  readonly watch: () => () => void
  /** The card the REGISTRY took, not the one this process last built. */
  readonly last: () => ReachCard | null
  /** How long until the next retry, or null when nothing is pending. */
  readonly retryInMs: () => number | null
}

export type ReachPublisherDeps = {
  readonly account: () => AccountFile | null
  readonly endpoints: () => readonly ReachEndpoint[]
  readonly certFp: () => string | null
  readonly relay: () => boolean
  readonly workspaces: () => readonly { id: string; name: string }[]
  /**
   * REACH v2.1 — the origins a browser will trust for this Mac right now.
   *
   * EMPTY unless a certificate is actually held (mobile-server · trustedOrigins),
   * because a phone reads this list as "these load without a warning". Absent
   * is the same as empty: a build with no certificate half publishes exactly
   * what it published before names existed.
   */
  readonly trusted?: () => readonly string[]
  readonly register: (
    workspaces: readonly { id: string; name: string }[],
    reach: SignedReach,
    trusted: readonly string[]
  ) => Promise<{ ok: boolean; reason?: string; message?: string } | unknown>
  readonly now?: () => number
  /** How often the address list is re-read looking for a network change. */
  readonly intervalMs?: number
  readonly setInterval?: (fn: () => void, ms: number) => { unref?: () => void }
  readonly setTimeout?: (fn: () => void, ms: number) => { unref?: () => void }
  readonly clearTimeout?: (handle: unknown) => void
  readonly log?: (message: string) => void
}

export const NETWORK_POLL_MS = 60_000

/**
 * Thirty seconds to five minutes.
 *
 * A refused card is usually one of two things: the registry is restarting, or
 * this build and that one disagree about the shape. The first wants a retry
 * soon; the second wants one that backs off rather than a Mac hammering a
 * deploy with a card it will never accept. Neither wants the old behaviour,
 * which was no retry at all.
 */
export const RETRY_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000] as const

const refusalOf = (result: unknown): string | null => {
  if (typeof result !== 'object' || result === null) return null
  const answer = result as { ok?: unknown; reason?: unknown; message?: unknown }
  if (answer.ok !== false) return null
  const message = typeof answer.message === 'string' ? answer.message : ''
  const reason = typeof answer.reason === 'string' ? answer.reason : 'refused'
  return message ? `${reason}: ${message}` : reason
}

export const createReachPublisher = (deps: ReachPublisherDeps): ReachPublisher => {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((): void => undefined)
  const later = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = deps.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
  let last: ReachCard | null = null
  /**
   * The trusted list the REGISTRY took, beside the card it took. It is not in
   * the card and not in the signature, so `sameReach` cannot see it — and a
   * Mac whose first certificate has just arrived would otherwise read
   * "unchanged" and never tell cookrew.dev its names exist.
   */
  let lastTrusted = ''
  let attempt = 0
  let retryHandle: unknown = null
  let retryAt: number | null = null
  /** The last refusal SAID OUT LOUD, so a five-minute loop is not a log flood. */
  let announced: string | null = null

  const build = (): { account: AccountFile; card: ReachCard } | null => {
    const account = deps.account()
    // Both refusals are the owner's, and neither is an error worth logging
    // loudly: no account, or reachability switched off in the profile.
    if (!account || !account.workspacesReachable) return null
    const certFp = deps.certFp()
    if (!certFp) return null
    const card = reachCard({
      deviceId: account.deviceId,
      endpoints: deps.endpoints(),
      certFp,
      relay: deps.relay(),
      at: now()
    })
    if (card.lan.length === 0 && card.tailnet === null && !card.relay) return null
    return { account, card }
  }

  const clearRetry = (): void => {
    if (retryHandle !== null) cancel(retryHandle)
    retryHandle = null
    retryAt = null
  }

  const scheduleRetry = (reason: string): void => {
    if (retryHandle !== null) return
    const wait = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]
    attempt += 1
    retryAt = now() + wait
    const handle = later(() => {
      retryHandle = null
      retryAt = null
      void send(`retry after ${reason}`)
    }, wait)
    handle.unref?.()
    retryHandle = handle
  }

  /**
   * One attempt. `last` moves ONLY when the registry took the card — a
   * refusal that updated it would make the next publish read "unchanged" and
   * the desktop would stay unreachable in silence, which is exactly the bug
   * this shape exists to prevent.
   */
  const send = async (reason: string): Promise<PublishOutcome> => {
    const built = build()
    if (!built) return 'skipped'
    let refusal: string | null = null
    const trusted = deps.trusted?.() ?? []
    try {
      refusal = refusalOf(
        await deps.register(deps.workspaces(), signReach(built.account, built.card), trusted)
      )
    } catch (error) {
      refusal = (error as Error).message || 'network'
    }
    if (refusal !== null) {
      // The registry's own sentence, once per distinct sentence.
      if (announced !== refusal) {
        log(`reach refused (${reason}): ${refusal} — retrying`)
        announced = refusal
      }
      scheduleRetry(reason)
      return 'refused'
    }
    last = built.card
    lastTrusted = trusted.join(' ')
    attempt = 0
    announced = null
    clearRetry()
    log(`reach published (${reason}): ${built.card.lan.length} lan, at ${built.card.at}`)
    return 'published'
  }

  const publish = async (reason: string): Promise<PublishOutcome> => {
    const built = build()
    if (!built) return 'skipped'
    if (sameReach(last, built.card) && (deps.trusted?.() ?? []).join(' ') === lastTrusted) {
      return 'unchanged'
    }
    return send(reason)
  }

  return {
    publish,
    republish: (reason: string) => send(reason),
    watch: () => {
      const start = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
      const handle = start(() => void publish('network change'), deps.intervalMs ?? NETWORK_POLL_MS)
      handle.unref?.()
      return () => {
        clearInterval(handle as unknown as NodeJS.Timeout)
        clearRetry()
      }
    },
    last: () => last,
    retryInMs: () => (retryAt === null ? null : Math.max(0, retryAt - now()))
  }
}
