// Git awareness for workspace directories. Every git call uses execFile with
// an ARG ARRAY (never a shell string) so directory paths and branch names
// can't be interpreted — no shell, no interpolation. Results are cached with
// a short TTL and coalesced per directory, so card renders and dir panels can
// ask freely without ever blocking a PTY spawn.

import { execFile } from 'node:child_process'
import type { GitInfo } from '../shared/model'

/** How long a gitInfo result is served from cache before a re-query. */
const CACHE_TTL_MS = 4000
/** Hard ceiling on a single git call so a wedged repo can't hang the app. */
const GIT_TIMEOUT_MS = 4000

const NOT_A_REPO: GitInfo = {
  isRepo: false,
  root: null,
  branch: null,
  dirty: false,
  ahead: 0,
  behind: 0
}

interface CacheEntry {
  at: number
  pending: Promise<GitInfo>
}

/** Run `git <args>` in cwd with no shell; resolve stdout or reject on error. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout.toString().trim())
      }
    )
  })
}

/** Parse `git status -sb` porcelain's header for ahead/behind counts. */
export function parseAheadBehind(statusBranchLine: string): { ahead: number; behind: number } {
  const ahead = /ahead (\d+)/.exec(statusBranchLine)
  const behind = /behind (\d+)/.exec(statusBranchLine)
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0
  }
}

async function queryGit(dir: string): Promise<GitInfo> {
  let root: string
  try {
    root = await git(dir, ['rev-parse', '--show-toplevel'])
  } catch {
    // Not a git repo (or git missing) — the common, non-error case.
    return NOT_A_REPO
  }
  try {
    const [branch, status] = await Promise.all([
      git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD'),
      git(dir, ['status', '-sb', '--porcelain=v1'])
    ])
    const lines = status.split('\n')
    const header = lines.find((l) => l.startsWith('##')) ?? ''
    const dirty = lines.some((l) => l.length > 0 && !l.startsWith('##'))
    return {
      isRepo: true,
      root,
      branch: branch === 'HEAD' ? null : branch,
      dirty,
      ...parseAheadBehind(header)
    }
  } catch (error) {
    return { ...NOT_A_REPO, isRepo: true, root, error: gitErrorMessage(error) }
  }
}

function gitErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class GitInfoCache {
  private cache = new Map<string, CacheEntry>()

  constructor(private query: (dir: string) => Promise<GitInfo> = queryGit) {}

  /** Cached gitInfo for a directory; coalesces concurrent callers. */
  info(dir: string, now = Date.now()): Promise<GitInfo> {
    const hit = this.cache.get(dir)
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.pending
    const pending = this.query(dir).catch((error) => ({
      ...NOT_A_REPO,
      error: gitErrorMessage(error)
    }))
    this.cache.set(dir, { at: now, pending })
    return pending
  }

  /** Drop a directory's cached result (e.g. after a worktree add). */
  invalidate(dir: string): void {
    this.cache.delete(dir)
  }
}

/** One-shot gitInfo without caching — for CLI/tests. */
export function gitInfo(dir: string): Promise<GitInfo> {
  return queryGit(dir)
}

/**
 * Create a git worktree for `branch` at `worktreePath`, based off the repo in
 * `repoDir`. Returns the created path on success. Never throws for the
 * caller's flow — resolves { ok:false, error } so team fork can fall back to
 * in-place instead of aborting the whole fork.
 */
export async function addWorktree(
  repoDir: string,
  worktreePath: string,
  branch: string
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  try {
    // -b creates the branch; if it exists, retry attaching without -b.
    await git(repoDir, ['worktree', 'add', '-b', branch, worktreePath]).catch(() =>
      git(repoDir, ['worktree', 'add', worktreePath, branch])
    )
    return { ok: true, path: worktreePath }
  } catch (error) {
    return { ok: false, error: gitErrorMessage(error) }
  }
}
