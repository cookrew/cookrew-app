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

import { addressFromTrustedName } from './reach-names'

/**
 * A browser permission, in the four states local-network.ts reads.
 *
 * Spelled here rather than imported so this module stays shared code with no
 * renderer dependency; the two are pinned to each other by the badge tests.
 */
export type LocalNetworkPermission = 'unsupported' | 'granted' | 'denied' | 'prompt'

/**
 * WHAT THE RELAY SENTENCE BECOMES AFTER A REFUSAL.
 *
 * Kept in step with LOCAL_NETWORK_COPY.denied in the renderer's path-copy.ts,
 * because a reader who refuses meets this line twice — once on the row that
 * asked and once in the badge sheet — and two spellings of the same fact read
 * as two different facts.
 */
export const RELAY_REFUSED_SENTENCE =
  "Staying on the relay. You can allow local network access in the browser's site settings."

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
  /**
   * The companion is racing a better path right now (path/switch.ts).
   *
   * Separate from `link`, because the two are different facts: `reconnecting`
   * means the channel this page is using is down, and probing means it is up
   * and something better may exist. Both read PROBING, and a probe must never
   * be spelled as a failing transport — that would make an idle 30-second
   * check look like a dropped connection every 30 seconds.
   */
  readonly probing?: boolean
  /**
   * THIS PAGE WAS SERVED UNDER A RELAY PREFIX, so the relay is what is
   * carrying the data plane — whatever host the address bar shows.
   *
   * The origin alone cannot answer this. Reach v2.1 gives every Mac real
   * certificates for names like `192-168-2-40.<id>.d.cookrew.dev`, and a relay
   * can be fronted by any host at all; classifying by hostname would then read
   * LAN off a page whose every request is going through cookrew.dev.
   *
   * It says only "do not read the address bar"; WHICH path is carrying the
   * data plane is `plane`, below.
   */
  readonly relayed?: boolean
  /**
   * WHICH TRANSPORT IS ACTUALLY CARRYING THE DATA PLANE (phase C3).
   *
   * Only meaningful under a prefix, and it is the whole of the promise the
   * address bar can no longer keep: the page stays at cookrew.dev for the life
   * of the session while the requests underneath move to the Mac's own trusted
   * name and back. The badge is then the only thing on screen telling the
   * truth about the transport, which is why it is a supplied FACT — read off
   * the store that composes the request URLs — and never re-derived here.
   *
   * Absent means the relay, because the shell arrived over the relay and a
   * plane that has not moved has not moved.
   */
  readonly plane?: 'LAN' | 'TAILNET' | 'RELAY'
  /**
   * WHETHER THE BROWSER WILL LET THIS PAGE REACH THE HOUSE AT ALL.
   *
   * Only ever changes the SENTENCE, never the word: the word is a fact about
   * the transport carrying the session and a permission does not alter it.
   * What it alters is the reason, and the ordinary relay reason — "your Mac is
   * not on this network" — is false after a refusal, when the Mac may be three
   * feet away and the browser simply will not let us knock.
   */
  readonly localNetwork?: LocalNetworkPermission
}

export type PathBadgeView = {
  readonly state: PathState
  readonly word: PathState
  readonly pulsing: boolean
  readonly sentence: string
  readonly desktopName: string | null
  readonly latencyMs: number | null
  readonly switchDesktopUrl: string | null
}

/**
 * ONLY FOR RECOGNISING THE RELAY, never for building a link.
 *
 * Classifying an origin needs a guess about where the relay lives and a wrong
 * guess costs one word on a badge. Sending somebody to "switch desktop" needs
 * a FACT, and a wrong one sends a self-hosting owner to a site that has never
 * heard of them — so `switchDesktopUrl` is null until the desktop says where
 * its account lives, and the sheet then offers nothing rather than a lie.
 */
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
  /**
   * A REACH v2.1 NAME IS THE ADDRESS IT SPELLS, NOT THE ZONE IT SITS IN.
   *
   * `192-168-2-40.<id>.d.cookrew.dev` is the Wi-Fi, and it fell through every
   * test below to the closing "a public name we cannot name" — so the badge
   * said RELAY over a page whose bytes never left the house. That is the one
   * reading the badge exists to prevent, and it is what a phone gets from
   * every trusted URL `cookrew mobile` prints.
   */
  const spelled = addressFromTrustedName(host)
  if (spelled !== null) return isTailnetHostname(spelled) ? 'TAILNET' : isLanHostname(spelled) ? 'LAN' : 'RELAY'
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
      : input.link === 'reconnecting' || input.probing === true
        ? 'PROBING'
        : input.relayed === true
          ? // A dead or reconnecting channel still outranks this: OFFLINE is a
            // fact about the transport, and the plane is a fact about the path.
            (input.plane ?? 'RELAY')
          : classifyOrigin(input.origin, registryOrigin)
  // A refusal is only the reason when the relay is what we ended up with. On a
  // direct plane the plane is the fact, and a permission read on some other
  // network is stale the moment the phone moves.
  const refused = state === 'RELAY' && input.localNetwork === 'denied'
  return {
    state,
    word: state,
    pulsing: state === 'PROBING',
    sentence: refused ? RELAY_REFUSED_SENTENCE : PATH_SENTENCES[state],
    desktopName: input.desktopName ?? null,
    latencyMs: typeof input.latencyMs === 'number' ? input.latencyMs : null,
    switchDesktopUrl: input.registryOrigin
      ? `${input.registryOrigin.replace(/\/+$/, '')}/me`
      : null
  }
}
