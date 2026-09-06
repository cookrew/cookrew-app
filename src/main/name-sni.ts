import { createSecureContext, type SecureContext } from 'node:tls'
import type { HeldCert } from './name-cert-store'
import { coveredByWildcard } from '../shared/reach-names'

/**
 * WHICH CERTIFICATE THIS LISTENER ANSWERS WITH, PER HANDSHAKE.
 *
 * The self-signed certificate stays the DEFAULT and keeps every job it had:
 * bare IPs, `localhost`, the tailnet's MagicDNS name, a Mac with no account,
 * a Mac whose order has never succeeded. Nothing about those paths changes,
 * and nothing about them may change — they are what works with no internet,
 * no account and no DNS.
 *
 * The trusted chain is answered for ONE shape of name and no other:
 * `<label>.<deviceId>.<zone>`, which is what the wildcard covers. Serving it
 * for anything else would be a name mismatch the phone cannot wave away, so a
 * servername we do not recognise falls back to the default rather than being
 * refused — a refused handshake reads as "the Mac is down".
 *
 * LIVE, WITHOUT A RESTART. `held` is called per handshake and the context is
 * cached against the chain's own bytes, so a renewal that replaces the chain
 * is picked up by the next connection while every open stream survives. That
 * is the same property `setSecureContext` gives the default certificate when
 * the tailnet turns up late (mobile-server.ts · watchTailnetCert).
 */

export interface NameSniDeps {
  /** The trusted chain this Mac holds, or null. Read per handshake. */
  readonly held: () => HeldCert | null
  /**
   * The device id and zone to answer for — null unless a chain is held.
   *
   * ONE reader rather than a device id and a zone read separately: the zone is
   * configuration, and a listener that captured it at startup would answer for
   * the wrong names on a self-hosted registry. `DesktopCert.naming` is exactly
   * this shape, so the certificate and the name it is served under can never
   * come from two different opinions.
   */
  readonly naming: () => { deviceId: string; zone: string } | null
  readonly log?: (message: string) => void
}

/** Node's SNI callback: `undefined` context means "use the server's default". */
export type SniCallback = (
  servername: string,
  callback: (error: Error | null, context?: SecureContext) => void
) => void

export function createNameSni(deps: NameSniDeps): SniCallback {
  const note = deps.log ?? ((): void => undefined)
  /** One built context per chain, keyed by the chain itself. */
  let cachedFor: string | null = null
  let cached: SecureContext | null = null

  const contextFor = (cert: HeldCert): SecureContext | null => {
    if (cachedFor === cert.chain && cached !== null) return cached
    try {
      const built = createSecureContext({ key: cert.key, cert: cert.chain })
      cachedFor = cert.chain
      cached = built
      return built
    } catch (error) {
      // A chain that will not build is one this Mac cannot serve. The default
      // certificate still answers, so the phone sees the warning it saw
      // before names existed rather than a dead port.
      note(`names: the held certificate could not be loaded (${(error as Error).message})`)
      cachedFor = null
      cached = null
      return null
    }
  }

  return (servername, callback) => {
    const naming = deps.naming()
    if (typeof servername !== 'string' || naming === null) return callback(null, undefined)
    if (!coveredByWildcard(servername, naming.deviceId, naming.zone)) return callback(null, undefined)
    const cert = deps.held()
    if (cert === null) return callback(null, undefined)
    const context = contextFor(cert)
    // `null` for the error either way: a handshake refused here is a phone
    // that cannot load the page at all, which is worse than one that sees a
    // certificate warning it can act on.
    return callback(null, context ?? undefined)
  }
}
