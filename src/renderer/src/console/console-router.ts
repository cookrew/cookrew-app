/**
 * THE ADDRESS FOLLOWS THE LEVEL (0.6.0).
 *
 * Where the view stands is the address (console-route.ts), so a refresh or a
 * shared link lands on the same level. The router keeps the two in step and
 * does it by REPLACING the entry the page is on, never by adding one:
 *
 *   BACK IS ALREADY ONE STEP OUT. On a web page the zoom view keeps a single
 *   history entry of its own while there is a step to take back (the picker,
 *   an open box, then the zoom one stop out: prompt/back-guard.ts), and takes
 *   that step when the browser pops it. A second thing pushing an entry per
 *   level would make one press of back skip a step or repeat one. So the
 *   level a back lands on is written here, into the entry that is left.
 *
 * The code on the way back from sign-in is read once and taken off the
 * address in the same breath: it is in no reload, no share sheet and no
 * history entry after that.
 */
import { consoleRoutePath, parseConsoleRoute, sameRoute, DEVICES_ROUTE, type ConsoleRoute, type ConsoleSide, type MachineRoute } from './console-route'

export interface HistoryPort {
  /** The entry's own state, kept across a replace (the back guard marks its entry there). */
  readonly state: unknown
  location(): { pathname: string; search: string }
  replace(state: unknown, path: string): void
  onPop(listener: () => void): () => void
}

export interface ConsoleRouter {
  get(): ConsoleRoute
  subscribe(listener: () => void): () => void
  go(route: ConsoleRoute): void
}

export const browserHistoryPort = (win: Window): HistoryPort => ({
  get state() {
    return win.history.state as unknown
  },
  location: () => ({ pathname: win.location.pathname, search: win.location.search }),
  replace: (state, path) => win.history.replaceState(state, '', path),
  onPop: (listener) => {
    win.addEventListener('popstate', listener)
    return () => win.removeEventListener('popstate', listener)
  }
})

export function createConsoleRouter(port: HistoryPort): ConsoleRouter {
  const listeners = new Set<() => void>()
  const read = (): ConsoleRoute => {
    const at = port.location()
    return parseConsoleRoute(at.pathname, at.search)
  }
  let route = read()
  // A credential is never left in the address bar.
  if (route.kind === 'auth-complete') port.replace(port.state, '/')

  const set = (next: ConsoleRoute): void => {
    if (sameRoute(next, route)) return
    route = next
    for (const listener of listeners) listener()
  }
  port.onPop(() => set(read()))

  return {
    get: () => route,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    go: (next) => {
      if (sameRoute(next, route)) return
      port.replace(port.state, consoleRoutePath(next))
      set(next)
    }
  }
}

/** Where a view stands, as the zoom says it (zoom/zoom-store.ts). */
export interface ZoomPlace {
  readonly dir: ConsoleSide
  readonly v: number
  readonly agent: string | null
}

/**
 * The address of where the view stands inside a machine. Between two stops it
 * is the one it is nearer to; the devices stop is not a level of a machine at
 * all, it is the way out of it. A workspace is named only once the page knows
 * which one the view is on.
 */
export function routeOfZoom(zoom: ZoomPlace, machine: string, workspace: string | null): ConsoleRoute {
  if (zoom.v < -1.5) return DEVICES_ROUTE
  const root: MachineRoute = { kind: 'machine', machine, workspace: null, agent: null, side: 'agents' }
  if (workspace === null) return root
  if (zoom.dir === 'items') return zoom.v < -0.5 ? root : { ...root, workspace, side: 'items' }
  if (zoom.v < 0) return root
  if (zoom.v >= 1.5 && zoom.agent !== null) return { ...root, workspace, agent: zoom.agent }
  return { ...root, workspace }
}

/** Where the view goes for an address inside a machine. */
export function zoomOfRoute(route: MachineRoute): ZoomPlace {
  if (route.workspace === null) return { dir: 'agents', v: -1, agent: null }
  if (route.agent !== null) return { dir: 'agents', v: 2, agent: route.agent }
  return route.side === 'items' ? { dir: 'items', v: 0, agent: null } : { dir: 'agents', v: 1, agent: null }
}
