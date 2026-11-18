import { readFileSync } from 'node:fs'
import { DIRECT } from '../../shared/route'
import type { LiveValues } from '../../shared/launch-settings'
import { REMOTE_MAGPIE_PRESET } from '../../shared/remote-magpie'
import type { DiscoveryEnv } from './discovery'
import { providersFile } from './remote-ports'

/**
 * THE TWO MAGPIE SWITCHES, ENFORCED IN MAIN (lane Magpie, scope 2).
 *
 * The panel hiding a remote model is not the gate: a route reaches the spawn env
 * from the rail, the phone, the API, Sous, a saved default or Magpie's own plugin
 * file. So the route service asks `gateRoute` on every route choice and every
 * dispatch, and the answer is read fresh each time (the switches, and Magpie's
 * provider list, which the owner edits in Magpie's own window).
 *
 * A route can reach another computer's Magpie in three ways Magpie offers
 * (0.1.3935): one of that computer's own models or groups (`<remote id>/…`), a
 * group of this computer with one of them among its members, and a provider whose
 * `fallback` names one. All three are followed. What cannot be followed (a group
 * Magpie computes itself, such as `group/auto`, a loop, a list that does not
 * parse) is `unknown`, and unknown is refused while "Magpie remote" is off.
 *
 * Unknown switches are refused outright: no route, every card direct.
 */

export type RemoteReach = 'local' | 'remote' | 'unknown'

export interface MagpieRouting {
  /** Ids of providers that are another computer's Magpie. */
  readonly remote: readonly string[]
  /** Each group's members that are on. */
  readonly groups: Readonly<Record<string, readonly string[]>>
  /** Each provider's fallback models. */
  readonly fallback: Readonly<Record<string, readonly string[]>>
}

const EMPTY: MagpieRouting = { remote: [], groups: {}, fallback: {} }
const MAX_DEPTH = 16
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])

/** Only ids, member lists and fallbacks are kept: never a key or an address. */
export function parseMagpieRouting(text: string): MagpieRouting | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const { providers, groups } = parsed as { providers?: unknown; groups?: unknown }
  if (providers !== undefined && !Array.isArray(providers)) return null
  if (groups !== undefined && !Array.isArray(groups)) return null
  const remote: string[] = []
  const fallback: Record<string, string[]> = {}
  for (const entry of (providers as unknown[] | undefined) ?? []) {
    if (typeof entry !== 'object' || entry === null) return null
    const p = entry as { id?: unknown; preset?: unknown; fallback?: unknown }
    if (typeof p.id !== 'string') return null
    if (p.preset === REMOTE_MAGPIE_PRESET) remote.push(p.id)
    const falls = strings(p.fallback)
    if (falls.length > 0) fallback[p.id] = falls
  }
  const groupMap: Record<string, string[]> = {}
  for (const entry of (groups as unknown[] | undefined) ?? []) {
    if (typeof entry !== 'object' || entry === null) return null
    const g = entry as { id?: unknown; members?: unknown; off?: unknown }
    if (typeof g.id !== 'string') return null
    const off = new Set(strings(g.off))
    groupMap[g.id] = strings(g.members).filter((m) => !off.has(m))
  }
  return { remote, groups: groupMap, fallback }
}

/** Magpie's provider list, read fresh. Missing = nothing set up; anything else unreadable = null. */
export function readMagpieRouting(d: DiscoveryEnv, read: (file: string) => string = (file) => readFileSync(file, 'utf8')): MagpieRouting | null {
  let text: string
  try {
    text = read(providersFile(d))
  } catch (error) {
    return (error as { code?: unknown })?.code === 'ENOENT' ? EMPTY : null
  }
  return parseMagpieRouting(text)
}

const worst = (a: RemoteReach, b: RemoteReach): RemoteReach => (a === 'remote' || b === 'remote' ? 'remote' : a === 'unknown' || b === 'unknown' ? 'unknown' : 'local')

export function routeReach(route: string, routing: MagpieRouting | null): RemoteReach {
  if (route === DIRECT) return 'local'
  if (routing === null) return 'unknown'
  if (routing.remote.length === 0) return 'local'
  return reachOf(route, routing, new Set(), 0)
}

function reachOf(route: string, routing: MagpieRouting, seen: Set<string>, depth: number): RemoteReach {
  if (seen.has(route) || depth > MAX_DEPTH) return 'unknown'
  const path = new Set(seen).add(route)
  const slash = route.indexOf('/')
  if (slash <= 0) return 'unknown'
  const head = route.slice(0, slash)
  if (head === 'group') {
    const members = routing.groups[route.slice(slash + 1)]
    if (members === undefined) return 'unknown'
    return members.reduce<RemoteReach>((acc, member) => worst(acc, reachOf(member, routing, path, depth + 1)), 'local')
  }
  if (routing.remote.includes(head)) return 'remote'
  const falls = routing.fallback[head] ?? []
  return falls.reduce<RemoteReach>((acc, model) => worst(acc, reachOf(model, routing, path, depth + 1)), 'local')
}

export type GateAnswer = { readonly ok: true } | { readonly ok: false; readonly why: string }

export const GATE_UNREAD = 'Magpie’s switches could not be read, so nothing is routed.'
export const GATE_MAGPIE_OFF = 'Magpie is switched off in Launch settings.'
export const GATE_REMOTE_OFF = 'This route can reach another computer’s Magpie, and Magpie remote is switched off in Launch settings.'

export function gateRoute(route: string, switches: LiveValues | null, routing: MagpieRouting | null): GateAnswer {
  if (route === DIRECT) return { ok: true }
  if (switches === null) return { ok: false, why: GATE_UNREAD }
  if (switches.magpie !== true) return { ok: false, why: GATE_MAGPIE_OFF }
  if (switches.magpieRemote === true) return { ok: true }
  return routeReach(route, routing) === 'local' ? { ok: true } : { ok: false, why: GATE_REMOTE_OFF }
}
