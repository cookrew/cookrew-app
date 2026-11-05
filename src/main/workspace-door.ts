import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { uniqueName, type WorkspaceMeta } from '../shared/model'
import type { WorkspaceCheck } from '../shared/workspace-door'
import type { WorkspaceStore } from './store'

/**
 * THE ONE CHECK IN FRONT OF A NEW WORKSPACE (box user test 2, bug 5).
 *
 * `store.createWorkspace` took any string, so a phone could make "Ghost" on a
 * folder that was never there, and its first agent died with no reason given.
 * The check lives here rather than in the sheet because the sheet is only one
 * of four routes: the phone, the CLI and the API reach the same two functions
 * in index.ts, and each of them refuses with this sentence.
 *
 * A refusal is for what cannot work. A taken name and a shared folder can
 * work, so those are said first and left to the person.
 */

export interface WorkspaceCheckInput {
  name: string
  dir: string
  workspaces: readonly Pick<WorkspaceMeta, 'name' | 'dir' | 'dirs'>[]
  /** The folder of the workspace on screen: where a suggestion starts from. */
  liveDir: string
  home?: string
}

/** ~, ~/x and a trailing slash, as a person types them. */
function typedPath(raw: string, home: string): string {
  const trimmed = raw.trim()
  const expanded = trimmed === '~' ? home : trimmed.startsWith('~/') ? path.join(home, trimmed.slice(2)) : trimmed
  return expanded.length > 1 ? expanded.replace(/[/\\]+$/, '') || expanded : expanded
}

/** Why this folder cannot hold a workspace, or null when it can. */
function refusal(dir: string): string | null {
  if (!path.isAbsolute(dir)) return `Type the whole path to the folder, starting with / or ~. "${dir}" is not one.`
  try {
    return statSync(dir).isDirectory() ? null : `${dir} is a file, not a folder. Choose a folder.`
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return `There is no folder at ${dir}. Choose one that exists.`
    return `Cookrew cannot open ${dir} (${code ?? 'unknown error'}). Choose another folder.`
  }
}

/**
 * Where the sheet opens. Beside the workspace you are in, because a new project
 * is usually a sibling of the last one, and because defaulting to the live
 * folder itself made every workspace share it without anyone choosing that.
 * A hidden folder is nobody's idea of a project: a fork's worktree under
 * ~/.cookrew is hidden, so those answer the home folder.
 */
export function suggestWorkspaceDir(liveDir: string, home: string): string {
  const inside = path.relative(home, liveDir)
  if (!liveDir || !inside || inside.startsWith('..') || path.isAbsolute(inside)) return home
  if (inside.split(path.sep).some((part) => part.startsWith('.'))) return home
  return path.dirname(liveDir)
}

export function checkWorkspaceCreate(input: WorkspaceCheckInput): WorkspaceCheck {
  const home = input.home ?? homedir()
  const owned = (dir: string) => input.workspaces.find((w) => (w.dirs.length > 0 ? w.dirs : [w.dir]).includes(dir))
  const beside = suggestWorkspaceDir(input.liveDir, home)
  // Opening on a folder somebody works in is a warning before anyone has done
  // anything, so the sheet opens empty and the person chooses.
  const suggestedDir = owned(beside) ? '' : beside
  const dir = typedPath(input.dir, home) || beside
  const wanted = input.name.trim() || 'Workspace'
  const name = uniqueName(wanted, input.workspaces.map((w) => w.name))
  const reason = refusal(dir)
  if (reason !== null) return { ok: false, name, dir, reason, notes: [], suggestedDir }
  const owner = owned(dir)
  const notes = [
    ...(input.dir.trim() === '' ? [`No folder given, so this one will work in ${dir}.`] : []),
    ...(name !== wanted ? [`"${wanted}" is taken, so this one will be called "${name}".`] : []),
    ...(owner ? [`"${owner.name}" already works in this folder, so their agents will share its files.`] : [])
  ]
  return { ok: true, name, dir, notes, suggestedDir }
}

/** What the store knows that the check needs. */
type DoorStore = Pick<WorkspaceStore, 'list' | 'focusedState' | 'createWorkspace' | 'switchWorkspace'>

/** The check, against this store's workspaces and the folder on screen. */
export function workspaceCheck(store: DoorStore, name: string, dir: string): WorkspaceCheck {
  return checkWorkspaceCreate({ name, dir, workspaces: store.list().workspaces, liveDir: store.focusedState.dir })
}

/**
 * MAKE A WORKSPACE, or refuse in the check's own sentence. `stay` is the phone's
 * way: the workspace exists, and the desktop's screen does not move for it.
 * `seed` gives it its first card, in that workspace whoever is looking.
 */
export function openWorkspace(
  store: DoorStore,
  input: { name: string; dir: string; stay: boolean; seed: (workspaceId: string) => void }
): WorkspaceMeta {
  const verdict = workspaceCheck(store, input.name, input.dir)
  if (!verdict.ok) throw new Error(verdict.reason)
  const meta = store.createWorkspace(input.name, verdict.dir)
  if (!input.stay) store.switchWorkspace(meta.id)
  input.seed(meta.id)
  return meta
}
