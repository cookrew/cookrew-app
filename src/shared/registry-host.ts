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
}

/** Split a comma list into hostnames, dropping anything that is not one. */
function parseHosts(raw: string): string[] {
  return raw
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0 && HOSTNAME_RE.test(host))
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
  const chosen = [
    ...parseHosts(input.configured),
    ...parseHosts((input.settings ?? []).join(','))
  ]
  const deduped = [...new Set(chosen)]
  if (deduped.length > 0) return { hosts: deduped, source: 'configured' }

  // Dev only. A packaged build reaching this line recognises nothing, which is
  // the correct posture and is why the refusal below has to be good.
  if (!input.packaged) return { hosts: [...LOOPBACK_HOSTS], source: 'loopback-dev' }

  return { hosts: [], source: 'none' }
}

/**
 * What to tell someone whose install link or publish was refused.
 *
 * The dead end Magpie hit was an instruction that could not work. A refusal
 * that only says "not recognised" reproduces it, so this names the setting,
 * says where it lives, and gives the reason — because without the reason the
 * refusal reads as a bug and the next person routes around it with a default.
 */
export function registryHostHelp(): string {
  return (
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
  return resolution.hosts.includes(host.trim().toLowerCase())
}
