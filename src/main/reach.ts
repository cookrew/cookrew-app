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
  readonly at: number
}

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
  readonly at: number
}

/**
 * The card. Tailnet first because there is at most one and it is the address
 * that works off the LAN; everything else direct and verifiable is `lan`.
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
  return { deviceId: input.deviceId, lan, tailnet, relay: input.relay, at: input.at }
}

export const signReach = (account: AccountFile, reach: ReachCard): SignedReach => ({
  reach,
  sig: signWithDevice(account, canonicalJson(reach))
})

/** Two cards are the same publish if everything but the timestamp matches. */
export const sameReach = (a: ReachCard | null, b: ReachCard): boolean =>
  a !== null && canonicalJson({ ...a, at: 0 }) === canonicalJson({ ...b, at: 0 })

export type ReachPublisher = {
  /** Publish if there is anything to publish and it has changed. */
  readonly publish: (reason: string) => Promise<'published' | 'unchanged' | 'skipped'>
  /** Publish even if nothing changed — boot, and the reachability toggle. */
  readonly republish: (reason: string) => Promise<'published' | 'skipped'>
  readonly watch: () => () => void
  readonly last: () => ReachCard | null
}

export type ReachPublisherDeps = {
  readonly account: () => AccountFile | null
  readonly endpoints: () => readonly ReachEndpoint[]
  readonly certFp: () => string | null
  readonly relay: () => boolean
  readonly workspaces: () => readonly { id: string; name: string }[]
  readonly register: (
    workspaces: readonly { id: string; name: string }[],
    reach: SignedReach
  ) => Promise<unknown>
  readonly now?: () => number
  /** How often the address list is re-read looking for a network change. */
  readonly intervalMs?: number
  readonly setInterval?: (fn: () => void, ms: number) => { unref?: () => void }
  readonly clearInterval?: (handle: never) => void
  readonly log?: (message: string) => void
}

export const NETWORK_POLL_MS = 60_000

export const createReachPublisher = (deps: ReachPublisherDeps): ReachPublisher => {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((): void => undefined)
  let last: ReachCard | null = null

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

  const send = async (built: { account: AccountFile; card: ReachCard }): Promise<void> => {
    await deps.register(deps.workspaces(), signReach(built.account, built.card))
    last = built.card
  }

  const publish = async (reason: string): Promise<'published' | 'unchanged' | 'skipped'> => {
    const built = build()
    if (!built) return 'skipped'
    if (sameReach(last, built.card)) return 'unchanged'
    try {
      await send(built)
      log(`reach published (${reason}): ${built.card.lan.length} lan`)
      return 'published'
    } catch (error) {
      log(`reach publish failed (${reason}): ${(error as Error).message}`)
      return 'skipped'
    }
  }

  return {
    publish,
    republish: async (reason: string) => {
      const built = build()
      if (!built) return 'skipped'
      try {
        await send(built)
        log(`reach republished (${reason})`)
        return 'published'
      } catch (error) {
        log(`reach publish failed (${reason}): ${(error as Error).message}`)
        return 'skipped'
      }
    },
    watch: () => {
      const start = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
      const handle = start(() => void publish('network change'), deps.intervalMs ?? NETWORK_POLL_MS)
      handle.unref?.()
      return () => clearInterval(handle as unknown as NodeJS.Timeout)
    },
    last: () => last
  }
}
