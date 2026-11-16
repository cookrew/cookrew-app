import { readFileSync } from 'node:fs'
import path from 'node:path'
import { tailnetHost } from '../../shared/remote-magpie'
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
        rows.push({ id: provider.id, port })
      }
    }
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id) || a.port - b.port)
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
export function plainRemoteProviders(d: DiscoveryEnv, read: (file: string) => string = (file) => readFileSync(file, 'utf8')): PlainRemote[] {
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
        if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname) && !tailnetHost(url.hostname)) rows.set(provider.id, { id: provider.id, host: url.host })
      } catch {
        // An address Magpie itself could not use either: nothing to warn of.
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id))
}

