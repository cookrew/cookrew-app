import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sandboxRoot } from '../src/main/session-sandbox'
import { servedSessionCandidates, servedSessionKey } from '../src/main/storage-gc-served'

const DAY = 24 * 60 * 60 * 1000
const made: string[] = []

afterEach(() => {
  for (const dir of made.splice(0).reverse()) {
    // A test may have made a directory unreadable; give it back before rm.
    try {
      chmodSync(dir, 0o700)
    } catch {
      // gone already
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

function base(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-served-'))
  made.push(dir)
  return dir
}

function fill(dir: string, name: string, body: string, ageDays: number): void {
  const file = path.join(dir, name)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
  const when = new Date(Date.now() - ageDays * DAY)
  utimesSync(file, when, when)
}

describe('servedSessionKey — spelled by the rule that made the directory', () => {
  it('matches the path sandboxRoot creates, so an open session is found by its readdir names', () => {
    const root = base()
    const dir = sandboxRoot(root, 'svc-qa-orch-door', 'svc-qa-orch-door-ana-1')
    const key = servedSessionKey('svc-qa-orch-door', 'svc-qa-orch-door-ana-1')
    expect(key).toBe('svc-qa-orch-door/ana-1')
    // sandboxRoot realpaths (/var → /private/var); the key is the part that must agree.
    expect(dir).toBe(path.join(realpathSync(root), 'sessions', key))
    const found = servedSessionCandidates(path.join(root, 'sessions'))
    expect(found?.map((c) => c.key)).toEqual([key])
  })

  it('segments an unsafe id the way the sandbox does', () => {
    expect(servedSessionKey('Svc X', 'Svc X-Ana/../-2')).toBe('svc-x/ana-----2')
  })
})

describe('servedSessionCandidates — one candidate per sandbox, or nothing', () => {
  it('measures each sandbox as a unit: bytes summed, newest write as its age', () => {
    const root = base()
    const sessions = path.join(root, 'sessions')
    fill(sessions, 'svc-a/ana-1/.claude/settings.json', 'x'.repeat(100), 40)
    fill(sessions, 'svc-a/ana-1/.cookrew/turns/t.jsonl', 'y'.repeat(50), 2)
    fill(sessions, 'svc-a/ana-2/.claude.json', 'z'.repeat(10), 40)
    const out = servedSessionCandidates(sessions)
    expect(out).not.toBeNull()
    const byKey = Object.fromEntries(out!.map((c) => [c.key, c]))
    expect(Object.keys(byKey).sort()).toEqual(['svc-a/ana-1', 'svc-a/ana-2'])
    expect(byKey['svc-a/ana-1'].bytes).toBe(150)
    // The newest file, not the oldest, is the sandbox's age: still writing = still used.
    expect(Date.now() - byKey['svc-a/ana-1'].mtimeMs).toBeLessThan(3 * DAY)
    expect(byKey['svc-a/ana-1'].path).toBe(path.join(sessions, 'svc-a', 'ana-1'))
  })

  it('never offers the service directory, a stray file, or a symlink as a candidate', () => {
    const root = base()
    const sessions = path.join(root, 'sessions')
    fill(sessions, 'svc-a/ana-1/.claude.json', '{}', 40)
    fill(sessions, 'svc-a/notes.txt', 'not a session', 40)
    fill(root, 'elsewhere/secret', 'owner data', 40)
    symlinkSync(path.join(root, 'elsewhere'), path.join(sessions, 'svc-a', 'link-1'))
    symlinkSync(path.join(root, 'elsewhere'), path.join(sessions, 'svc-link'))
    expect(servedSessionCandidates(sessions)?.map((c) => c.key)).toEqual(['svc-a/ana-1'])
  })

  it('a store nothing was ever served from answers empty', () => {
    expect(servedSessionCandidates(path.join(base(), 'sessions'))).toEqual([])
  })

  it('a store that exists but cannot be read answers NULL — abort, not "nothing here"', () => {
    const root = base()
    const sessions = path.join(root, 'sessions')
    fill(sessions, 'svc-a/ana-1/.claude.json', '{}', 40)
    chmodSync(sessions, 0o000)
    made.push(sessions)
    expect(servedSessionCandidates(sessions)).toBeNull()
  })

  it('an unreadable service directory aborts the whole class, not just that service', () => {
    const root = base()
    const sessions = path.join(root, 'sessions')
    fill(sessions, 'svc-a/ana-1/.claude.json', '{}', 40)
    fill(sessions, 'svc-b/bob-1/.claude.json', '{}', 40)
    chmodSync(path.join(sessions, 'svc-b'), 0o000)
    made.push(path.join(sessions, 'svc-b'))
    expect(servedSessionCandidates(sessions)).toBeNull()
  })
})
