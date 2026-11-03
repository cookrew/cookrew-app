import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { DiscoveryEnv } from './discovery'

/**
 * THE SERVERS MAGPIE'S HUB SHARES (route program, Magpie settings).
 *
 * The panel's MCP row says what an agent gets through the hub, read from
 * magpie's own library file (~/.config/magpie/library.json, or under
 * $XDG_CONFIG_HOME). Names only: an entry can carry an env with a token in
 * it, and nothing but the `name` of each entry is ever copied out.
 *
 * Read-only, never written; magpie owns the file. A missing or unreadable
 * file is unknown (null), an empty library an empty list.
 */
export function libraryFilePath(d: DiscoveryEnv): string {
  const base = d.env.XDG_CONFIG_HOME && d.env.XDG_CONFIG_HOME !== '' ? d.env.XDG_CONFIG_HOME : path.join(d.home, '.config')
  return path.join(base, 'magpie', 'library.json')
}

export function readLibraryServers(d: DiscoveryEnv): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(libraryFilePath(d), 'utf8'))
  } catch {
    return null
  }
  const mcp = typeof parsed === 'object' && parsed !== null ? (parsed as { mcp?: unknown }).mcp : undefined
  if (!Array.isArray(mcp)) return mcp === null || mcp === undefined ? [] : null
  return mcp
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string' && name !== '')
}
