import { readFileSync } from 'node:fs'
import path from 'node:path'
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

/** The loopback ports of every Remote magpie provider; empty when the list cannot be read. */
export function remoteLoopbackPorts(d: DiscoveryEnv, read: (file: string) => string = (file) => readFileSync(file, 'utf8')): number[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(read(providersFile(d)))
  } catch {
    return []
  }
  const list = (parsed as { providers?: unknown })?.providers
  if (!Array.isArray(list)) return []
  const ports = new Set<number>()
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const provider = entry as Record<string, unknown>
    if (provider.preset !== 'remote-magpie') continue
    for (const field of ENDPOINT_FIELDS) {
      const port = portOf(provider[field])
      if (port !== null) ports.add(port)
    }
  }
  return [...ports].sort((a, b) => a - b)
}
