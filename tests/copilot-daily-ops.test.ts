import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectLane, safeMerge, stopGroup } from '../scripts/copilot-daily-ops.mjs'

const git = (cwd: string, ...args: string[]): string =>
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).stdout.trim()

const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

describe('landing a lane', () => {
  let root: string
  let repo: string
  let tree: string
  let lane: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'daily-ops-'))
    repo = path.join(root, 'repo')
    tree = path.join(root, 'tree')
    lane = path.join(root, 'lane')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'dev')
    git(repo, 'config', 'user.name', 't')
    git(repo, 'config', 'user.email', 't@t')
    write(path.join(repo, 'a.txt'), 'one\n')
    write(path.join(repo, '.gitignore'), 'node_modules/\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'base')
    git(repo, 'worktree', 'add', '-q', '-b', 'daily/x', tree, 'dev')
    spawnSync('git', ['clone', '-q', `file://${repo}`, lane, '--branch', 'dev'])
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('carries the lane’s edits to the runner’s tree, without its scratch or dependencies', () => {
    write(path.join(lane, 'a.txt'), 'two\n')
    write(path.join(lane, 'new.txt'), 'new\n')
    write(path.join(lane, '.lane-tmp', 'junk'), 'x')
    write(path.join(lane, 'node_modules', 'x', 'i.js'), 'x')
    expect(collectLane({ repo, lane, tree, subject: 'fix: two', body: 'b' })).toBe(true)
    expect(readFileSync(path.join(tree, 'a.txt'), 'utf8')).toBe('two\n')
    expect(git(tree, 'show', '--stat', '--format=%s', 'HEAD')).toContain('fix: two')
    expect(git(tree, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['a.txt', 'new.txt'])
  })

  it('reports nothing to collect when the lane changed nothing', () => {
    expect(collectLane({ repo, lane, tree, subject: 'fix: none', body: 'b' })).toBe(false)
  })

  it('runs nothing the lane planted in its own .git', () => {
    const marker = path.join(root, 'planted')
    const hook = `#!/bin/sh\ntouch ${marker}\n`
    write(path.join(lane, '.git', 'hooks', 'pre-commit'), hook)
    write(path.join(lane, '.git', 'hooks', 'fsmonitor'), hook)
    chmodSync(path.join(lane, '.git', 'hooks', 'pre-commit'), 0o755)
    chmodSync(path.join(lane, '.git', 'hooks', 'fsmonitor'), 0o755)
    git(lane, 'config', 'core.fsmonitor', path.join(lane, '.git', 'hooks', 'fsmonitor'))
    write(path.join(lane, 'a.txt'), 'two\n')
    collectLane({ repo, lane, tree, subject: 'fix: two', body: 'b' })
    expect(existsSync(marker)).toBe(false)
  })

  it('refuses a symlink where the main tree keeps its ignored dependencies', () => {
    write(path.join(repo, 'node_modules', 'dep', 'index.js'), 'x')
    write(path.join(tree, 'node_modules', 'dep', 'index.js'), 'x')
    symlinkSync('/tmp', path.join(lane, 'node_modules'))
    const head = git(tree, 'rev-parse', 'HEAD')
    expect(() => collectLane({ repo, lane, tree, subject: 'fix: link', body: 'b' })).toThrow(/node_modules/)
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(head)
    expect(existsSync(path.join(tree, 'node_modules', 'dep', 'index.js'))).toBe(true)
  })

  it('refuses a plain file on top of an ignored directory', () => {
    write(path.join(repo, '.gitignore'), 'node_modules/\nout/\n')
    write(path.join(repo, 'out', 'main.js'), 'built')
    write(path.join(lane, 'out'), 'a file')
    expect(() => collectLane({ repo, lane, tree, subject: 'fix: out', body: 'b' })).toThrow(/out/)
  })

  it('merges a clean branch into dev', () => {
    write(path.join(tree, 'b.txt'), 'b\n')
    git(tree, 'add', '-A')
    git(tree, 'commit', '-qm', 'lane')
    expect(safeMerge({ repo, branch: 'daily/x', message: 'land' })).toEqual({ merged: true, reason: 'merged' })
    expect(existsSync(path.join(repo, 'b.txt'))).toBe(true)
  })

  it('leaves the main tree untouched when the branch conflicts', () => {
    write(path.join(tree, 'a.txt'), 'lane\n')
    git(tree, 'add', '-A')
    git(tree, 'commit', '-qm', 'lane')
    write(path.join(repo, 'a.txt'), 'dev moved\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'dev moved')
    const result = safeMerge({ repo, branch: 'daily/x', message: 'land' })
    expect(result.merged).toBe(false)
    expect(existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false)
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('dev moved\n')
  })

  it('leaves another lane’s merge alone', () => {
    git(repo, 'switch', '-q', '-c', 'other')
    write(path.join(repo, 'a.txt'), 'other\n')
    git(repo, 'commit', '-qam', 'other')
    git(repo, 'switch', '-q', 'dev')
    write(path.join(repo, 'a.txt'), 'dev\n')
    git(repo, 'commit', '-qam', 'dev')
    git(repo, 'merge', 'other')
    const theirs = readFileSync(path.join(repo, '.git', 'MERGE_HEAD'), 'utf8')
    write(path.join(tree, 'b.txt'), 'b\n')
    git(tree, 'add', '-A')
    git(tree, 'commit', '-qm', 'lane')
    expect(safeMerge({ repo, branch: 'daily/x', message: 'land' }).merged).toBe(false)
    expect(readFileSync(path.join(repo, '.git', 'MERGE_HEAD'), 'utf8')).toBe(theirs)
  })
})

describe('stopping a session', () => {
  it('reaches the process behind the loader, which a plain kill leaves running', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'daily-stop-'))
    const pidFile = path.join(dir, 'pid')
    const inner = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
    const loader = `require('child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(inner)}], { stdio: 'inherit' })`
    const child = spawn(process.execPath, ['-e', loader], { detached: true, stdio: 'ignore' })
    await expect.poll(() => existsSync(pidFile), { timeout: 5000 }).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    stopGroup(child, 100)
    const alive = (): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    await expect.poll(alive, { timeout: 5000 }).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})
