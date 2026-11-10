/**
 * INSIDE A MACHINE THE ADDRESS AND THE ZOOM ARE ONE THING SAID TWICE.
 *
 * Entering at an address puts the view on the level it names; from then on
 * every step the view takes is written back (console-router.ts replaces the
 * entry), so a refresh or a shared link lands where the eye was. The zoom's
 * outermost stop is not a level of a machine: arriving there is leaving it,
 * and the console's own Devices level takes over.
 *
 * Pure over its deps: the zoom store, the router and "which workspace the
 * view is on" are handed in.
 */
import type { ConsoleRoute } from './console-route'
import { routeOfZoom, zoomOfRoute, type ZoomPlace } from './console-router'

export interface ZoomSyncDeps {
  readonly machine: string
  readonly router: { get(): ConsoleRoute; go(route: ConsoleRoute): void }
  readonly zoom: {
    get(): ZoomPlace
    subscribe(listener: () => void): () => void
    go(v: number, dir: ZoomPlace['dir']): void
    focusAgent(id: string | null): void
  }
  /** The workspace of this machine the view is on, once the machine has said. */
  readonly workspace: { current(): string | null; subscribe(listener: () => void): () => void }
}

export function startZoomSync(deps: ZoomSyncDeps): () => void {
  const route = deps.router.get()
  if (route.kind === 'machine' && route.machine === deps.machine) {
    const place = zoomOfRoute(route)
    deps.zoom.go(place.v, place.dir)
    deps.zoom.focusAgent(place.agent)
  }
  const write = (): void => {
    const workspace = deps.workspace.current()
    const zoom = deps.zoom.get()
    // Until the machine says which workspace the view is on, the address it was entered at stands.
    const here = deps.router.get()
    if (workspace === null && here.kind === 'machine' && here.workspace !== null && zoom.v > -1.5) return
    deps.router.go(routeOfZoom(zoom, deps.machine, workspace))
  }
  const offZoom = deps.zoom.subscribe(write)
  const offWorkspace = deps.workspace.subscribe(write)
  return () => {
    offZoom()
    offWorkspace()
  }
}
