// Tailscale awareness for the mobile companion.
//
// WHY THIS EXISTS
// ---------------
// The companion already binds 0.0.0.0, so the moment Tailscale is up its
// address is reachable — nothing here "adds" access. What was missing is that
// the tailnet address arrived UNLABELLED in the middle of the LAN list, and
// the self-signed cert did not cover it, so the one endpoint that works from
// outside the house was the one endpoint the phone refused to load.
//
// SCOPE — this reads Tailscale's own view of the machine and nothing else. It
// never calls `tailscale up`, never touches `serve`, and deliberately has no
// path to `funnel`: Funnel publishes to the open internet, which is exactly
// what the companion must never be. A tailnet is a private mesh; the public
// net stays out of reach by construction.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Tailscale's own view of THIS machine, reduced to what the phone needs. */
export interface TailnetIdentity {
  /** Tailnet addresses of this machine (v4 first, then v6). */
  ips: string[]
  /** `host.tailnet.ts.net`, without the trailing dot; null when MagicDNS is off. */
  magicDnsName: string | null
  /** Whether the tailnet has MagicDNS enabled at all. */
  magicDnsEnabled: boolean
  /** Domains Tailscale would issue a real (publicly trusted) cert for. */
  certDomains: string[]
}

/** Hosts a cert must cover for tailnet access to work without a warning. */
export interface CertHosts {
  ips: string[]
  dnsNames: string[]
}

/**
 * Where the CLI lives. The Mac app ships it inside the bundle; Homebrew and
 * the standalone package put it on PATH. COOKREW_TAILSCALE_CLI overrides for
 * unusual installs — a path, never a credential.
 */
const CLI_CANDIDATES = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/bin/tailscale'
]

/** IPv6 prefix Tailscale allocates ULAs from (fd7a:115c:a1e0::/48). */
const TAILNET_V6_PREFIX = 'fd7a:115c:a1e0'

/**
 * True for an address Tailscale itself would have assigned: CGNAT
 * 100.64.0.0/10 for v4, the tailnet ULA prefix for v6.
 *
 * The /10 boundary matters. `100.` alone spans 100.0.0.0–100.255.255.255,
 * and real networks do use 100.0/100.128 space — labelling one of those
 * "Tailscale" would send the user to an address that only works at home.
 */
export function isTailnetAddress(address: string): boolean {
  if (address.includes(':')) return address.toLowerCase().startsWith(TAILNET_V6_PREFIX)
  const octets = address.split('.')
  if (octets.length !== 4) return false
  const parsed = octets.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  if (parsed.some((n) => Number.isNaN(n) || n > 255)) return false
  return parsed[0] === 100 && parsed[1] >= 64 && parsed[1] <= 127
}

/** Suffix every MagicDNS name carries, so one test covers all of them. */
const MAGIC_DNS_SUFFIX = '.ts.net'

/**
 * True for anything that identifies this machine ON the tailnet — a tailnet
 * address or a MagicDNS name.
 *
 * Used to decide what a certificate must never lose. A tailnet identity is
 * stable and belongs to the machine; a LAN address belongs to whatever network
 * it happens to be plugged into, and losing one of those costs nothing.
 */
export function isTailnetHost(host: string): boolean {
  const target = host.trim().toLowerCase()
  if (target.length === 0) return false
  return isTailnetAddress(target) || target.endsWith(MAGIC_DNS_SUFFIX)
}

interface RawStatus {
  BackendState?: unknown
  TailscaleIPs?: unknown
  CertDomains?: unknown
  CurrentTailnet?: { MagicDNSEnabled?: unknown } | null
  Self?: { DNSName?: unknown; TailscaleIPs?: unknown } | null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * Parse `tailscale status --json`. Returns null when Tailscale is installed
 * but not actually carrying traffic (logged out, stopped) — an address from a
 * stopped backend is a dead link, which is worse than no link.
 */
export function parseTailscaleStatus(raw: string): TailnetIdentity | null {
  let status: RawStatus
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    status = parsed as RawStatus
  } catch {
    return null
  }
  if (status.BackendState !== 'Running') return null

  const self = status.Self ?? null
  const ips = [...new Set([...strings(status.TailscaleIPs), ...strings(self?.TailscaleIPs)])].filter(
    isTailnetAddress
  )
  const dnsName = typeof self?.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : ''
  const magicDnsEnabled = status.CurrentTailnet?.MagicDNSEnabled === true

  return {
    ips,
    magicDnsName: dnsName.length > 0 ? dnsName : null,
    magicDnsEnabled,
    certDomains: strings(status.CertDomains)
  }
}

export interface TailnetProbe {
  /** Run the CLI and return stdout. */
  run: (cli: string) => string
  /** Existence test for a CLI path. */
  exists: (cli: string) => boolean
}

/** Async counterpart used by Electron's main process. */
export interface AsyncTailnetProbe {
  /** Run the CLI without holding the caller's event loop. */
  run: (cli: string) => Promise<string>
  /** Existence test for a CLI path. */
  exists: (cli: string) => boolean
}

function defaultAsyncProbe(): AsyncTailnetProbe {
  return {
    exists: (cli) => existsSync(cli),
    run: (cli) =>
      new Promise((resolve, reject) => {
        const child = execFile(
          cli,
          ['status', '--json'],
          { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL' },
          (error, stdout) => {
            if (error) reject(error)
            else resolve(typeof stdout === 'string' ? stdout : String(stdout))
          }
        )
        // A status refresh must never keep Cookrew alive during shutdown.
        child.unref?.()
      })
  }
}

function tailnetCliCandidates(): string[] {
  const override = process.env.COOKREW_TAILSCALE_CLI
  return [...new Set(override ? [override, ...CLI_CANDIDATES] : CLI_CANDIDATES)]
}

/**
 * The tailnet identity of this machine, or null when Tailscale is absent,
 * stopped, or unreadable. Never throws — no tailnet is the ordinary case and
 * must degrade to "LAN only", not to a failed startup.
 */
export function readTailnet(probe: TailnetProbe): TailnetIdentity | null {
  for (const cli of tailnetCliCandidates()) {
    if (!probe.exists(cli)) continue
    try {
      return parseTailscaleStatus(probe.run(cli))
    } catch {
      // Installed but unhappy (daemon down, permissions) — try the next path
      // and otherwise fall through to "no tailnet".
    }
  }
  return null
}

/**
 * Non-blocking Tailscale discovery for Electron's main process.
 *
 * `tailscale status` normally returns quickly, but a reconnecting or wedged
 * daemon can consume its full timeout. Running a synchronous probe from the
 * certificate timer froze BrowserWindow event delivery long enough for macOS
 * to show the spinning wait cursor. The sync parser seam above requires an
 * injected runner; all real CLI discovery goes through this async form.
 */
export async function readTailnetAsync(
  probe: AsyncTailnetProbe = defaultAsyncProbe()
): Promise<TailnetIdentity | null> {
  for (const cli of tailnetCliCandidates()) {
    if (!probe.exists(cli)) continue
    try {
      return parseTailscaleStatus(await probe.run(cli))
    } catch {
      // Installed but unavailable: try another installation, then degrade to LAN.
    }
  }
  return null
}
