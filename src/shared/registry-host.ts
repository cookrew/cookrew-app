// Which registry hosts this app recognises, and why it recognises so few.
//
// A DEFAULT HOST IS A DEFAULT RECIPIENT FOR AN AUTHOR'S PAYOUT ADDRESS.
//
// A publish pushes a signed manifest and a payout address to whatever host is
// configured, so a wrong registry is not a broken link — it is a supply-chain
// redirect for money and trust bindings. That is the whole justification for
// the rule below, and it is written here because the next person to meet an
// empty host list will read it as an oversight and be tempted to fix it with a
// default.
//
// THE RULE (ruled, marketplace R21 + this lane):
//   - never a silent default — nothing is recognised that an owner did not
//     choose, and a host is never INFERRED from a page that claims to be one;
//   - never a dead end either — the refusal names the setting and how to set
//     it, and the settings surface makes "configured" reachable without an
//     environment variable;
//   - loopback recognition exists ONLY where a packaged build cannot carry it,
//     so a developer can walk the journey and a shipped app still trusts
//     nothing by default.
//
// Pure on purpose: the resolution is a security decision, so it is testable
// without an Electron app, an environment, or a filesystem.

/** The setting an owner sets, named once so every message agrees. */
export const REGISTRY_HOST_SETTING = 'COOKREW_REGISTRY_HOST'

/** Hosts recognised only in an unpackaged build. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const

/**
 * A hostname, and nothing else: no scheme, no path, no port, no wildcard.
 *
 * Deliberately strict. Every relaxation here widens what the app will accept a
 * signed manifest and a payout address from, and a wildcard would hand that
 * decision to whoever registers the next subdomain.
 */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

export type HostSource =
  /** The owner chose these, by env or in settings. */
  | 'configured'
  /** Unpackaged build only: loopback so the journey is walkable in dev. */
  | 'loopback-dev'
  /** Nothing recognised. The refusal must say how to fix that. */
  | 'none'

export interface HostResolution {
  hosts: string[]
  source: HostSource
  /**
   * Entries an owner configured that are not hostnames. Surfaced rather than
   * dropped: being told to configure a host you already configured is the dead
   * end wearing a different coat.
   */
  rejected: string[]
}

/**
 * Split a comma list into hostnames, keeping what was REJECTED.
 *
 * M2: dropping malformed entries in silence produces the same dead end this
 * module exists to remove, arriving through the validation path instead of the
 * empty one — an owner who sets `https://registry.example.com` is told no host
 * is configured and to configure one. The likeliest mistake is a scheme, and a
 * refusal that names the entry costs one string.
 *
 * M3: NORMALISED here, so both configuration routes agree. `add()` already
 * lowercased; the environment path did not, so `Registry.Example.Com` was
 * stored cased and matched nothing.
 */
function parseHosts(raw: string): { hosts: string[]; rejected: string[] } {
  const hosts: string[] = []
  const rejected: string[] = []
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    if (HOSTNAME_RE.test(trimmed)) hosts.push(trimmed.toLowerCase())
    else rejected.push(trimmed)
  }
  return { hosts, rejected }
}

/**
 * The hosts this app recognises right now.
 *
 * A CONFIGURED list wins outright and is never merged with the dev loopback: a
 * developer who named a registry meant that one, and quietly adding localhost
 * would let a local server shadow the registry they chose — which is the
 * supply-chain redirect this module exists to prevent, arriving as a
 * convenience.
 */
export function resolveRegistryHosts(input: {
  /** Raw COOKREW_REGISTRY_HOST value. */
  configured: string
  /** Hosts added through the settings surface. */
  settings?: readonly string[]
  /** app.isPackaged — a shipped build recognises nothing by default. */
  packaged: boolean
}): HostResolution {
  const fromEnv = parseHosts(input.configured)
  const fromSettings = parseHosts((input.settings ?? []).join(','))
  const rejected = [...fromEnv.rejected, ...fromSettings.rejected]
  const deduped = [...new Set([...fromEnv.hosts, ...fromSettings.hosts])]
  if (deduped.length > 0) return { hosts: deduped, source: 'configured', rejected }

  // Dev only. A packaged build reaching this line recognises nothing, which is
  // the correct posture and is why the refusal below has to be good.
  if (!input.packaged) return { hosts: [...LOOPBACK_HOSTS], source: 'loopback-dev', rejected }

  return { hosts: [], source: 'none', rejected }
}

/**
 * What to tell someone whose install link or publish was refused.
 *
 * The dead end Magpie hit was an instruction that could not work. A refusal
 * that only says "not recognised" reproduces it, so this names the setting,
 * says where it lives, and gives the reason — because without the reason the
 * refusal reads as a bug and the next person routes around it with a default.
 */
export function registryHostHelp(rejected: readonly string[] = []): string {
  // M2: lead with what they DID set. Telling someone to configure a host they
  // configured is how a refusal reads as a bug.
  const preamble =
    rejected.length > 0
      ? `These entries are not hostnames and were ignored: ${rejected.join(', ')}. ` +
        `A hostname only — no scheme, no path, no port (registry.example.com, not ` +
        `https://registry.example.com/).\n\n`
      : ''
  return (
    preamble +
    `No registry host is configured, so this app recognises no install links and will not ` +
    `publish. Add the registry's hostname in Settings → Marketplace, or set ` +
    `${REGISTRY_HOST_SETTING} (comma-separated for more than one).\n\n` +
    `This is refused rather than defaulted on purpose: publishing sends a signed manifest ` +
    `and your payout address to whichever host is configured, so a host you did not choose ` +
    `is a redirect for your money and your trust bindings — not merely a broken link.`
  )
}

/** Is this host one we recognise? Exact match only — never a suffix. */
export function recognisesHost(resolution: HostResolution, host: string): boolean {
  // Both sides lowercased (M3): parseHosts normalises what it stores, and this
  // normalises what it is asked about. Lowercasing one side only made a cased
  // env value match nothing — a lockout rather than a bypass, but a lockout in
  // the exported predicate the next caller inherits.
  return resolution.hosts.includes(host.trim().toLowerCase())
}
