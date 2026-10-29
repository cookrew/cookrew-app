// History for the window's levels view: a path in memory, not the URL. The
// app's URL belongs to the canvas, and the window has no Back to share. The
// path is remembered across reloads and view switches, so the levels open
// where they were left; a remembered item that has gone lands on the nearest
// level that still exists.
//
// ONE PATH PER WINDOW, read by two: the levels view walks it, and the app
// header draws it as its route (device / workspace / agent) and moves it from
// any view — a tap on the workspace step lands on the workspace choice. So the
// path lives here, in a store, and the view only reads and writes it.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { parentOf, type StrataMachine, type StrataPath } from '../../../shared/strata'
import { samePath } from '../../../strata/levels/selection'
import type { ShellHistory } from '../../../strata/Shell'
import { LOCAL_MACHINE_ID } from './local-fleet'

export const LEVELS_PATH_KEY = 'cookrew.levels.path'
/** The last name the levels feed gave this desktop: the route's device step outside the levels view. */
export const LEVELS_DEVICE_KEY = 'cookrew.levels.device'

/** Where a window with nothing remembered opens: its own workspaces. */
export const HOME_PATH: StrataPath = { machine: LOCAL_MACHINE_ID }

/** The workspace choice: the level the route's workspace step lands on. */
export const WORKSPACES_PATH: StrataPath = { machine: LOCAL_MACHINE_ID }

const isId = (value: unknown): value is string | undefined => value === undefined || typeof value === 'string'

export const readPath = (raw: string | null): StrataPath | null => {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null
    const { machine, workspace, agent } = parsed
    if (!isId(machine) || !isId(workspace) || !isId(agent)) return null
    if ((agent && !workspace) || (workspace && !machine)) return null
    return { ...(machine ? { machine } : {}), ...(workspace ? { workspace } : {}), ...(agent ? { agent } : {}) }
  } catch {
    return null
  }
}

/** The deepest prefix of a path that still exists; a machine still connecting is given the benefit of the doubt. */
export const existing = (path: StrataPath, fleet: readonly StrataMachine[]): StrataPath => {
  const machine = fleet.find((m) => m.id === path.machine)
  if (!machine) return {}
  if (!path.workspace || machine.link === 'connecting') return path
  const workspace = machine.levels?.workspaces.find((w) => w.id === path.workspace)
  if (!workspace) return { machine: machine.id }
  return !path.agent || workspace.agents.some((a) => a.id === path.agent) ? path : { machine: machine.id, workspace: workspace.id }
}

/** What the route says for the levels path: names the header cannot look up without the fleet. */
export interface LevelsNames {
  machine: string | null
  workspace: { name: string; icon: string | null } | null
  agent: string | null
}

export interface LevelsRouteState {
  path: StrataPath
  names: LevelsNames
  /** Bumped to ask the shell for its finder (the header's More menu has no key to press). */
  find: number
}

export interface LevelsRoute {
  get: () => LevelsRouteState
  subscribe: (listener: () => void) => () => void
  go: (target: StrataPath) => void
  out: () => void
  name: (names: LevelsNames) => void
  requestFind: () => void
}

type Store = Pick<Storage, 'getItem' | 'setItem'>

const browserStorage = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const read = (storage: Store | null, key: string): string | null => {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

const write = (storage: Store | null, key: string, value: string): void => {
  try {
    storage?.setItem(key, value)
  } catch {
    // A full or blocked storage only forgets where the levels were left.
  }
}

const sameNames = (a: LevelsNames, b: LevelsNames): boolean =>
  a.machine === b.machine && a.workspace?.name === b.workspace?.name && a.workspace?.icon === b.workspace?.icon && a.agent === b.agent

export function createLevelsRoute(storage: Store | null = browserStorage()): LevelsRoute {
  let state: LevelsRouteState = {
    path: readPath(read(storage, LEVELS_PATH_KEY)) ?? HOME_PATH,
    names: { machine: read(storage, LEVELS_DEVICE_KEY), workspace: null, agent: null },
    find: 0
  }
  const listeners = new Set<() => void>()
  const publish = (next: LevelsRouteState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  const go = (target: StrataPath): void => {
    if (samePath(state.path, target)) return
    write(storage, LEVELS_PATH_KEY, JSON.stringify(target))
    publish({ ...state, path: target })
  }
  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    go,
    out: () => go(parentOf(state.path)),
    name: (names) => {
      if (sameNames(state.names, names)) return
      if (names.machine && names.machine !== state.names.machine) write(storage, LEVELS_DEVICE_KEY, names.machine)
      publish({ ...state, names })
    },
    requestFind: () => publish({ ...state, find: state.find + 1 })
  }
}

/** The window's one levels path. */
export const levelsRoute = createLevelsRoute()

export const useLevelsRoute = (route: LevelsRoute = levelsRoute): LevelsRouteState =>
  useSyncExternalStore(route.subscribe, route.get, route.get)

/** The names of a path's steps, as the fleet spells them. */
export const namesOf = (path: StrataPath, fleet: readonly StrataMachine[]): LevelsNames => {
  const machine = fleet.find((m) => m.id === (path.machine ?? LOCAL_MACHINE_ID))
  const workspace = path.workspace ? machine?.levels?.workspaces.find((w) => w.id === path.workspace) : undefined
  const agent = path.agent ? workspace?.agents.find((a) => a.id === path.agent) : undefined
  return {
    machine: machine?.levels ? machine.name : null,
    workspace: workspace ? { name: workspace.name, icon: workspace.icon } : null,
    agent: agent?.name ?? null
  }
}

export const useLevelsHistory = (fleet: StrataMachine[], loaded: boolean, route: LevelsRoute = levelsRoute): ShellHistory => {
  const { path } = useLevelsRoute(route)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!loaded) return
    const still = existing(path, fleet)
    if (samePath(still, path)) return
    setNotice('That item is gone. Showing the nearest level.')
    route.go(still)
  }, [loaded, fleet, path, route])

  useEffect(() => {
    if (loaded) route.name(namesOf(path, fleet))
  }, [loaded, fleet, path, route])

  const clearNotice = useCallback(() => setNotice(null), [])

  return { path, notice, clearNotice, go: route.go, out: route.out }
}
