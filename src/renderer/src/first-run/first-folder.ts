import { useSyncExternalStore } from 'react'
import { cookrew } from '../api'
import { addWorkspaceDir, metaDirs, pickDirectory, setPrimaryDir } from '../workspace-v2'

/**
 * THE FOLDER THE FIRST AGENT WORKS IN. A fresh workspace sits in the home
 * folder, which is the wrong place to hand an agent, so a folder is chosen
 * first. Chosen here, it becomes the workspace's primary directory, and the
 * ordinary new-agent path then starts there with nothing special passed.
 *
 * Sending with none chosen opens the dialog, so the box never has a dead send
 * key. A cancelled dialog leaves the words in the box. Where nothing can pick
 * a folder the workspace's own stands.
 */

export type FolderOutcome = 'ready' | 'cancelled' | 'failed'

export interface FolderDeps {
  canPick: () => boolean
  pick: () => Promise<string | null>
  /** Make it the workspace's primary directory. */
  use: (dir: string) => Promise<void>
}

export interface FirstFolder {
  get: () => string | null
  subscribe: (listener: () => void) => () => void
  choose: () => Promise<FolderOutcome>
  /** Ready to start an agent, asking for a folder if none was chosen. */
  ready: () => Promise<FolderOutcome>
}

export function createFirstFolder(deps: FolderDeps): FirstFolder {
  let chosen: string | null = null
  const listeners = new Set<() => void>()
  const choose = async (): Promise<FolderOutcome> => {
    try {
      const dir = await deps.pick()
      if (dir === null) return 'cancelled'
      await deps.use(dir)
      chosen = dir
      for (const listener of listeners) listener()
      return 'ready'
    } catch {
      return 'failed'
    }
  }
  return {
    get: () => chosen,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    choose,
    ready: () => (chosen !== null || !deps.canPick() ? Promise.resolve('ready') : choose())
  }
}

/** The dialog's folder, added if it is new, as the active workspace's primary. */
async function useFolder(dir: string): Promise<void> {
  const { workspaces, activeId } = await cookrew().listWorkspaces()
  const meta = workspaces.find((w) => w.id === activeId)
  if (!meta) throw new Error('no active workspace')
  if (!metaDirs(meta).includes(dir)) await addWorkspaceDir(meta, dir)
  await setPrimaryDir(meta, dir)
}

export const firstFolder = createFirstFolder({
  canPick: () => typeof cookrew().pickDir === 'function',
  pick: pickDirectory,
  use: useFolder
})

export function useFirstFolder(): string | null {
  return useSyncExternalStore(firstFolder.subscribe, firstFolder.get, () => null)
}
