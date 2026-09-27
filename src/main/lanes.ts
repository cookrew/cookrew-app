import path from 'node:path'
import { fileSlug } from '../shared/slug'
import type { LaneInfo, LandResult } from '../shared/model'

/**
 * LANES — one agent, one worktree, one branch; and LANDING, which is how a
 * lane ends.
 *
 * THE PROBLEM. Several agents on one canvas share one workdir, and a shared
 * working tree is a shared mutable file: two agents editing the same repo
 * write over each other's uncommitted work, one agent's `git add -A` sweeps
 * up another's half-done change, and the tree the running app serves from
 * moves under it. The fix everybody reaches for by hand — "work in a
 * worktree" — then fails at the other end: branches pile up unmerged
 * (a hundred linked worktrees in one repo, cuts that were "done" but never
 * on dev) because merging back is a chore somebody has to remember, and
 * asking each agent to do it puts a git errand into a conversation that was
 * about something else.
 *
 * THE RULES THIS MODULE ENFORCES:
 *
 *   1. AN AGENT THAT WRITES CODE WRITES IT IN ITS OWN LANE. A lane is a
 *      linked worktree under `<repo>/.claude/worktrees/<slug>` on branch
 *      `cookrew/<slug>`, cut from the base branch the shared tree is on.
 *      Inside the repo so the tools that resolve upward (node_modules, a
 *      .env, an editor config) keep working; ignored by git through
 *      `.claude/worktrees/.gitignore` so it can never be committed.
 *
 *   2. THE SHARED TREE IS THE INTEGRATION TREE. Nobody edits there; it only
 *      ever moves forward by fast-forward. It has to be clean and on the
 *      base branch for any lane to land — a shared tree with uncommitted
 *      edits is exactly the accident this exists to prevent, and landing on
 *      top of it would bury the evidence.
 *
 *   3. LANDING IS A PRODUCT ACTION, NOT A PROMPT. The app does it: merge the
 *      base INTO the lane (so a conflict surfaces in the lane, where the
 *      agent that caused it can resolve it with its own context), run the
 *      gate there, then fast-forward the shared tree. No agent is asked to
 *      "merge to dev" in its conversation; the conversation stays about the
 *      work. An agent's part is only ever to commit.
 *
 *   4. NOTHING IS SILENT. A lane that is ahead of base is unlanded work and
 *      says so on its card; a conflict or a failed gate is a state the card
 *      shows, not a line in a log.
 *
 * Every git call is an ARG ARRAY through the injected runner — no shell, so
 * a branch name or path is never interpreted. The runner is injected so the
 * planning and the refusals can be tested against real temporary repos and
 * the wiring against none.
 */

/** Where lanes live, relative to the repo root. */
export const LANE_DIR = path.join('.claude', 'worktrees')
/** Every lane branch wears this prefix, the same one team paste already uses. */
export const LANE_BRANCH_PREFIX = 'cookrew/'

export interface LaneGit {
  /** `git <args>` in cwd; resolves trimmed stdout, rejects with the error. */
  run(cwd: string, args: string[]): Promise<string>
  /** A gate command in a lane; resolves { code, output } and never rejects. */
  exec(cwd: string, command: string, args: string[]): Promise<{ code: number; output: string }>
}

export interface LanePlan {
  slug: string
  path: string
  branch: string
}

/** Where a lane of this name would live. Pure. */
export function lanePlan(repoRoot: string, name: string): LanePlan {
  const slug = fileSlug(name, 'lane')
  return { slug, path: path.join(repoRoot, LANE_DIR, slug), branch: `${LANE_BRANCH_PREFIX}${slug}` }
}

/** True when `dir` is a lane path of `repoRoot` (by shape, not by asking git). */
export function isLanePath(repoRoot: string, dir: string): boolean {
  const rel = path.relative(path.join(repoRoot, LANE_DIR), dir)
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep)
}

/** The `git worktree list --porcelain` blocks, as records. Pure. */
export function parseWorktreeList(porcelain: string): { path: string; head: string; branch: string | null }[] {
  return porcelain
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const lines = block.split('\n')
      const field = (key: string): string | null => {
        const line = lines.find((l) => l === key || l.startsWith(`${key} `))
        return line === undefined ? null : line.slice(key.length).trim()
      }
      const branch = field('branch')
      return {
        path: field('worktree') ?? '',
        head: field('HEAD') ?? '',
        branch: branch ? branch.replace(/^refs\/heads\//, '') : null,
      }
    })
    .filter((w) => w.path.length > 0)
}

/** `git rev-list --left-right --count base...branch` → how far apart they are. Pure. */
export function parseLeftRight(out: string): { behind: number; ahead: number } {
  const [left, right] = out.trim().split(/\s+/).map((n) => Number(n) || 0)
  return { behind: left ?? 0, ahead: right ?? 0 }
}

/** The main (shared) tree of the repo a directory belongs to, or null off-repo. */
export async function repoOf(git: LaneGit, dir: string): Promise<{ root: string; main: string; base: string } | null> {
  let root: string
  let common: string
  try {
    ;[root, common] = await Promise.all([
      git.run(dir, ['rev-parse', '--show-toplevel']),
      git.run(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ])
  } catch {
    return null
  }
  const main = path.dirname(common)
  const base = await git.run(main, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')
  return { root, main, base }
}

async function laneState(git: LaneGit, lane: { path: string; head: string; branch: string | null }, main: string, base: string): Promise<LaneInfo> {
  const [status, conflicts, counts] = await Promise.all([
    git.run(lane.path, ['status', '--porcelain', '--untracked-files=no']).catch(() => ''),
    git.run(lane.path, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''),
    lane.branch && lane.path !== main
      ? git.run(main, ['rev-list', '--left-right', '--count', `${base}...${lane.branch}`]).catch(() => '0 0')
      : Promise.resolve('0 0'),
  ])
  const conflicted = conflicts.split('\n').filter((l) => l.length > 0)
  return {
    path: lane.path,
    branch: lane.branch,
    base,
    isMain: lane.path === main,
    dirty: status.length > 0,
    conflicts: conflicted,
    ...parseLeftRight(counts),
  }
}

/** Every worktree of the repo `dir` is in, the shared tree included, with where each stands against base. */
export async function listLanes(git: LaneGit, dir: string): Promise<LaneInfo[]> {
  const repo = await repoOf(git, dir)
  if (!repo) return []
  const listed = parseWorktreeList(await git.run(repo.main, ['worktree', 'list', '--porcelain']))
  return Promise.all(listed.map((lane) => laneState(git, lane, repo.main, repo.base)))
}

/**
 * Cut a lane from the shared tree's current branch. Refuses rather than
 * reusing: a lane name that already exists is somebody's work.
 */
export async function openLane(
  git: LaneGit,
  dir: string,
  name: string,
  ensureIgnored: (laneDir: string) => void
): Promise<{ ok: true; path: string; branch: string; base: string } | { ok: false; error: string }> {
  const repo = await repoOf(git, dir)
  if (!repo) return { ok: false, error: `${dir} is not in a git repo` }
  const plan = lanePlan(repo.main, name)
  try {
    ensureIgnored(path.join(repo.main, LANE_DIR))
    await git.run(repo.main, ['worktree', 'add', '-b', plan.branch, plan.path, repo.base])
    return { ok: true, path: plan.path, branch: plan.branch, base: repo.base }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
}

export interface LandOptions {
  /** The lane's worktree. */
  lanePath: string
  /** A command to pass in the lane before the shared tree moves (e.g. ['npm','run','typecheck']). */
  gate?: string[] | null
  /** Remove the worktree and its branch after a successful landing. */
  close?: boolean
}

/**
 * LAND a lane: base into the lane, gate in the lane, fast-forward the shared
 * tree. Every refusal is a reason the card can show; nothing here throws.
 */
export async function landLane(git: LaneGit, opts: LandOptions): Promise<LandResult> {
  const repo = await repoOf(git, opts.lanePath)
  if (!repo) return { ok: false, reason: 'not-a-lane', detail: `${opts.lanePath} is not in a git repo` }
  if (repo.root === repo.main) return { ok: false, reason: 'not-a-lane', detail: 'this is the shared tree, not a lane' }
  const branch = await git.run(opts.lanePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')
  if (branch === 'HEAD') return { ok: false, reason: 'not-a-lane', detail: 'the lane is not on a branch' }

  // Conflicts left from a previous attempt come first: "dirty" would hide them.
  const conflicts = (await git.run(opts.lanePath, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
    .split('\n')
    .filter((l) => l.length > 0)
  if (conflicts.length > 0) return { ok: false, reason: 'conflict', files: conflicts }
  const dirty = await git.run(opts.lanePath, ['status', '--porcelain', '--untracked-files=no']).catch(() => '')
  if (dirty.length > 0) {
    return { ok: false, reason: 'dirty', files: statusFiles(dirty) }
  }

  // The shared tree: on base, and clean. Landing over uncommitted edits there
  // would bury the very accident lanes exist to prevent.
  const mainBranch = await git.run(repo.main, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')
  if (mainBranch !== repo.base || mainBranch === 'HEAD') {
    return { ok: false, reason: 'main-branch', detail: `the shared tree is on ${mainBranch}` }
  }
  const mainDirty = await git.run(repo.main, ['status', '--porcelain', '--untracked-files=no']).catch(() => '')
  if (mainDirty.length > 0) {
    return { ok: false, reason: 'main-dirty', files: statusFiles(mainDirty) }
  }

  const before = parseLeftRight(await git.run(repo.main, ['rev-list', '--left-right', '--count', `${repo.base}...${branch}`]))
  if (before.ahead === 0) return { ok: false, reason: 'nothing', detail: 'the lane has no commits base does not' }

  // Base into the lane, so a conflict appears where the author can see it.
  try {
    await git.run(opts.lanePath, ['merge', '--no-edit', repo.base])
  } catch {
    const files = (await git.run(opts.lanePath, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
      .split('\n')
      .filter((l) => l.length > 0)
    if (files.length > 0) return { ok: false, reason: 'conflict', files }
    await git.run(opts.lanePath, ['merge', '--abort']).catch(() => undefined)
    return { ok: false, reason: 'conflict', files: [], detail: 'merge failed without conflict markers' }
  }

  if (opts.gate && opts.gate.length > 0) {
    const [command, ...args] = opts.gate
    const result = await git.exec(opts.lanePath, command, args)
    if (result.code !== 0) {
      return { ok: false, reason: 'gate', detail: result.output.split('\n').slice(-20).join('\n') }
    }
  }

  // The shared tree only ever moves forward; ff-only cannot conflict because
  // the lane now contains base.
  try {
    await git.run(repo.main, ['merge', '--ff-only', branch])
  } catch (error) {
    return { ok: false, reason: 'main-dirty', detail: message(error) }
  }
  const landed = await git.run(repo.main, ['rev-parse', '--short', 'HEAD']).catch(() => '')
  let closed = false
  if (opts.close) closed = (await closeLane(git, opts.lanePath)).ok
  return { ok: true, landed, commits: before.ahead, closed }
}

/**
 * Remove a lane. Only a lane whose commits are all on base is removed
 * without force — anything else is work, and work is not deleted by a button.
 */
export async function closeLane(git: LaneGit, lanePath: string, force = false): Promise<{ ok: true } | { ok: false; error: string }> {
  const repo = await repoOf(git, lanePath)
  if (!repo) return { ok: false, error: `${lanePath} is not in a git repo` }
  if (repo.root === repo.main) return { ok: false, error: 'the shared tree is not a lane' }
  const branch = await git.run(lanePath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')
  if (!force) {
    const dirty = await git.run(lanePath, ['status', '--porcelain', '--untracked-files=no']).catch(() => '')
    if (dirty.length > 0) return { ok: false, error: 'the lane has uncommitted changes' }
    if (branch !== 'HEAD') {
      const { ahead } = parseLeftRight(
        await git.run(repo.main, ['rev-list', '--left-right', '--count', `${repo.base}...${branch}`]).catch(() => '0 0')
      )
      if (ahead > 0) return { ok: false, error: `the lane has ${ahead} unlanded commit${ahead === 1 ? '' : 's'}` }
    }
  }
  try {
    await git.run(repo.main, ['worktree', 'remove', ...(force ? ['--force'] : []), lanePath])
    if (branch !== 'HEAD') await git.run(repo.main, ['branch', force ? '-D' : '-d', branch]).catch(() => undefined)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
}

/** The paths in `status --porcelain` output. The runner trims, so the first line may have lost its leading space. Pure. */
export function statusFiles(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\S{1,2}\s+/, ''))
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
