import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isPiCommand,
  latestPiSession,
  piFreshCommand,
  piLaunchBinding,
  piNodeSessionDir,
  piResumeCommand,
  piSessionDir,
  piSessionFile,
  stripPiSessionFlags
} from '../src/main/pi-bind'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Pi command binding', () => {
  it('recognizes only the Pi executable token', () => {
    expect(isPiCommand('pi')).toBe(true)
    expect(isPiCommand('  pi --model sonnet')).toBe(true)
    expect(isPiCommand('pip install x')).toBe(false)
    expect(isPiCommand('pi; touch /tmp/nope')).toBe(false)
    expect(isPiCommand('bash')).toBe(false)
  })

  it('strips every competing session selector and builds deterministic commands', () => {
    expect(stripPiSessionFlags('pi --model sonnet --session old -c')).toBe('pi --model sonnet')
    expect(stripPiSessionFlags('pi --session-id=old --resume --no-session')).toBe('pi')
    expect(stripPiSessionFlags('pi --session-dir /tmp/other --model sonnet --fork')).toBe('pi --model sonnet')
    expect(piFreshCommand('pi --session old', '/tmp/pi node')).toBe(
      'pi --session-dir /tmp/pi\\ node'
    )
    expect(piResumeCommand('pi --session-id old', '019f-safe', '/tmp/pi node')).toBe(
      'pi --session 019f-safe --session-dir /tmp/pi\\ node'
    )
  })

  it('derives a stable shell-safe session directory from the terminal id', () => {
    const root = '/tmp/Cookrew Pi'
    const first = piNodeSessionDir('node/../../hostile;id', { rootDir: root })
    expect(first).toBe(piNodeSessionDir('node/../../hostile;id', { rootDir: root }))
    expect(path.dirname(first)).toBe(root)
    expect(path.basename(first)).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('Pi session lookup', () => {
  it('launches fresh in an exclusive node directory, then resumes its exact persisted id', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-pi-launch-'))
    roots.push(root)
    const cwd = path.join(root, 'work')
    const sessionsRoot = path.join(root, 'sessions')
    const terminalId = 'node-1'
    mkdirSync(cwd, { recursive: true })

    const fresh = piLaunchBinding({ command: 'pi --model sonnet', cwd, terminalId, sessionsRoot })
    expect(fresh.sessionId).toBeNull()
    expect(fresh.command).toBe(`pi --model sonnet --session-dir ${fresh.sessionDir}`)

    mkdirSync(fresh.sessionDir, { recursive: true })
    const id = '019f88f9-session'
    writeFileSync(
      path.join(fresh.sessionDir, `2026_${id}.jsonl`),
      `${JSON.stringify({ type: 'session', version: 3, id, cwd })}\n`
    )
    const resumed = piLaunchBinding({ command: 'pi --continue', cwd, terminalId, sessionsRoot })
    expect(resumed.sessionId).toBe(id)
    expect(resumed.command).toBe(`pi --session ${id} --session-dir ${fresh.sessionDir}`)
  })

  it('uses Pi cwd encoding and validates both header id and cwd', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-pi-'))
    roots.push(root)
    const cwd = path.join(root, 'work', 'repo')
    const agentDir = path.join(root, 'agent')
    mkdirSync(cwd, { recursive: true })
    const dir = piSessionDir(cwd, { agentDir })
    mkdirSync(dir, { recursive: true })
    const id = '019f88f9-safe'
    const file = path.join(dir, `2026-08-03T00-00-00-000Z_${id}.jsonl`)
    writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id, cwd })}\n`)

    expect(path.basename(dir)).toMatch(/^--.*work-repo--$/)
    expect(piSessionFile(cwd, id, { agentDir })).toBe(file)
    expect(latestPiSession(cwd, { agentDir })).toEqual({ id, file })
    expect(piSessionFile(cwd, 'x;touch-pwn', { agentDir })).toBeNull()
  })

  it('refuses a matching filename with a planted header cwd', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-pi-'))
    roots.push(root)
    const cwd = path.join(root, 'work')
    const agentDir = path.join(root, 'agent')
    mkdirSync(cwd, { recursive: true })
    const dir = piSessionDir(cwd, { agentDir })
    mkdirSync(dir, { recursive: true })
    const id = 'session-safe'
    writeFileSync(
      path.join(dir, `2026_${id}.jsonl`),
      `${JSON.stringify({ type: 'session', version: 3, id, cwd: '/other/project' })}\n`
    )
    expect(piSessionFile(cwd, id, { agentDir })).toBeNull()
  })

  it('tracks Pi\'s most recently active file after a session switch', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-pi-latest-'))
    roots.push(root)
    const cwd = path.join(root, 'work')
    const sessionsDir = path.join(root, 'sessions')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(sessionsDir, { recursive: true })
    const oldId = 'old-session'
    const newId = 'new-session'
    const oldFile = path.join(sessionsDir, `2026-01_${oldId}.jsonl`)
    const newFile = path.join(sessionsDir, `2026-12_${newId}.jsonl`)
    writeFileSync(oldFile, `${JSON.stringify({ type: 'session', version: 3, id: oldId, cwd })}\n`)
    writeFileSync(newFile, `${JSON.stringify({ type: 'session', version: 3, id: newId, cwd })}\n`)
    utimesSync(newFile, new Date(1000), new Date(1000))
    utimesSync(oldFile, new Date(2000), new Date(2000))

    expect(latestPiSession(cwd, { sessionsDir })).toEqual({ id: oldId, file: oldFile })
  })
})
