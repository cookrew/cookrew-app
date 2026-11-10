import { machineCopy } from '../shared/machine-words'
import type { PairingHandout } from '../shared/account-v2'
import { originOf } from '../shared/pairing-url'
import { isMachineId } from '../shared/machine-relay'

/**
 * WHAT `cookrew mobile` AND THE POPOUT BOTH SHOW.
 *
 * One function, two surfaces, on purpose: the terminal and the avatar popout
 * printed different things for the whole of v2 (a URL with a token in one, six
 * rotating characters in the other), which meant "pair a phone" was two
 * ceremonies that could disagree about which one was current. There is one
 * credential now, so there is one place that decides how it is spelled.
 *
 * WITH AN ACCOUNT it is the relay URL — the address that works from any
 * network, with the token in the fragment (shared/pairing-url.ts).
 *
 * WITHOUT ONE it is the most reachable DIRECT address, exactly as today: a Mac
 * with no username has nothing to publish and the phone has nothing to sign in
 * to, so the `?token=` URL on this Wi-Fi is the only door there is.
 *
 * LOOPBACK IS NEVER OFFERED. It is the no-addresses fallback in the endpoint
 * list and a phone cannot reach it; a QR of `https://localhost:8643` is a
 * scan that fails silently, which is worse than a sheet that says it has
 * nothing to show.
 */

export type PairingHandoutAccount = {
  readonly username: string
  readonly deviceId: string
  /** The Mac's own name, so the sheet can say which desktop this is. */
  readonly name: string
}

/** The endpoint shape this needs, kept structural so tests need no server. */
export type PairingEndpoint = {
  readonly url: string
  readonly kind: string
  /**
   * The same address under this Mac's trusted name (reach v2.1). Preferred
   * when it is there: the direct handout is scanned by a phone with no
   * account, and that phone has no way to accept a self-signed certificate
   * other than a warning it has been taught to fear.
   */
  readonly trustedUrl?: string
}

export type PairingHandoutDeps = {
  readonly account: () => PairingHandoutAccount | null
  /** Where the console is (registry-origin.ts · consoleOrigin). */
  readonly consoleOrigin: () => string
  /** mobileEndpointList(): most reachable first, `?token=` already on them. */
  readonly endpoints: () => readonly PairingEndpoint[]
  /** The persisted pairing token; null before the mobile server has started. */
  readonly pairingToken: () => string | null
}

/** The first address a phone could actually dial, spelled its best way. */
const bestDirect = (endpoints: readonly PairingEndpoint[]): string | null => {
  const reachable = endpoints.filter((endpoint) => endpoint.kind !== 'loopback')
  // A trusted name anywhere in the list beats a bare address at the top of
  // it: order is about reachability, and this choice is about the warning.
  const named = reachable.find((endpoint) => endpoint.trustedUrl !== undefined)
  return named?.trustedUrl ?? reachable[0]?.url ?? null
}

export const pairingHandout = (deps: PairingHandoutDeps): PairingHandout | null => {
  const token = deps.pairingToken()
  if (!token) return null
  const account = deps.account()
  const desktopName = account?.name ?? machineCopy('This Mac', process.platform)

  if (account) {
    // A MACHINE OF AN ACCOUNT HANDS OUT AN ADDRESS, NOT A KEY (0.6.0): its own level on the
    // console. Whoever opens it signs in to the account and proves it is them there; the link
    // itself opens nothing, so it can be photographed, pasted and left on a screen.
    const console = originOf(deps.consoleOrigin())
    const id = account.deviceId.toLowerCase()
    // A console address this app would not send a phone to, or an id that is not a machine's,
    // falls through to the direct address rather than showing nothing.
    if (console !== null && isMachineId(id)) return { url: `${console}/d/${id}`, via: 'console', desktopName, deviceId: account.deviceId }
  }

  const direct = bestDirect(deps.endpoints())
  return direct ? { url: direct, via: 'direct', desktopName } : null
}
