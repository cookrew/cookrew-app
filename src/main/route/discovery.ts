import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { RouteGateway } from '../../shared/route'

/**
 * WHERE THE GATEWAY IS, AND WHO SAID SO (route program, core lane).
 *
 * Three sources, in the order they win:
 *   1. the plugin file ~/.cookrew/magpie.json — written by Magpie's own
 *      Agents page through our agent plugin (resources/magpie): url, v1, key
 *      and the default model the owner picked there. Source 'plugin'.
 *   2. MAGPIE_ADDR in the environment, the variable magpie itself honours.
 *   3. the port in ~/.config/magpie/settings.json (read-only, never written;
 *      $XDG_CONFIG_HOME/magpie when set), else 3425.
 * The key is the plugin's when it gave one, else `magpie-cookrew`: on this
 * machine the gateway takes any key and counts the call under it.
 *
 * Pure reads of the disk and the env; no network here (probe.ts).
 */

export const DEFAULT_PORT = 3425
export const DEFAULT_KEY = 'magpie-cookrew'
export const PLUGIN_FILE = 'magpie.json'

export interface DiscoveryEnv {
  home: string
  env: Readonly<Record<string, string | undefined>>
}

export interface PluginRoute {
  gateway: string
  v1: string | null
  key: string | null
  model: string | null
}

export function defaultDiscoveryEnv(): DiscoveryEnv {
  return { home: process.env.HOME ?? '', env: process.env }
}

export function pluginFilePath(d: DiscoveryEnv): string {
  return path.join(d.home, '.cookrew', PLUGIN_FILE)
}

export function settingsFilePath(d: DiscoveryEnv): string {
  const base = d.env.XDG_CONFIG_HOME && d.env.XDG_CONFIG_HOME !== '' ? d.env.XDG_CONFIG_HOME : path.join(d.home, '.config')
  return path.join(base, 'magpie', 'settings.json')
}

/** A dotted key read from nested JSON, or from a literal "a.b" key — the plugin writes one or the other. */
function dotted(obj: unknown, key: string): unknown {
  if (typeof obj !== 'object' || obj === null) return undefined
  const literal = (obj as Record<string, unknown>)[key]
  if (literal !== undefined) return literal
  let at: unknown = obj
  for (const part of key.split('.')) {
    if (typeof at !== 'object' || at === null) return undefined
    at = (at as Record<string, unknown>)[part]
  }
  return at
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/** The plugin file's route, or null when absent, unreadable, or without a gateway. */
export function readPluginRoute(d: DiscoveryEnv): PluginRoute | null {
  const file = pluginFilePath(d)
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const gateway = str(dotted(parsed, 'route.gateway'))
    if (!gateway) return null
    return {
      gateway: gateway.replace(/\/+$/, ''),
      v1: str(dotted(parsed, 'route.v1')),
      key: str(dotted(parsed, 'route.key')),
      model: str(dotted(parsed, 'route.model'))
    }
  } catch {
    return null
  }
}

/** The port magpie's settings name, read-only; null when the file or the key is absent. */
export function settingsPort(d: DiscoveryEnv): number | null {
  const file = settingsFilePath(d)
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const port = (parsed as { port?: unknown })?.port
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : null
  } catch {
    return null
  }
}

/** MAGPIE_ADDR as magpie reads it: `host:port`, `:port`, or a URL. */
export function parseAddr(addr: string): { url: string; port: number } | null {
  const trimmed = addr.trim()
  if (trimmed === '') return null
  try {
    const url = new URL(/^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed.startsWith(':') ? `127.0.0.1${trimmed}` : trimmed}`)
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
    const host = url.hostname === '0.0.0.0' || url.hostname === '' ? '127.0.0.1' : url.hostname
    return { url: `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`, port }
  } catch {
    return null
  }
}

export interface Discovered {
  gateway: RouteGateway
  /** The bearer every routed request carries. Main-only: never on RouteState. */
  key: string
  /** The plugin's default model, when the plugin named the gateway. */
  defaultModel: string | null
  /** Something on this machine names magpie: a binary, the plugin file, or MAGPIE_ADDR. */
  known: boolean
  /** A refusal, said out loud: the plugin file or MAGPIE_ADDR named a host off this machine. */
  why: string | null
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

/**
 * The gateway must be THIS machine's. The plugin file is written by another
 * program and MAGPIE_ADDR by whoever set the environment; a host off the
 * loopback would send every card's prompts — and the key — somewhere else.
 * COOKREW_ROUTE_REMOTE=1 is the owner's explicit say-so for a gateway on
 * another box (Share on local network); without it the address is refused.
 */
export function hostAllowed(url: string, env: DiscoveryEnv['env']): boolean {
  if (env.COOKREW_ROUTE_REMOTE === '1') return true
  try {
    return LOOPBACK.has(new URL(url).hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * The address to probe and the key to send. `hasBinary` is the caller's
 * `which magpie` (kept out of here so the pure part stays pure).
 */
export function discover(d: DiscoveryEnv, hasBinary: boolean): Discovered {
  const refused = (source: string, url: string): Discovered => ({
    gateway: { url: '', v1: '', port: 0, version: null, source: 'probe' },
    key: DEFAULT_KEY,
    defaultModel: null,
    known: false,
    why: `${source} names ${url}, which is not this machine; set COOKREW_ROUTE_REMOTE=1 to allow a remote gateway`
  })
  const plugin = readPluginRoute(d)
  if (plugin) {
    const parsed = parseAddr(plugin.gateway)
    const url = parsed?.url ?? plugin.gateway
    if (!hostAllowed(url, d.env)) return refused(`${PLUGIN_FILE}`, url)
    const port = parsed?.port ?? DEFAULT_PORT
    const v1 = plugin.v1 && hostAllowed(plugin.v1, d.env) ? plugin.v1 : `${url}/v1`
    return {
      gateway: { url, v1, port, version: null, source: 'plugin' },
      key: plugin.key ?? DEFAULT_KEY,
      defaultModel: plugin.model,
      known: true,
      why: null
    }
  }
  const fromEnv = d.env.MAGPIE_ADDR ? parseAddr(d.env.MAGPIE_ADDR) : null
  if (fromEnv && !hostAllowed(fromEnv.url, d.env)) return refused('MAGPIE_ADDR', fromEnv.url)
  const port = fromEnv?.port ?? settingsPort(d) ?? DEFAULT_PORT
  const url = fromEnv?.url ?? `http://127.0.0.1:${port}`
  return {
    gateway: { url, v1: `${url}/v1`, port, version: null, source: 'probe' },
    key: DEFAULT_KEY,
    defaultModel: null,
    known: hasBinary || fromEnv !== null,
    why: null
  }
}
