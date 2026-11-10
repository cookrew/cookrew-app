import { describe, expect, it } from 'vitest'
import { startZoomSync, type ZoomSyncDeps } from '../src/renderer/src/console/zoom-sync'
import type { ConsoleRoute } from '../src/renderer/src/console/console-route'

/**
 * INSIDE A MACHINE THE ADDRESS AND THE ZOOM ARE ONE THING SAID TWICE. Entering
 * at an address puts the view on the level it names; from then on every step
 * the view takes is written back, so a refresh lands where the eye was. The
 * outermost stop is not a level of the machine: arriving there leaves it.
 */

const M = '11111111-1111-4111-8111-111111111111'
const W = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const W2 = '8d0f7780-8536-41ef-a55c-f18fd2f01bf8'
const A = 'a1b2c3d4-0000-4000-8000-000000000001'
const at = (workspace: string | null = null, agent: string | null = null, side: 'agents' | 'items' = 'agents'): ConsoleRoute => ({ kind: 'machine', machine: M, workspace, agent, side })

const world = (route: ConsoleRoute, workspace: string | null = null) => {
  let zoom = { dir: 'agents' as 'agents' | 'items', v: -1, agent: null as string | null }
  let current = workspace
  let here = route
  const zoomListeners = new Set<() => void>()
  const workspaceListeners = new Set<() => void>()
  const w = {
    left: 0,
    route: () => here,
    zoom: () => zoom,
    moveZoom: (next: Partial<typeof zoom>) => {
      zoom = { ...zoom, ...next }
      zoomListeners.forEach((listener) => listener())
    },
    moveWorkspace: (id: string | null) => {
      current = id
      workspaceListeners.forEach((listener) => listener())
    },
    deps: {
      machine: M,
      router: { get: () => here, go: (next: ConsoleRoute) => void (here = next) },
      zoom: {
        get: () => zoom,
        subscribe: (listener: () => void) => (zoomListeners.add(listener), () => void zoomListeners.delete(listener)),
        go: (v: number, dir: 'agents' | 'items') => void (zoom = { ...zoom, v, dir }),
        focusAgent: (id: string | null) => void (zoom = { ...zoom, agent: id })
      },
      workspace: {
        current: () => current,
        subscribe: (listener: () => void) => (workspaceListeners.add(listener), () => void workspaceListeners.delete(listener))
      }
    } satisfies ZoomSyncDeps
  }
  return w
}

describe('entering at an address', () => {
  it('puts the view on the level it names', () => {
    for (const [route, expected] of [
      [at(), { dir: 'agents', v: -1, agent: null }],
      [at(W), { dir: 'agents', v: 1, agent: null }],
      [at(W, null, 'items'), { dir: 'items', v: 0, agent: null }],
      [at(W, A), { dir: 'agents', v: 2, agent: A }]
    ] as const) {
      const w = world(route, W)
      startZoomSync(w.deps)
      expect(w.zoom()).toEqual(expected)
      expect(w.route()).toEqual(route)
    }
  })

  it('keeps the address while the page does not yet know which workspace the view is on', () => {
    const w = world(at(W, A), null)
    startZoomSync(w.deps)
    expect(w.route()).toEqual(at(W, A))
    w.moveWorkspace(W)
    expect(w.route()).toEqual(at(W, A))
  })

  it('a workspace the machine no longer has: the address follows the one the view really stands on', () => {
    const w = world(at(W), null)
    startZoomSync(w.deps)
    w.moveWorkspace(W2)
    expect(w.route()).toEqual(at(W2))
  })
})

describe('every step the view takes is written back', () => {
  it('in to the crew, a card, a full view; across to the artifacts; and out again', () => {
    const w = world(at(), W)
    startZoomSync(w.deps)
    w.moveZoom({ v: 1 })
    expect(w.route()).toEqual(at(W))
    w.moveZoom({ v: 2, agent: A })
    expect(w.route()).toEqual(at(W, A))
    w.moveZoom({ v: 3 })
    expect(w.route()).toEqual(at(W, A))
    w.moveZoom({ dir: 'items', v: 0, agent: null })
    expect(w.route()).toEqual(at(W, null, 'items'))
    w.moveZoom({ dir: 'agents', v: -1 })
    expect(w.route()).toEqual(at())
  })

  it('switching workspace moves the address with it', () => {
    const w = world(at(W), W)
    startZoomSync(w.deps)
    w.moveWorkspace(W2)
    expect(w.route()).toEqual(at(W2))
  })

  it('arriving at the outermost stop leaves the machine', () => {
    const w = world(at(W), W)
    startZoomSync(w.deps)
    w.moveZoom({ v: -1.5 })
    expect(w.route()).toEqual(at())
    w.moveZoom({ v: -2 })
    expect(w.route()).toEqual({ kind: 'devices' })
  })

  it('stopped, it writes nothing more', () => {
    const w = world(at(W), W)
    const stop = startZoomSync(w.deps)
    stop()
    w.moveZoom({ v: -2 })
    expect(w.route()).toEqual(at(W))
  })
})
