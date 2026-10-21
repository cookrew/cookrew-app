// HISTORY for Strata levels: one browser history entry per level, always a
// chain from /me down to where the camera is. Because the entries behind the
// current one are exactly its ancestors, the browser's Back is always "out",
// and the chain can be rebuilt from the current path alone after a reload.
import type { StrataPath } from '../../shared/strata'

/** 0 machines · 1 workspaces · 2 agents · 3 terminal. */
export const depthOf = (path: StrataPath): number => (path.agent ? 3 : path.workspace ? 2 : path.machine ? 1 : 0)

/** The path and every ancestor, root first: the history entries a level stands on. */
export const ancestry = (path: StrataPath): StrataPath[] => {
  const chain: StrataPath[] = [{}]
  if (path.machine) chain.push({ machine: path.machine })
  if (path.machine && path.workspace) chain.push({ machine: path.machine, workspace: path.workspace })
  if (path.machine && path.workspace && path.agent) chain.push({ machine: path.machine, workspace: path.workspace, agent: path.agent })
  return chain
}

const KEYS = ['machine', 'workspace', 'agent'] as const

/** How many levels two paths share from the root (0 = only /me). */
export const sharedDepth = (a: StrataPath, b: StrataPath): number => {
  let depth = 0
  for (const key of KEYS) {
    if (!a[key] || a[key] !== b[key]) break
    depth += 1
  }
  return depth
}

export interface HistoryMove {
  /** Entries to go back first (history.go(-back)). */
  back: number
  /** Then push these, in order. */
  push: StrataPath[]
}

/**
 * From one level to another while keeping history a chain of ancestors: step
 * back to the shared ancestor, then push every level down to the target. In is
 * one push, out is one back, a dive from /me pushes all three levels.
 */
export const planMove = (from: StrataPath, to: StrataPath): HistoryMove => {
  const shared = sharedDepth(from, to)
  return { back: depthOf(from) - shared, push: ancestry(to).slice(shared + 1) }
}

/** What each entry carries in history.state, so a popstate never re-parses ambiguously. */
export interface StrataHistoryState {
  strata: { depth: number; path: StrataPath }
}

export const historyState = (path: StrataPath): StrataHistoryState => ({ strata: { depth: depthOf(path), path } })

export const isStrataState = (state: unknown): state is StrataHistoryState =>
  typeof state === 'object' && state !== null && typeof (state as StrataHistoryState).strata?.depth === 'number'
