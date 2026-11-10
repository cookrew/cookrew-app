/**
 * THE CONSOLE'S ADDRESS IS WHERE YOU ARE (0.6.0).
 *
 * console.cookrew.dev is one static page; its host answers every path with the
 * same index.html and the page reads the level from the address:
 *
 *   /                              the account's machines
 *   /d/<machine>                   that machine's workspaces
 *   /d/<machine>/w/<ws>            that workspace's agents (?side=items: its artifacts)
 *   /d/<machine>/w/<ws>/a/<agent>  that agent's card
 *   /auth/complete?code&state      where the sign-in page hands back
 *
 * So a refresh, a shared link and the back key land on the level the address
 * names, and nothing about the level is kept in storage. An address is never
 * a credential: the code on the way back from sign-in is read once and the
 * page moves off it (console-session.ts).
 *
 * Pure: no window, no history. console-router.ts is the part that touches them.
 */
import { isMachineId } from '../../../shared/machine-relay'

export type ConsoleSide = 'agents' | 'items'

export type ConsoleRoute =
  | { readonly kind: 'devices' }
  | { readonly kind: 'machine'; readonly machine: string; readonly workspace: string | null; readonly agent: string | null; readonly side: ConsoleSide }
  | { readonly kind: 'auth-complete'; readonly code: string | null; readonly state: string | null; readonly error: string | null }

export type MachineRoute = Extract<ConsoleRoute, { kind: 'machine' }>

export const DEVICES_ROUTE: ConsoleRoute = { kind: 'devices' }

/** A workspace's or an agent's id as an app mints it: one path segment of plain characters, nothing to decode. */
const PLAIN_ID = /^[A-Za-z0-9_-]{1,64}$/

const segmentsOf = (pathname: string): string[] => pathname.split('/').filter((part) => part !== '')

/** The route an address names. Anything unreadable is the machines: this page is what every path is answered with. */
export function parseConsoleRoute(pathname: string, search = ''): ConsoleRoute {
  const parts = segmentsOf(pathname)
  if (parts.length === 2 && parts[0] === 'auth' && parts[1] === 'complete') {
    const query = new URLSearchParams(search)
    return { kind: 'auth-complete', code: query.get('code'), state: query.get('state'), error: query.get('error') }
  }
  if (parts[0] !== 'd' || !isMachineId(parts[1]?.toLowerCase())) return DEVICES_ROUTE
  const machine = parts[1].toLowerCase()
  if (parts.length === 2) return { kind: 'machine', machine, workspace: null, agent: null, side: 'agents' }
  if (parts[2] !== 'w' || !PLAIN_ID.test(parts[3] ?? '')) return DEVICES_ROUTE
  const workspace = parts[3]
  if (parts.length === 4) {
    const side: ConsoleSide = new URLSearchParams(search).get('side') === 'items' ? 'items' : 'agents'
    return { kind: 'machine', machine, workspace, agent: null, side }
  }
  if (parts.length !== 6 || parts[4] !== 'a' || !PLAIN_ID.test(parts[5])) return DEVICES_ROUTE
  return { kind: 'machine', machine, workspace, agent: parts[5], side: 'agents' }
}

/** The address of a route. The way back from sign-in has none: the page never goes there by itself. */
export function consoleRoutePath(route: ConsoleRoute): string {
  if (route.kind !== 'machine') return '/'
  const base = `/d/${route.machine}`
  if (route.workspace === null) return base
  if (route.agent !== null) return `${base}/w/${route.workspace}/a/${route.agent}`
  return `${base}/w/${route.workspace}${route.side === 'items' ? '?side=items' : ''}`
}

/** One level out: what the back of a level is when there is no history to go back through. */
export function routeOut(route: ConsoleRoute): ConsoleRoute {
  if (route.kind !== 'machine') return DEVICES_ROUTE
  if (route.agent !== null) return { ...route, agent: null }
  if (route.workspace !== null) return { ...route, workspace: null, side: 'agents' }
  return DEVICES_ROUTE
}

export const sameRoute = (a: ConsoleRoute, b: ConsoleRoute): boolean => consoleRoutePath(a) === consoleRoutePath(b) && a.kind === b.kind
