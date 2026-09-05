/**
 * THE PATH BADGE, AS A FACT ABOUT THE ORIGIN.
 *
 * Top-left of the companion bar, where the hand mark used to be: one dot and
 * one word saying how this phone is currently talking to the Mac. The phone
 * does not have to be told which path it took — it is already ON it. The
 * origin the companion was served from IS the answer:
 *
 *   a private address or *.local   → the LAN
 *   100.64/10 or *.ts.net          → the tailnet
 *   the registry's own host        → the relay
 *
 * Liveness is the other half. A dead push channel means the word is a memory,
 * not a fact, so a failed channel reads OFFLINE and a reconnecting one reads
 * PROBING no matter which host is in the address bar.
 */

export type PathState = 'LAN' | 'TAILNET' | 'RELAY' | 'OFFLINE' | 'PROBING'

/** What the companion's transport knows about itself. */
export type PathLink = 'live' | 'reconnecting' | 'failed'

export type PathBadgeInput = {
  readonly origin: string
  readonly link: PathLink
  /** Where cookrew.dev lives, so its host can be recognised as the relay. */
  readonly registryOrigin?: string
  readonly desktopName?: string
  readonly latencyMs?: number | null
}

export type PathBadgeView = {
  readonly state: PathState
  readonly word: PathState
  readonly pulsing: boolean
  readonly sentence: string
  readonly desktopName: string | null
  readonly latencyMs: number | null
  readonly switchDesktopUrl: string
}

export const DEFAULT_REGISTRY_ORIGIN = 'https://cookrew.dev'

const PATH_SENTENCES: Record<PathState, string> = {
  LAN: 'Direct over this Wi-Fi.',
  TAILNET: 'Via your tailnet.',
  RELAY: 'Via cookrew.dev relay — your Mac is not on this network.',
  OFFLINE: 'Not reachable right now.',
  PROBING: 'Looking for the best way to your Mac.'
}

/** Strip brackets so an IPv6 literal from a URL can be matched as an address. */
const bareHost = (host: string): string => host.replace(/^\[/, '').replace(/]$/, '').toLowerCase()

const ipv4Parts = (host: string): number[] | null => {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  return numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? numbers : null
}

/**
 * 100.64/10 — the CGNAT range Tailscale hands out. It is NOT a private range
 * in the RFC 1918 sense, and calling it one would paint a tailnet hop green as
 * if it were the same Wi-Fi.
 */
export const isTailnetHostname = (host: string): boolean => {
  const h = bareHost(host)
  if (h.endsWith('.ts.net')) return true
  // fd7a:115c:a1e0::/48 is Tailscale's ULA block.
  if (h.startsWith('fd7a:115c:a1e0')) return true
  const v4 = ipv4Parts(h)
  return !!v4 && v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127
}

export const isLanHostname = (host: string): boolean => {
  const h = bareHost(host)
  if (isTailnetHostname(h)) return false
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) return true
  const v4 = ipv4Parts(h)
  if (v4) {
    if (v4[0] === 10 || v4[0] === 127) return true
    if (v4[0] === 192 && v4[1] === 168) return true
    if (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) return true
    if (v4[0] === 169 && v4[1] === 254) return true
    return false
  }
  if (h.includes(':')) {
    // Unique-local (fc00::/7) and link-local (fe80::/10), minus the tailnet
    // block already claimed above.
    if (/^f[cd]/.test(h)) return true
    if (/^fe[89ab]/.test(h)) return true
    if (h === '::1') return true
  }
  return false
}

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).hostname
  } catch {
    return ''
  }
}

/** The transport-blind reading: what the address bar alone says. */
export const classifyOrigin = (
  origin: string,
  registryOrigin: string = DEFAULT_REGISTRY_ORIGIN
): PathState => {
  const host = hostOf(origin)
  if (!host) return 'OFFLINE'
  const registryHost = hostOf(registryOrigin)
  if (registryHost && bareHost(host) === bareHost(registryHost)) return 'RELAY'
  if (isTailnetHostname(host)) return 'TAILNET'
  if (isLanHostname(host)) return 'LAN'
  // A public name that is not the registry: something is fronting the desktop,
  // and the only honest word for a path we cannot name is the relay's.
  return 'RELAY'
}

export const pathBadgeView = (input: PathBadgeInput): PathBadgeView => {
  const registryOrigin = input.registryOrigin ?? DEFAULT_REGISTRY_ORIGIN
  const state: PathState =
    input.link === 'failed'
      ? 'OFFLINE'
      : input.link === 'reconnecting'
        ? 'PROBING'
        : classifyOrigin(input.origin, registryOrigin)
  return {
    state,
    word: state,
    pulsing: state === 'PROBING',
    sentence: PATH_SENTENCES[state],
    desktopName: input.desktopName ?? null,
    latencyMs: typeof input.latencyMs === 'number' ? input.latencyMs : null,
    switchDesktopUrl: `${registryOrigin.replace(/\/+$/, '')}/me`
  }
}
