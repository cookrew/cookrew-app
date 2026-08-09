// Whether a system proxy would swallow the tailnet URL we just printed.
//
// WHY THIS EXISTS
// ---------------
// `cookrew mobile` prints a Tailscale URL that is genuinely reachable — curl
// loads it fine, because curl ignores the macOS system proxy. A browser on the
// SAME Mac does not: Chrome honours the system proxy, and a proxy whose bypass
// list predates Tailscale has no entry for CGNAT space or `.ts.net`, so it
// tries to tunnel tailnet traffic to an upstream that cannot route it. The tab
// dies with ERR_CONNECTION_CLOSED and it reads as a Cookrew bug.
//
// It is not one, and there is nothing to fix in code — the fix is one line in
// the user's proxy settings. So the only useful thing we can do is SAY so, at
// the exact moment we hand out the URL that is about to fail.
//
// SCOPE — read-only. This parses configuration and decides nothing else. It
// never edits proxy settings, never opens a socket, and never shells out
// except through an injected runner.

import { execFileSync } from 'node:child_process'

/** The parts of the system proxy configuration that decide reachability. */
export interface ProxyConfig {
  /** True when some proxy is switched on — HTTP, HTTPS or SOCKS. */
  enabled: boolean
  /** Raw bypass entries, in the order macOS lists them. */
  exceptions: string[]
}

/**
 * Tailscale's IPv4 allocation: RFC 6598 shared address space, 100.64.0.0/10.
 * The /10 matters — 100.0/8 at large is ordinary public space, so a laxer
 * entry would exempt hosts that are nothing to do with the tailnet.
 */
const TAILNET_V4_BYPASS = '100.64.0.0/10'

/** Every MagicDNS name lives under this suffix, so one entry covers them all. */
const TAILNET_DNS_BYPASS = '*.ts.net'

/**
 * Keys whose value being 1 means traffic is being redirected. SOCKS counts:
 * Chrome routes through it, and the exception list is shared across all three.
 * ProxyAutoConfigEnable is deliberately absent — a PAC script's decisions are
 * only knowable by running it, and guessing would mean warning people whose
 * PAC already exempts the tailnet.
 */
const ENABLE_KEYS = ['HTTPEnable', 'HTTPSEnable', 'SOCKSEnable']

/** macOS's "exclude simple hostnames" checkbox, as it appears in scutil. */
const SIMPLE_HOSTNAMES = '<local>'

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let total = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    total = total * 256 + octet
  }
  return total
}

/**
 * Pad an abbreviated network to four octets. macOS writes `169.254/16` in its
 * own exception lists, with the trailing zeros implied.
 */
function padNetwork(network: string): string {
  const parts = network.split('.')
  return parts.length >= 4 ? network : [...parts, ...Array(4 - parts.length).fill('0')].join('.')
}

/** True when `address` falls inside `cidr`; false for anything unparseable. */
function inCidr(address: string, cidr: string): boolean {
  const [network, rawPrefix] = cidr.split('/')
  const prefix = Number(rawPrefix)
  if (!/^\d{1,2}$/.test(rawPrefix ?? '') || prefix > 32) return false
  const host = ipv4ToInt(address)
  const base = ipv4ToInt(padNetwork(network))
  if (host === null || base === null) return false
  // A /0 shift by 32 is undefined in JS, so mask it out explicitly.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return ((host & mask) >>> 0) === ((base & mask) >>> 0)
}

/**
 * True when a bypass entry exempts a host, following macOS's syntax:
 *
 *   `10.0.0.0/8`  CIDR — matches any address inside the block
 *   `*.ts.net`    suffix — matches subdomains and the suffix itself
 *   `<local>`     matches dotless ("simple") hostnames
 *   `example.com` domain — matches the domain and anything under it
 *   `127.0.0.1`   bare address — exact only
 *
 * Suffix and domain matches must land on a dot boundary. Without that check
 * `*.ts.net` would also exempt `evilts.net`, and an exemption is the thing
 * that silences our warning — a false match hides a real breakage.
 */
export function matchesException(host: string, entry: string): boolean {
  const target = host.trim().toLowerCase()
  const rule = entry.trim().toLowerCase()
  if (target.length === 0 || rule.length === 0) return false

  if (rule === SIMPLE_HOSTNAMES) return !target.includes('.')
  if (rule.includes('/')) return inCidr(target, rule)

  const suffix = rule.startsWith('*.') ? rule.slice(2) : rule
  if (target === suffix) return true
  // A literal address only ever matches itself — 127.0.0.1 must not exempt
  // 10.0.0.127.0.0.1-style suffixes, and addresses have no subdomains.
  if (ipv4ToInt(suffix) !== null) return false
  return target.endsWith(`.${suffix}`)
}

/** True when the proxy is on and no exception covers the host. */
export function wouldBeProxied(host: string, config: ProxyConfig | null): boolean {
  if (!config?.enabled) return false
  return !config.exceptions.some((entry) => matchesException(host, entry))
}

/**
 * Parse `scutil --proxy`. Its output is a plist-ish dictionary, not JSON:
 *
 *   <dictionary> {
 *     ExceptionsList : <array> {
 *       0 : 192.168.0.0/16
 *     }
 *     HTTPEnable : 1
 *   }
 *
 * Unreadable output yields an empty, disabled config rather than an error —
 * "I could not tell" and "there is no proxy" lead to the same silence, and
 * silence is the safe answer for a diagnostic that only ever adds a warning.
 */
export function parseScutilProxy(raw: string): ProxyConfig {
  const exceptions: string[] = []
  let enabled = false
  let inExceptions = false

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (inExceptions) {
      if (trimmed === '}') {
        inExceptions = false
        continue
      }
      const item = /^\d+\s*:\s*(.+)$/.exec(trimmed)
      if (item) exceptions.push(item[1].trim())
      continue
    }
    if (/^ExceptionsList\s*:/.test(trimmed)) {
      inExceptions = true
      continue
    }
    const pair = /^(\w+)\s*:\s*(\S+)$/.exec(trimmed)
    if (pair && ENABLE_KEYS.includes(pair[1]) && pair[2] === '1') enabled = true
  }

  return { enabled, exceptions }
}

/**
 * The bypass entries the user must add before a browser on THIS machine can
 * load the tailnet URLs we advertise. Empty means "nothing to say": no proxy,
 * no tailnet endpoint, or the tailnet is already exempt.
 *
 * Only hosts that are actually advertised produce a gap, so a machine with a
 * MagicDNS name but no v4 address is not told to add a CIDR it does not need.
 * Tailnet IPv6 raises no gap: macOS bypass lists have no agreed syntax for a
 * v6 prefix, and every tailnet with v6 also has the v4 and the name, so the
 * two entries below already unblock it.
 */
export function tailnetProxyGaps(tailnetHosts: string[], config: ProxyConfig | null): string[] {
  if (!config?.enabled) return []
  const gaps: string[] = []
  const needs = (host: string): boolean => host.length > 0 && wouldBeProxied(host, config)

  if (tailnetHosts.filter((host) => /^[\d.]+$/.test(host)).some(needs)) gaps.push(TAILNET_V4_BYPASS)
  if (tailnetHosts.filter((host) => host.toLowerCase().endsWith('.ts.net')).some(needs))
    gaps.push(TAILNET_DNS_BYPASS)
  return gaps
}

/** Injected so the parser can be tested without a Mac, or any `scutil` at all. */
export interface ProxyProbe {
  run: () => string
}

function defaultProbe(): ProxyProbe {
  return {
    // Short timeout: this runs inline in a CLI command and a wedged
    // configuration daemon must not hang `cookrew mobile`.
    run: () => execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 2000 })
  }
}

/**
 * The system proxy configuration, or null when it cannot be read — no scutil
 * (any non-macOS host), no permission, a wedged daemon. Never throws: proxy
 * awareness is a courtesy, and a courtesy must not be able to break `mobile`.
 */
export function readProxyConfig(probe: ProxyProbe = defaultProbe()): ProxyConfig | null {
  try {
    return parseScutilProxy(probe.run())
  } catch {
    return null
  }
}
