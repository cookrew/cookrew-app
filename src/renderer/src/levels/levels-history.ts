// History for the window's levels view: a path in memory, not the URL. The
// app's URL belongs to the canvas, and the window has no Back to share. The
// path is remembered across reloads and view switches, so the levels open
// where they were left; a remembered item that has gone lands on the nearest
// level that still exists.
import { useCallback, useEffect, useState } from 'react'
import { parentOf, type StrataMachine, type StrataPath } from '../../../shared/strata'
import { samePath } from '../../../strata/levels/selection'
import type { ShellHistory } from '../../../strata/Shell'
import { LOCAL_MACHINE_ID } from './local-fleet'

export const LEVELS_PATH_KEY = 'cookrew.levels.path'

/** Where a window with nothing remembered opens: its own workspaces. */
export const HOME_PATH: StrataPath = { machine: LOCAL_MACHINE_ID }

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

const remembered = (): StrataPath => {
  try {
    return readPath(localStorage.getItem(LEVELS_PATH_KEY)) ?? HOME_PATH
  } catch {
    return HOME_PATH
  }
}

export const useLevelsHistory = (fleet: StrataMachine[], loaded: boolean): ShellHistory => {
  const [path, setPath] = useState<StrataPath>(remembered)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(LEVELS_PATH_KEY, JSON.stringify(path))
    } catch {
      // A full or blocked storage only forgets where the levels were left.
    }
  }, [path])

  useEffect(() => {
    if (!loaded) return
    const still = existing(path, fleet)
    if (samePath(still, path)) return
    setNotice('That item is gone. Showing the nearest level.')
    setPath(still)
  }, [loaded, fleet, path])

  const go = useCallback((target: StrataPath) => setPath((now) => (samePath(now, target) ? now : target)), [])
  const out = useCallback(() => setPath((now) => parentOf(now)), [])
  const clearNotice = useCallback(() => setNotice(null), [])

  return { path, notice, clearNotice, go, out }
}
