import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isTailnetPeer, type Tailnet } from './tailnet'
import { MAGPIE_FORWARD_PORTS } from '../../shared/remote-magpie'
import type { DiscoveryEnv } from './discovery'

/**
 * TUNNELS MADE BY HAND, KEPT FROM THE SANDBOX. A Remote magpie provider whose
 * address is this computer's loopback is a tunnel (`ssh -L`) to another
 * computer's Magpie, and it lands on that computer's loopback, where Magpie asks
 * no key (0.1.3935: a made-up key and none both answered 200). The form never
 * offers one (shared/remote-magpie.ts), but a person can add one in Magpie
 * itself, so its ports are read from Magpie's own provider list and denied to a
 * served sandbox with the gateway's (route/service.ts · gatewayPorts).
 *
 * Read fresh on every call (a spawn asks once), never cached: a tunnel added a
 * minute ago is denied to the next served spawn. Only addresses are read, never a key.
 */

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const ENDPOINT_FIELDS = ['anthropic', 'chat', 'responses', 'decide', 'url'] as const

export function providersFile(d: DiscoveryEnv): string {
  const base = d.env.XDG_CONFIG_HOME && d.env.XDG_CONFIG_HOME !== '' ? d.env.XDG_CONFIG_HOME : path.join(d.home, '.config')
  return path.join(base, 'magpie', 'providers.json')
}

/** Private HTTP-projection input, not a warning list and never part of RouteState. */
export function configuredEndpointInventory(d: DiscoveryEnv, read: (file: string) => string = (file) => readFileSync(file, 'utf8')): string[] | null {
  let data: unknown
  try {
    data = JSON.parse(read(providersFile(d)))
  } catch {
    // Cached route data can outlive a removed file: absence is not proof that
    // no configured endpoint contributed to the current snapshot.
    return null
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const providers = (data as { providers?: unknown }).providers
  if (providers === undefined) return []
  if (!Array.isArray(providers)) return null
  const endpoints: string[] = []
  for (const entry of providers) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
    const row = entry as Record<string, unknown>
    for (const field of ENDPOINT_FIELDS) {
      const value = row[field]
      if (value == null || value === '') continue
      if (typeof value !== 'string' || !URL.canParse(value)) return null
      const url = new URL(value)
      if (!url.hostname || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null
      // Strip credentials, path and query: only origin is used for host/port filtering.
      endpoints.push(url.origin)
    }
  }
  return endpoints
}

/**
 * Retain origins for the lifetime of a RouteService cache. A failed read is
 * immediately unknown; it becomes permanently unknown once catalog fetching
 * or decision caching has begun, since retained rows can outlive the gap.
 * Before then, a successful setup can recover from a missing startup file.
 */
export function retainEndpointInventory(read: () => string[] | null): (cacheStarted?: boolean) => string[] | null {
  let gap = false
  let retained: readonly string[] = []
  return (cacheStarted = true) => {
    let current: string[] | null = null
    try {
      current = read()
    } catch {
      // An unreadable file is the same as an unknown inventory.
    }
    if (current === null) {
      gap = gap || cacheStarted
      return null
    }
    retained = [...new Set([...retained, ...current])]
    return gap ? null : [...retained]
  }
}

const portOf = (raw: unknown): number | null => {
  if (typeof raw !== 'string') return null
  try {
    const url = new URL(raw)
    if (!LOOPBACK.has(url.hostname)) return null
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
  } catch {
    return null
  }
}

export interface LoopbackRemote {
  readonly id: string
  readonly port: number
  /**
   * True when this is Cookrew's own sealed link: the provider points at the
   * forwarder (`/peer/<device>` on a MAGPIE_FORWARD_PORTS port). It is not a
   * tunnel someone made by hand, and taking it out would cut the connection.
   */
  readonly managed: boolean
}

/** The loopback ports of every Remote magpie provider; empty when the list cannot be read. */
export function remoteLoopbackPorts(d: DiscoveryEnv, read: (file: string) => string = (file) => readFileSync(file, 'utf8')): number[] {
  return [...new Set(remoteLoopbackProviders(d, read).map((row) => row.port))].sort((a, b) => a - b)
}

/**
 * Each Remote magpie provider on this computer's loopback, by id: the panel warns of
 * every one, since a program that takes the port while the tunnel is down is handed
 * the key and every request Magpie sends there.
 */
export function remoteLoopbackProviders(d: DiscoveryEnv, read: (file: string) => string = (file) => readFileSync(file, 'utf8')): LoopbackRemote[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(read(providersFile(d)))
  } catch {
    return []
  }
  const list = (parsed as { providers?: unknown })?.providers
  if (!Array.isArray(list)) return []
  const rows: LoopbackRemote[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const provider = entry as Record<string, unknown>
    if (provider.preset !== 'remote-magpie' || typeof provider.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider.id)) continue
    const seen = new Set<number>()
    for (const field of ENDPOINT_FIELDS) {
      const port = portOf(provider[field])
      if (port !== null && !seen.has(port)) {
        seen.add(port)
        rows.push({ id: provider.id, port, managed: isForwarderUrl(provider[field], port) })
      }
    }
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id) || a.port - b.port)
}

/**
 * Is this address Cookrew's own forwarder? A provider Cookrew adds for "Use its
 * Magpie" names `http://127.0.0.1:<forward port>/peer/<device>`. Anything else on
 * loopback is a link a person made themselves — a tunnel — and is treated as one.
 */
function isForwarderUrl(raw: unknown, port: number): boolean {
  if (typeof raw !== 'string' || !MAGPIE_FORWARD_PORTS.includes(port)) return false
  try {
    const url = new URL(raw)
    return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && /^\/peer\/[A-Za-z0-9_-]{8,128}(\/|$)/.test(url.pathname)
  } catch {
    return false
  }
}

export interface PlainRemote {
  readonly id: string
  readonly host: string
}

/**
 * Each Remote magpie reached by plain http off a tailnet (owner ruling 2026-11-17:
 * plain http only where WireGuard is under it). The key and every request cross that
 * network unencrypted, so the panel names each one. Loopback ones are the tunnels
 * remoteLoopbackProviders names; they are not repeated here.
 */
export function plainRemoteProviders(d: DiscoveryEnv, read: (file: string) => string = (file) => readFileSync(file, 'utf8'), tailnet: Tailnet | null = null): PlainRemote[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(read(providersFile(d)))
  } catch {
    return []
  }
  const list = (parsed as { providers?: unknown })?.providers
  if (!Array.isArray(list)) return []
  const rows = new Map<string, PlainRemote>()
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const provider = entry as Record<string, unknown>
    if (provider.preset !== 'remote-magpie' || typeof provider.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider.id)) continue
    for (const field of ENDPOINT_FIELDS) {
      const raw = provider[field]
      if (typeof raw !== 'string') continue
      try {
        const url = new URL(raw)
        // Plain http is let be only to a peer this computer's Tailscale names (route/tailnet.ts), never a lookalike.
        if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname) && !isTailnetPeer(tailnet, url.hostname)) rows.set(provider.id, { id: provider.id, host: url.host })
      } catch {
        // An address Magpie itself could not use either: nothing to warn of.
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id))
}

