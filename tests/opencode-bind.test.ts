import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isOpenCodeCommand, resolveOpencodeSession, OPENCODE_SPAWN_WINDOW_MS } from '../src/main/opencode-bind'

const T0 = Date.parse('2026-07-23T10:00:00.000Z')

function session(base: string, proj: string, id: string, directory: string, created: number): void {
  const dir = path.join(base, proj)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, directory, projectID: proj, title: 't', time: { created, updated: created } }))
}

describe('isOpenCodeCommand', () => {
  it('matches opencode only', () => {
    expect(isOpenCodeCommand('opencode')).toBe(true)
    expect(isOpenCodeCommand('  opencode --model x')).toBe(true)
    expect(isOpenCodeCommand('codex')).toBe(false)
  })
})

describe('resolveOpencodeSession (binder)', () => {
  it('binds the newest cwd-matching session in the spawn window', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'oc-'))
    session(base, 'projA', 'ses_old', '/work/repo', T0 - OPENCODE_SPAWN_WINDOW_MS - 60_000)
    session(base, 'projA', 'ses_fresh', '/work/repo', T0 + 5_000)
    session(base, 'projB', 'ses_other', '/elsewhere', T0 + 6_000)
    expect(resolveOpencodeSession({ cwd: '/work/repo', spawnedAt: T0, storageDir: base })).toBe('ses_fresh')
  })

  it('lazy bind drops the time window, excludes claimed ids', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'oc-'))
    session(base, 'p', 'ses_a', '/work/repo', T0 - OPENCODE_SPAWN_WINDOW_MS * 4)
    session(base, 'p', 'ses_b', '/work/repo', T0 - OPENCODE_SPAWN_WINDOW_MS * 5)
    expect(resolveOpencodeSession({ cwd: '/work/repo', spawnedAt: null, storageDir: base })).toBe('ses_a')
    expect(resolveOpencodeSession({ cwd: '/work/repo', spawnedAt: null, storageDir: base, exclude: new Set(['ses_a']) })).toBe('ses_b')
    expect(resolveOpencodeSession({ cwd: '/nope', spawnedAt: null, storageDir: base })).toBeNull()
  })
})
