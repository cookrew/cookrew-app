import { useSyncExternalStore } from 'react'
import { cookrew, type CookrewApi } from '../api'
import { FIRST_SCREEN_COPY } from '../../../shared/first-run-copy'
import { addWorkspaceDir, dirLabel, metaDirs, pickDirectory, setPrimaryDir } from '../workspace-v2'

/**
 * THE FOLDER THE FIRST AGENT WORKS IN. A fresh workspace sits in the home
 * folder, which is the wrong place to hand an agent, so a folder is chosen
 * first. Chosen here, it becomes the workspace's primary directory, and the
 * ordinary new-agent path then starts there with nothing special passed.
 *
 * Sending with none chosen opens the dialog, so the box never has a dead send
 * key. A cancelled dialog leaves the words in the box. Where nothing can pick
 * a folder the workspace's own stands.
 *
 * The door's check stands in front of it (main/workspace-door.ts): one check of
 * what a folder must be, and its sentence is what a refusal says.
 *
 * Choosing it repoints the workspace, so the workspace takes its name, and the
 * screen says so: "My Workspace" on a folder called my-site told nobody anything.
 */

/** The folder the door answers for what was picked, or its refusal, thrown. */
export async function doorFolder(check: CookrewApi['checkWorkspace'], dir: string): Promise<string> {
  const verdict = await check(dirLabel(dir), dir)
  if (!verdict.ok) throw new Error(verdict.reason ?? FIRST_SCREEN_COPY.FOLDER_FAILED)
  return verdict.dir
}

/** The name a new install's only workspace is seeded with (main/store.ts). */
const SEEDED_NAME = 'My Workspace'

/** What the workspace should be called now; null to leave a name the person gave it. */
export function workspaceNameAfter(current: string, lastAuto: string | null, dir: string): string | null {
  return current === SEEDED_NAME || current === lastAuto ? dirLabel(dir) : null
}

export type FolderOutcome = 'ready' | 'cancelled' | 'failed'

export interface FolderDeps {
  canPick: () => boolean
  pick: () => Promise<string | null>
  /** Make it the workspace's primary directory. */
  use: (dir: string) => Promise<void>
}

export interface FirstFolder {
  get: () => string | null
  /** Why the last pick was refused, in the words it was refused in. */
  problem: () => string | null
  subscribe: (listener: () => void) => () => void
  choose: () => Promise<FolderOutcome>
  /** Ready to start an agent, asking for a folder if none was chosen. */
  ready: () => Promise<FolderOutcome>
}

export function createFirstFolder(deps: FolderDeps): FirstFolder {
  let chosen: string | null = null
  let refused: string | null = null
  const listeners = new Set<() => void>()
  const choose = async (): Promise<FolderOutcome> => {
    try {
      const dir = await deps.pick()
      if (dir === null) return 'cancelled'
      await deps.use(dir)
      chosen = dir
      refused = null
      for (const listener of listeners) listener()
      return 'ready'
    } catch (error) {
      refused = error instanceof Error ? error.message : null
      return 'failed'
    }
  }
  return {
    get: () => chosen,
    problem: () => refused,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    choose,
    ready: () => (chosen !== null || !deps.canPick() ? Promise.resolve('ready') : choose())
  }
}

/** The name given by the last pick: a change of mind renames again, a person's own name stays. */
let lastAuto: string | null = null

/** The dialog's folder, added if it is new, as the active workspace's primary, and its name. */
async function useFolder(picked: string): Promise<void> {
  const dir = await doorFolder(cookrew().checkWorkspace, picked)
  const { workspaces, activeId } = await cookrew().listWorkspaces()
  const meta = workspaces.find((w) => w.id === activeId)
  if (!meta) throw new Error('no active workspace')
  if (!metaDirs(meta).includes(dir)) await addWorkspaceDir(meta, dir)
  await setPrimaryDir(meta, dir)
  const name = workspaceNameAfter(meta.name, lastAuto, dir)
  if (name === null) return
  lastAuto = name
  // The folder is set: a name that does not take is not worth failing the pick for.
  await cookrew()
    .renameWorkspace(meta.id, name)
    .catch(() => undefined)
}

export const firstFolder = createFirstFolder({
  canPick: () => typeof cookrew().pickDir === 'function',
  pick: pickDirectory,
  use: useFolder
})

export function useFirstFolder(): string | null {
  return useSyncExternalStore(firstFolder.subscribe, firstFolder.get, () => null)
}
