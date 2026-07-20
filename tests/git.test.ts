import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitInfoCache, addWorktree, gitInfo, parseAheadBehind } from '../src/main/git'
import type { GitInfo } from '../src/shared/model'

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-git-'))
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  run(['init', '-b', 'main'])
  run(['config', 'user.email', 'test@cookrew.dev'])
  run(['config', 'user.name', 'Test'])
  writeFileSync(path.join(dir, 'README.md'), '# repo\n')
  run(['add', '.'])
  run(['commit', '-m', 'init'])
  return dir
}

describe('parseAheadBehind', () => {
  it('reads ahead/behind from a status -sb header', () => {
    expect(parseAheadBehind('## main...origin/main [ahead 2, behind 3]')).toEqual({
      ahead: 2,
      behind: 3
    })
    expect(parseAheadBehind('## main...origin/main [ahead 1]')).toEqual({ ahead: 1, behind: 0 })
    expect(parseAheadBehind('## main')).toEqual({ ahead: 0, behind: 0 })
  })
})

describe('gitInfo', () => {
  it('reports a clean repo with its branch and root', async () => {
    const dir = initRepo()
    const info = await gitInfo(dir)
    expect(info.isRepo).toBe(true)
    expect(info.branch).toBe('main')
    expect(info.dirty).toBe(false)
    expect(info.root).not.toBeNull()
  })

  it('reports dirty when the tree has uncommitted changes', async () => {
    const dir = initRepo()
    writeFileSync(path.join(dir, 'new.txt'), 'change')
    const info = await gitInfo(dir)
    expect(info.isRepo).toBe(true)
    expect(info.dirty).toBe(true)
  })

  it('reports not-a-repo for a plain directory', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-plain-'))
    const info = await gitInfo(dir)
    expect(info.isRepo).toBe(false)
    expect(info.root).toBeNull()
  })
})

describe('GitInfoCache', () => {
  it('serves cached results within the TTL and re-queries after it', async () => {
    let calls = 0
    const stub = async (): Promise<GitInfo> => {
      calls += 1
      return { isRepo: true, root: '/r', branch: 'main', dirty: false, ahead: 0, behind: 0 }
    }
    const cache = new GitInfoCache(stub)
    await cache.info('/r', 1000)
    await cache.info('/r', 2000)
    expect(calls).toBe(1)
    await cache.info('/r', 10_000)
    expect(calls).toBe(2)
  })

  it('coalesces concurrent callers into one query', async () => {
    let calls = 0
    const cache = new GitInfoCache(async () => {
      calls += 1
      return { isRepo: false, root: null, branch: null, dirty: false, ahead: 0, behind: 0 }
    })
    await Promise.all([cache.info('/r', 0), cache.info('/r', 0)])
    expect(calls).toBe(1)
  })

  it('invalidate forces a re-query', async () => {
    let calls = 0
    const cache = new GitInfoCache(async () => {
      calls += 1
      return { isRepo: false, root: null, branch: null, dirty: false, ahead: 0, behind: 0 }
    })
    await cache.info('/r', 0)
    cache.invalidate('/r')
    await cache.info('/r', 100)
    expect(calls).toBe(2)
  })
})

describe('addWorktree', () => {
  it('creates a worktree on a new branch pointing at the fork path', async () => {
    const repo = initRepo()
    const wt = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-wt-')), 'fork')
    const result = await addWorktree(repo, wt, 'fork-branch')
    expect(result.ok).toBe(true)
    const info = await gitInfo(wt)
    expect(info.isRepo).toBe(true)
    expect(info.branch).toBe('fork-branch')
  })

  it('resolves ok:false (never throws) when the repo path is invalid', async () => {
    const notRepo = mkdtempSync(path.join(tmpdir(), 'cookrew-norepo-'))
    const result = await addWorktree(notRepo, path.join(notRepo, 'wt'), 'b')
    expect(result.ok).toBe(false)
  })
})
