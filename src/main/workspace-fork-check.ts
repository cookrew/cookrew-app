import { rmdir } from 'node:fs/promises'
import path from 'node:path'
import type { WorkspaceState } from '../shared/model'
import type { WorkspaceFork, WorkspaceRemovePlan } from '../shared/workspace-door'
import { countOf } from '../shared/workspace-door'
import { git } from './git'

/**
 * WHAT REMOVING A WORKSPACE LEAVES BEHIND, AND WHAT MAY GO WITH IT (box user
 * test 2, bug 11).
 *
 * A team fork puts each repository on a worktree under ~/.cookrew/worktrees and
 * a cookrew/<name> branch. Deleting the workspace left both, unmentioned. They
 * are offered for removal only when that loses nothing: no uncommitted change,
 * no commit held nowhere else, nobody else working there. The check runs again
 * at the moment of removal, because the offer may be minutes old.
 */

/** The branches a team fork makes (teams.ts · forkTeam). */
const FORK_BRANCH_PREFIX = 'cookrew/'

/** A big tree takes a while to delete; git's usual ceiling would kill it half way. */
const REMOVE_TIMEOUT_MS = 120_000

export interface ForkScope {
  /** Where fork worktrees live. Nothing outside it is ever offered. */
  worktreeRoot: string
  /** Every other workspace's folders: a worktree in use is not free to go. */
  otherDirs: readonly string[]
}

const isInside = (dir: string, root: string): boolean => {
  const inside = path.relative(root, dir)
  return inside.length > 0 && !inside.startsWith('..') && !path.isAbsolute(inside)
}

/** Why this worktree must stay, or null when removing it loses nothing. */
async function reasonToKeep(worktree: string, branch: string, otherDirs: readonly string[]): Promise<string | null> {
  if (otherDirs.some((dir) => dir === worktree || isInside(dir, worktree))) return 'Another workspace works in this worktree, so it stays.'
  if (!branch.startsWith(FORK_BRANCH_PREFIX)) return `Branch ${branch} was not made by Cookrew, so it stays.`
  // Ignored files too: `worktree remove` deletes them without asking, and a .env
  // or a report under an ignored folder is exactly what git cannot bring back.
  const status = (await git(worktree, ['status', '--porcelain', '--ignored'])).split('\n').filter(Boolean)
  if (status.some((line) => !line.startsWith('!!'))) return 'The worktree has uncommitted changes, so it stays.'
  if (status.length > 0) return 'The worktree holds ignored files git cannot bring back, so it stays.'
  const only = Number(await git(worktree, ['rev-list', '--count', 'HEAD', '--not', `--exclude=${branch}`, '--branches', '--tags', '--remotes']))
  return only > 0 ? `Branch ${branch} holds ${countOf(only, 'commit')} found nowhere else, so it stays.` : null
}

async function inspectFork(dir: string, otherDirs: readonly string[]): Promise<WorkspaceFork | null> {
  try {
    const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const reason = await reasonToKeep(dir, branch, otherDirs)
    return reason === null ? { worktree: dir, branch, removable: true } : { worktree: dir, branch, removable: false, reason }
  } catch (error) {
    // Not a repository any more, or git itself failed: nothing to offer.
    console.error(`Could not inspect worktree ${dir}:`, error)
    return null
  }
}

/** The forked worktrees among a workspace's folders, each with its verdict. */
export async function inspectForks(dirs: readonly string[], scope: ForkScope): Promise<WorkspaceFork[]> {
  const forks = await Promise.all(
    dirs.filter((dir) => isInside(dir, scope.worktreeRoot)).map((dir) => inspectFork(dir, scope.otherDirs))
  )
  return forks.filter((fork): fork is WorkspaceFork => fork !== null)
}

/**
 * A fork's folder holds one worktree per repository, and `worktree remove` takes
 * only that one. rmdir refuses a folder with anything left in it, so this can
 * only ever remove what is empty, and it stops at the root.
 */
async function pruneEmptyParents(worktree: string, root: string): Promise<void> {
  for (let dir = path.dirname(worktree); isInside(dir, root); dir = path.dirname(dir)) {
    try {
      await rmdir(dir)
    } catch {
      return
    }
  }
}

/** Remove a fork's worktree and branch, if that still loses nothing. */
export async function removeFork(
  fork: WorkspaceFork,
  scope: ForkScope
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [now] = await inspectForks([fork.worktree], scope)
  if (!now) return { ok: false, reason: `${fork.worktree} is no longer a worktree, so it was left alone.` }
  if (!now.removable) return { ok: false, reason: now.reason ?? 'It stays.' }
  try {
    const common = await git(fork.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    const repo = path.dirname(common)
    // Neither call is forced: git keeps its own refusal as a last check.
    await git(repo, ['worktree', 'remove', fork.worktree], REMOVE_TIMEOUT_MS)
    await git(repo, ['branch', '-D', now.branch])
    await pruneEmptyParents(fork.worktree, scope.worktreeRoot)
    return { ok: true }
  } catch (error) {
    const words = error instanceof Error ? error.message.split('\n')[0] : String(error)
    return { ok: false, reason: `Could not remove ${fork.worktree}: ${words}` }
  }
}

/** Everything the remove sheet has to say, from what the store holds. */
export function planWorkspaceRemove(input: {
  id: string
  name: string
  state: WorkspaceState
  forks: readonly WorkspaceFork[]
}): WorkspaceRemovePlan {
  const { id, name, state, forks } = input
  return {
    id,
    name,
    stops: state.nodes.filter((n) => n.kind === 'terminal').map((n) => n.name),
    notes: state.nodes.filter((n) => n.kind === 'note').length,
    browsers: state.nodes.filter((n) => n.kind === 'browser').length,
    keeps: state.dirs,
    forks
  }
}
