import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { HarnessId } from '../harness'

/**
 * A GATEWAY KEY PER HARNESS (E2E round, design §5 plumbing).
 *
 * One bearer for every card made `agents=` rules and `stays=session`
 * leak across cards (report-hp-facts.md §3, §4). The next step is a key
 * per harness: `~/.cookrew/route-keys.json` maps a harness id to the NAME
 * of a gateway key the owner minted with `magpie gateway-key add <name>`
 * — the bearer the card's process sends. An absent file, or an absent
 * entry, is today's `magpie-cookrew`, so nothing changes until the owner
 * writes the file. The file is 0600 and on the served deny list; the
 * names are never printed and never leave main.
 *
 * Nothing here mints a key: that is the owner's `magpie gateway-key add`,
 * with its own budget and model scope.
 */

export const ROUTE_KEYS_FILE = 'route-keys.json'
export type RouteKeys = Partial<Record<HarnessId, string>>

const HARNESSES: readonly HarnessId[] = ['claude', 'codex', 'opencode', 'pi']
/** A key name as magpie takes it: the characters a shell would not mangle. */
const KEY_RE = /^[A-Za-z0-9._-]{1,64}$/

export function routeKeysPath(home: string): string {
  return path.join(home, '.cookrew', ROUTE_KEYS_FILE)
}

/** The file's valid entries; a malformed file or entry reads as absent, never as a guess. */
export function readRouteKeys(home: string, read: (file: string) => string | null = readIfThere): RouteKeys {
  const raw = read(routeKeysPath(home))
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const keys: RouteKeys = {}
  for (const harness of HARNESSES) {
    const value = (parsed as Record<string, unknown>)[harness]
    if (typeof value === 'string' && KEY_RE.test(value)) keys[harness] = value
  }
  return keys
}

/** The bearer this harness's cards send: its own key, else the app's. */
export function keyFor(keys: RouteKeys, harness: HarnessId, appKey: string): string {
  return keys[harness] ?? appKey
}

function readIfThere(file: string): string | null {
  if (!existsSync(file)) return null
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}
