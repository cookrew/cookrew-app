import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LANE_DIR,
  closeLane,
  isLanePath,
  landLane,
  lanePlan,
  listLanes,
  openLane,
  parseLeftRight,
  parseWorktreeList,
  repoOf,
  statusFiles,
  type LaneGit,
} from '../src/main/lanes'

/**
 * LANES, against real repositories in a temp dir.
 *
 * What matters is the RULES, not that git works: a lane is cut from the
 * shared tree's branch and lives where the tools can find node_modules; a
 * landing refuses a dirty lane, a dirty shared tree, and a shared tree on
 * the wrong branch; a conflict stops in the lane with its files named; a
 * gate that fails stops before the shared tree moves; and a successful
 * landing only ever fast-forwards.
 */

const git: LaneGit = {
  run: (cwd, args) =>
    new Promise((resolve, reject) =>
      execFile('git', args, { cwd, timeout: 10_000 }, (error, stdout) =>
        error ? reject(error) : resolve(stdout.toString().trim())
      )
    ),
  exec: (cwd, command, args) =>
    new Promise((resolve) =>
      execFile(command, args, { cwd, timeout: 10_000 }, (error, stdout, stderr) =>
        resolve({ code: error ? 1 : 0, output: `${stdout}${stderr}` })
      )
    ),
}

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
}

function initRepo(): string {
  // git answers real paths; on macOS the temp dir is a symlink.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cookrew-lanes-')))
  sh(dir, ['init', '-b', 'dev'])
  sh(dir, ['config', 'user.email', 'test@cookrew.dev'])
  sh(dir, ['config', 'user.name', 'Test'])
  writeFileSync(path.join(dir, 'README.md'), '# repo\n')
  sh(dir, ['add', '.'])
  sh(dir, ['commit', '-m', 'init'])
  return dir
}

function commit(dir: string, file: string, text: string, msg = `edit ${file}`): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  writeFileSync(path.join(dir, file), text)
  sh(dir, ['add', file])
  sh(dir, ['commit', '-m', msg])
}

/** A package.json in a lane, with only what the gate reads: scripts. */
function scripts(lane: string, entries: Record<string, string> | null): void {
  const file = path.join(lane, 'package.json')
  writeFileSync(file, entries === null ? '{ "name": "r", "version": "0.0.0" }\n' : JSON.stringify({ name: 'r', version: '0.0.0', scripts: entries }))
  sh(lane, ['add', 'package.json'])
  sh(lane, ['commit', '-m', 'scripts'])
}

const ignore = (laneDir: string): void => {
  mkdirSync(laneDir, { recursive: true })
  writeFileSync(path.join(laneDir, '.gitignore'), '*\n')
}

async function cut(repo: string, name = 'feature'): Promise<string> {
  const opened = await openLane(git, repo, name, ignore)
  if (!opened.ok) throw new Error(opened.error)
  return opened.path
}

describe('where a lane lives', () => {
  it('is inside the repo, under .claude/worktrees, on a cookrew/ branch', () => {
    const plan = lanePlan('/r', 'Fix The Wall!')
    expect(plan.path).toBe(path.join('/r', LANE_DIR, 'fix-the-wall'))
    expect(plan.branch).toBe('cookrew/fix-the-wall')
  })

  it('recognises a lane path by shape and nothing else', () => {
    expect(isLanePath('/r', '/r/.claude/worktrees/x')).toBe(true)
    expect(isLanePath('/r', '/r/.claude/worktrees/x/src')).toBe(false)
    expect(isLanePath('/r', '/r')).toBe(false)
    expect(isLanePath('/r', '/elsewhere/.claude/worktrees/x')).toBe(false)
  })

  it('reads status paths whether or not the runner trimmed the first line', () => {
    expect(statusFiles(' M a.txt\nMM b.txt\nA  c.txt')).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(statusFiles('M a.txt')).toEqual(['a.txt'])
  })

  it('reads git’s worktree list and the left-right count', () => {
    const list = parseWorktreeList('worktree /r\nHEAD abc\nbranch refs/heads/dev\n\nworktree /r/.claude/worktrees/x\nHEAD def\nbranch refs/heads/cookrew/x\n\nworktree /r/d\nHEAD 123\ndetached\n')
    expect(list.map((w) => w.branch)).toEqual(['dev', 'cookrew/x', null])
    expect(parseLeftRight('2\t5')).toEqual({ behind: 2, ahead: 5 })
  })
})

describe('opening a lane', () => {
  it('cuts a worktree from the shared tree’s branch, ignored by git', async () => {
    const repo = initRepo()
    const lane = await cut(repo, 'feature')
    expect(lane).toBe(path.join(repo, LANE_DIR, 'feature'))
    expect(sh(lane, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('cookrew/feature')
    expect(sh(repo, ['status', '--porcelain'])).toBe('')
    expect(readFileSync(path.join(repo, LANE_DIR, '.gitignore'), 'utf8')).toBe('*\n')
    const found = await repoOf(git, lane)
    expect(found).toEqual({ root: lane, main: repo, base: 'dev' })
  })

  it('refuses a name already taken — that is somebody’s work', async () => {
    const repo = initRepo()
    await cut(repo, 'feature')
    const again = await openLane(git, repo, 'feature', ignore)
    expect(again.ok).toBe(false)
  })

  it('refuses outside a repo', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-norepo-'))
    expect((await openLane(git, dir, 'x', ignore)).ok).toBe(false)
  })
})

describe('what the lanes look like', () => {
  it('lists the shared tree and every lane with how far each is from base', async () => {
    const repo = initRepo()
    const lane = await cut(repo)
    commit(lane, 'a.txt', 'a')
    commit(lane, 'b.txt', 'b')
    commit(repo, 'c.txt', 'c')
    writeFileSync(path.join(lane, 'README.md'), 'changed\n')
    const lanes = await listLanes(git, lane)
    const main = lanes.find((l) => l.isMain)!
    const mine = lanes.find((l) => l.path === lane)!
    expect(main.branch).toBe('dev')
    expect(mine).toMatchObject({ branch: 'cookrew/feature', base: 'dev', ahead: 2, behind: 1, dirty: true, conflicts: [] })
  })
})

describe('landing', () => {
  it('fast-forwards the shared tree and can close the lane behind it', async () => {
    const repo = initRepo()
    const lane = await cut(repo)
    commit(lane, 'a.txt', 'a')
    const result = await landLane(git, { lanePath: lane, close: true })
    expect(result).toMatchObject({ ok: true, commits: 1, closed: true })
    expect(sh(repo, ['log', '--oneline']).split('\n')).toHaveLength(2)
    expect(sh(repo, ['worktree', 'list']).split('\n')).toHaveLength(1)
    expect(sh(repo, ['branch', '--list', 'cookrew/feature'])).toBe('')
  })

  it('takes base into the lane first, so the shared tree only ever moves forward', async () => {
    const repo = initRepo()
    const lane = await cut(repo)
    commit(lane, 'a.txt', 'a')
    commit(repo, 'c.txt', 'c')
    const result = await landLane(git, { lanePath: lane })
    expect(result.ok).toBe(true)
    // dev has both, and the lane's merge commit — never a merge made in the shared tree.
    expect(sh(repo, ['log', '--oneline']).split('\n').length).toBeGreaterThanOrEqual(3)
    expect(sh(repo, ['rev-parse', 'dev'])).toBe(sh(lane, ['rev-parse', 'HEAD']))
  })

  it('refuses a lane with uncommitted changes — the agent’s part is to commit', async () => {
    const repo = initRepo()
    const lane = await cut(repo)
    commit(lane, 'a.txt', 'a')
    writeFileSync(path.join(lane, 'a.txt'), 'edited')
    expect(await landLane(git, { lanePath: lane })).toMatchObject({ ok: false, reason: 'dirty', files: ['a.txt'] })
  })

  it('refuses when the shared tree has uncommitted edits — the accident lanes exist to prevent', async () => {
    const repo = initRepo()
    const lane = await cut(repo)
    commit(lane, 'a.txt', 'a')
    writeFileSync(path.join(repo, 'README.md'), 'someone edited the shared tree\n')
    const result = await landLane(git, { lanePath: lane })
    expect(result).toMatchObject({ ok: false, reason: 'main-dirty', files: ['README.md'] })
    expect(sh(repo, ['log', '--oneline']).split('\n')).toHaveLength(1)
  })

  it('refuses when the shared tree is not on the base branch', async () => {
    const repo = initRepo()
    const lane = await cut(repo)
    commit(lane, 'a.txt', 'a')
    // repoOf reads base from the shared tree's HEAD, so this is the detached case.
    sh(repo, ['checkout', '--detach'])
    expect(await landLane(git, { lanePath: lane })).toMatchObject({ ok: false, reason: 'main-branch' })
  })

  it('stops in the lane on a conflict and names the files; the shared tree is untouched', async () => {
    const repo = initRepo()
    const lane = await cut(repo)
    commit(lane, 'README.md', '# lane\n')
    commit(repo, 'README.md', '# dev\n')
    const result = await landLane(git, { lanePath: lane })
    expect(result).toMatchObject({ ok: false, reason: 'conflict', files: ['README.md'] })
    expect(sh(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dev')
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# dev\n')
    // And the lane shows it, so the card can.
    const mine = (await listLanes(git, lane)).find((l) => l.path === lane)!
    expect(mine.conflicts).toEqual(['README.md'])
    // A second LAND says conflict again, not dirty.
    expect((await landLane(git, { lanePath: lane })).ok === false && (await landLane(git, { lanePath: lane }))).toMatchObject({ reason: 'conflict' })
  })

  it('runs the gate in the lane and stops before the shared tree moves when it fails', async () => {
    const repo = initRepo()
    const lane = await cut(repo)
    commit(lane, 'a.txt', 'a')
    const failed = await landLane(git, { lanePath: lane, gate: ['sh', '-c', 'echo typecheck failed; exit 1'] })
    expect(failed).toMatchObject({ ok: false, reason: 'gate' })
    expect(failed.ok === false && failed.detail).toContain('typecheck failed')
    expect(sh(repo, ['log', '--oneline']).split('\n')).toHaveLength(1)
    const passed = await landLane(git, { lanePath: lane, gate: ['sh', '-c', 'exit 0'] })
    expect(passed.ok).toBe(true)
  })

  /**
   * THE GATE IS THE REPO'S, NOT THE CALLER'S. No caller of LAND passed a
   * gate, so an agent whose commit did not even typecheck landed on the
   * shared tree the running app serves from. The default is decided here:
   * an explicit gate wins; else the repo's own `gate:lane` script; else its
   * `typecheck`; else none — and the answer says which one ran, so the card
   * can. A test suite is never a default gate: it is minutes, and a landing
   * is a press.
   */
  it('runs the repo’s typecheck by default, and says so — a commit that does not typecheck never lands', async () => {
    const repo = initRepo()
    const lane = await cut(repo)
    scripts(lane, { typecheck: 'echo tsc: 2 errors; exit 1' })
    const failed = await landLane(git, { lanePath: lane })
    expect(failed).toMatchObject({ ok: false, reason: 'gate', gate: 'npm run typecheck' })
    expect(failed.ok === false && failed.detail).toContain('tsc: 2 errors')
    expect(sh(repo, ['log', '--oneline']).split('\n')).toHaveLength(1)
    scripts(lane, { typecheck: 'exit 0' })
    const passed = await landLane(git, { lanePath: lane })
    expect(passed).toMatchObject({ ok: true, gate: 'npm run typecheck' })
  })

  it('prefers the repo’s own gate:lane over typecheck', async () => {
    const repo = initRepo()
    const lane = await cut(repo)
    // typecheck would fail; gate:lane is what the repo asked for.
    scripts(lane, { 'gate:lane': 'exit 0', typecheck: 'exit 1' })
    expect(await landLane(git, { lanePath: lane })).toMatchObject({ ok: true, gate: 'npm run gate:lane' })
  })

  it('runs no gate when the repo offers neither, and says none ran', async () => {
    const repo = initRepo()
    const lane = await cut(repo)
    scripts(lane, null)
    expect(await landLane(git, { lanePath: lane })).toMatchObject({ ok: true, gate: null })
    // A test suite is never picked up as a gate.
    const other = initRepo()
    const second = await cut(other)
    scripts(second, { test: 'exit 1', build: 'exit 1' })
    expect(await landLane(git, { lanePath: second })).toMatchObject({ ok: true, gate: null })
  })

  it('lets an explicit gate override the repo’s, and reports the one that ran', async () => {
    const repo = initRepo()
    const lane = await cut(repo)
    scripts(lane, { 'gate:lane': 'exit 1', typecheck: 'exit 1' })
    const result = await landLane(git, { lanePath: lane, gate: ['sh', '-c', 'exit 0'] })
    expect(result).toMatchObject({ ok: true, gate: 'sh -c exit 0' })
  })

  it('reports no gate on a repo with no package.json at all', async () => {
    const repo = initRepo()
    const lane = await cut(repo)
    commit(lane, 'a.txt', 'a')
    expect(await landLane(git, { lanePath: lane })).toMatchObject({ ok: true, gate: null })
  })

  it('has nothing to land when the lane is not ahead', async () => {
    const repo = initRepo()
    const lane = await cut(repo)
    expect(await landLane(git, { lanePath: lane })).toMatchObject({ ok: false, reason: 'nothing' })
  })

  it('will not land the shared tree onto itself', async () => {
    const repo = initRepo()
    expect(await landLane(git, { lanePath: repo })).toMatchObject({ ok: false, reason: 'not-a-lane' })
  })
})

describe('closing a lane', () => {
  it('refuses while the lane has unlanded commits or uncommitted changes, unless forced', async () => {
    const repo = initRepo()
    const lane = await cut(repo)
    commit(lane, 'a.txt', 'a')
    expect((await closeLane(git, lane)).ok).toBe(false)
    writeFileSync(path.join(lane, 'a.txt'), 'edited')
    expect((await closeLane(git, lane)).ok).toBe(false)
    expect((await closeLane(git, lane, true)).ok).toBe(true)
    expect(sh(repo, ['worktree', 'list']).split('\n')).toHaveLength(1)
  })

  it('removes a landed lane and its branch', async () => {
    const repo = initRepo()
    const lane = await cut(repo)
    commit(lane, 'a.txt', 'a')
    expect((await landLane(git, { lanePath: lane })).ok).toBe(true)
    expect((await closeLane(git, lane)).ok).toBe(true)
    expect(sh(repo, ['branch', '--list', 'cookrew/feature'])).toBe('')
  })
})
