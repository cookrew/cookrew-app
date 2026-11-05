import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { inspectForks, planWorkspaceRemove, removeFork } from '../src/main/workspace-fork-check'
import { DEFAULT_TERMINAL_SIZE, type WorkspaceState } from '../src/shared/model'

/**
 * REMOVING A FORKED WORKSPACE (box user test 2, bug 11). Its worktree and branch
 * were left behind and nothing said so. They may go only when that loses
 * nothing, so these run against a real repository.
 */

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

let root: string
let repo: string
let worktreeRoot: string
let worktree: string
const branch = 'cookrew/alpha-fork'

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cookrew-fork-')))
  repo = path.join(root, 'proj-a')
  worktreeRoot = path.join(root, 'worktrees')
  worktree = path.join(worktreeRoot, 'alpha-1234', 'proj-a')
  mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 'test@example.invalid')
  sh(repo, 'config', 'user.name', 'Test')
  sh(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(path.join(repo, 'a.txt'), 'a')
  sh(repo, 'add', '.')
  sh(repo, 'commit', '-qm', 'first')
  mkdirSync(path.dirname(worktree), { recursive: true })
  sh(repo, 'worktree', 'add', '-q', '-b', branch, worktree)
})

const inspect = (dirs = [worktree], otherDirs: string[] = []) => inspectForks(dirs, { worktreeRoot, otherDirs })

describe('inspectForks', () => {
  it('finds nothing to offer for a folder outside the worktree root', async () => {
    expect(await inspect([repo])).toEqual([])
  })

  it('offers a clean worktree and branch', async () => {
    expect(await inspect()).toEqual([{ worktree, branch, removable: true }])
  })

  it('keeps a worktree with uncommitted changes, and says why', async () => {
    writeFileSync(path.join(worktree, 'b.txt'), 'b')
    expect(await inspect()).toEqual([
      { worktree, branch, removable: false, reason: 'The worktree has uncommitted changes, so it stays.' }
    ])
  })

  it('keeps a branch holding commits found nowhere else', async () => {
    writeFileSync(path.join(worktree, 'b.txt'), 'b')
    sh(worktree, 'add', '.')
    sh(worktree, 'commit', '-qm', 'second')
    expect(await inspect()).toEqual([
      { worktree, branch, removable: false, reason: `Branch ${branch} holds 1 commit found nowhere else, so it stays.` }
    ])
  })

  it('offers a branch whose commits have reached main', async () => {
    writeFileSync(path.join(worktree, 'b.txt'), 'b')
    sh(worktree, 'add', '.')
    sh(worktree, 'commit', '-qm', 'second')
    sh(repo, 'merge', '-q', '--ff-only', branch)
    expect((await inspect())[0].removable).toBe(true)
  })

  it('keeps a worktree another workspace still works in', async () => {
    expect(await inspect([worktree], [worktree])).toEqual([
      { worktree, branch, removable: false, reason: 'Another workspace works in this worktree, so it stays.' }
    ])
  })

  it('keeps a worktree holding ignored files: git cannot bring those back', async () => {
    writeFileSync(path.join(worktree, '.gitignore'), '.env\n')
    sh(worktree, 'add', '.')
    sh(worktree, 'commit', '-qm', 'ignore')
    sh(repo, 'merge', '-q', '--ff-only', branch)
    writeFileSync(path.join(worktree, '.env'), 'SECRET=1')
    expect(await inspect()).toEqual([
      { worktree, branch, removable: false, reason: 'The worktree holds ignored files git cannot bring back, so it stays.' }
    ])
  })

  it('keeps a worktree another workspace works inside', async () => {
    const [fork] = await inspect([worktree], [path.join(worktree, 'packages', 'api')])
    expect(fork.removable).toBe(false)
    expect(fork.reason).toBe('Another workspace works in this worktree, so it stays.')
  })

  it('never offers a branch Cookrew did not make', async () => {
    sh(worktree, 'switch', '-q', '-c', 'mine')
    expect(await inspect()).toEqual([
      { worktree, branch: 'mine', removable: false, reason: 'Branch mine was not made by Cookrew, so it stays.' }
    ])
  })
})

describe('removeFork', () => {
  it('removes the worktree and the branch', async () => {
    const [fork] = await inspect()
    expect(await removeFork(fork, { worktreeRoot, otherDirs: [] })).toEqual({ ok: true })
    expect(existsSync(worktree)).toBe(false)
    expect(sh(repo, 'branch', '--list', branch)).toBe('')
  })

  it('looks again first: a change made after the offer keeps them', async () => {
    const [fork] = await inspect()
    writeFileSync(path.join(worktree, 'late.txt'), 'late')
    const result = await removeFork(fork, { worktreeRoot, otherDirs: [] })
    expect(result).toEqual({ ok: false, reason: 'The worktree has uncommitted changes, so it stays.' })
    expect(existsSync(path.join(worktree, 'late.txt'))).toBe(true)
    expect(sh(repo, 'branch', '--list', branch)).toContain(branch)
  })
})

describe('planWorkspaceRemove', () => {
  const state: WorkspaceState = {
    name: 'Alpha', dir: '/p', dirs: ['/p', '/q'], connections: [],
    nodes: [
      { kind: 'terminal', id: 't', name: 'Shell', preset: 'Shell', command: 'zsh', cwd: '/p', orch: false, role: null, position: { x: 0, y: 0 }, size: DEFAULT_TERMINAL_SIZE },
      { kind: 'note', id: 'n', name: 'plan', content: 'x', position: { x: 0, y: 0 }, size: DEFAULT_TERMINAL_SIZE },
      { kind: 'browser', id: 'b', name: 'web', url: 'https://example.com', position: { x: 0, y: 0 }, size: DEFAULT_TERMINAL_SIZE }
    ]
  } as WorkspaceState

  it('names the agents it stops, counts what goes, and lists the folders it leaves', () => {
    expect(planWorkspaceRemove({ id: 'w', name: 'Alpha', state, forks: [] })).toEqual({
      id: 'w', name: 'Alpha', stops: ['Shell'], notes: 1, browsers: 1, keeps: ['/p', '/q'], forks: []
    })
  })
})
