import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSessionTurns } from '../src/shared/session-turns'
import { claudeProjectDir, claudeSpawnCommand } from '../src/main/claude-fork'
import { carrySessionToCwd, withPiHeaderCwd } from '../src/main/session-move'
import { piNodeSessionDir } from '../src/main/pi-bind'

const T0 = Date.parse('2026-08-13T10:00:00.000Z')
const SESSION_ID = '11111111-2222-4333-8444-555555555555'

function promptLine(index: number, sessionId = SESSION_ID): string {
  return JSON.stringify({
    type: 'user',
    uuid: `u${index}`,
    sessionId,
    timestamp: new Date(T0 + index * 60_000).toISOString(),
    message: { role: 'user', content: `prompt ${index}` }
  })
}

function replyLine(index: number, sessionId = SESSION_ID): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `a${index}`,
    sessionId,
    timestamp: new Date(T0 + index * 60_000 + 20_000).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: `reply ${index}` }] }
  })
}

function claudeSession(turnCount: number): string {
  const lines = [
    JSON.stringify({ type: 'mode', sessionId: SESSION_ID }),
    ...Array.from({ length: turnCount }, (_, i) => [promptLine(i + 1), replyLine(i + 1)]).flat()
  ]
  return `${lines.join('\n')}\n`
}

/** A projects tree holding `sessionId.jsonl` under FROM's project dir. */
function claudeFixture(turnCount = 3): {
  projectsDir: string
  fromCwd: string
  toCwd: string
  sourceFile: string
  targetFile: string
} {
  const root = mkdtempSync(path.join(tmpdir(), 'cookrew-move-'))
  const projectsDir = path.join(root, 'projects')
  const fromCwd = path.join(root, 'repo-a')
  const toCwd = path.join(root, 'repo-b')
  mkdirSync(fromCwd, { recursive: true })
  mkdirSync(toCwd, { recursive: true })
  // Through claudeProjectDir, not the raw slug: session files are keyed by
  // the REALPATH (macOS /var/folders → /private/var/folders).
  const sourceDir = claudeProjectDir(fromCwd, projectsDir)
  mkdirSync(sourceDir, { recursive: true })
  const sourceFile = path.join(sourceDir, `${SESSION_ID}.jsonl`)
  writeFileSync(sourceFile, claudeSession(turnCount), 'utf8')
  return {
    projectsDir,
    fromCwd,
    toCwd,
    sourceFile,
    targetFile: path.join(claudeProjectDir(toCwd, projectsDir), `${SESSION_ID}.jsonl`)
  }
}

const claudeNode = (overrides: Record<string, unknown> = {}) => ({
  id: 'term-1',
  command: 'claude --dangerously-skip-permissions',
  claudeSessionId: SESSION_ID,
  ...overrides
})

describe('carrySessionToCwd — Claude', () => {
  it('copies the conversation into the new directory under the SAME session id', () => {
    const fx = claudeFixture()
    const outcome = carrySessionToCwd({
      node: claudeNode(),
      fromCwd: fx.fromCwd,
      toCwd: fx.toCwd,
      projectsDir: fx.projectsDir
    })

    expect(outcome).toEqual({ kind: 'carried', sessionRef: SESSION_ID })
    expect(readFileSync(fx.targetFile, 'utf8')).toBe(readFileSync(fx.sourceFile, 'utf8'))
  })

  it('leaves the origin file standing — the move is a copy, not a rename', () => {
    const fx = claudeFixture()
    carrySessionToCwd({
      node: claudeNode(),
      fromCwd: fx.fromCwd,
      toCwd: fx.toCwd,
      projectsDir: fx.projectsDir
    })
    expect(existsSync(fx.sourceFile)).toBe(true)
  })

  it('makes the respawn RESUME instead of starting a fresh conversation', () => {
    const fx = claudeFixture()
    // Before the carry the agent would boot empty in the new directory.
    expect(claudeSpawnCommand('claude', fx.toCwd, SESSION_ID, fx.projectsDir)).toContain(
      `--session-id ${SESSION_ID}`
    )

    carrySessionToCwd({
      node: claudeNode(),
      fromCwd: fx.fromCwd,
      toCwd: fx.toCwd,
      projectsDir: fx.projectsDir
    })

    expect(claudeSpawnCommand('claude', fx.toCwd, SESSION_ID, fx.projectsDir)).toContain(
      `--resume ${SESSION_ID}`
    )
  })

  it('keeps every checkpoint at the same ordinal and uuid', () => {
    const fx = claudeFixture(4)
    carrySessionToCwd({
      node: claudeNode(),
      fromCwd: fx.fromCwd,
      toCwd: fx.toCwd,
      projectsDir: fx.projectsDir
    })

    const before = parseSessionTurns(readFileSync(fx.sourceFile, 'utf8').split('\n'))
    const after = parseSessionTurns(readFileSync(fx.targetFile, 'utf8').split('\n'))
    expect(after.map((t) => [t.index, t.uuid])).toEqual(before.map((t) => [t.index, t.uuid]))
    expect(after).toHaveLength(4)
  })

  it('overwrites a stale copy left in the target directory by an earlier stay', () => {
    const fx = claudeFixture(3)
    mkdirSync(claudeProjectDir(fx.toCwd, fx.projectsDir), { recursive: true })
    writeFileSync(fx.targetFile, `${promptLine(1)}\n`, 'utf8')

    carrySessionToCwd({
      node: claudeNode(),
      fromCwd: fx.fromCwd,
      toCwd: fx.toCwd,
      projectsDir: fx.projectsDir
    })

    expect(parseSessionTurns(readFileSync(fx.targetFile, 'utf8').split('\n'))).toHaveLength(3)
  })

  it('reports unavailable when the bound session file is not there', () => {
    const fx = claudeFixture()
    const outcome = carrySessionToCwd({
      node: claudeNode({ claudeSessionId: '99999999-2222-4333-8444-555555555555' }),
      fromCwd: fx.fromCwd,
      toCwd: fx.toCwd,
      projectsDir: fx.projectsDir
    })
    expect(outcome).toEqual({ kind: 'unavailable' })
  })

  it('carries the REAL conversation when the stored id has drifted off it', () => {
    // A reattach that ignored our boot command leaves the node holding an id
    // claude never wrote. The turn history identifies the file it did write —
    // carrying the stored id instead would move an empty conversation.
    const fx = claudeFixture(3)
    const outcome = carrySessionToCwd({
      node: claudeNode({ claudeSessionId: '99999999-2222-4333-8444-555555555555' }),
      fromCwd: fx.fromCwd,
      toCwd: fx.toCwd,
      projectsDir: fx.projectsDir,
      turns: [1, 2, 3].map((index) => ({
        index,
        prompt: `prompt ${index}`,
        reply: `reply ${index}`,
        startedAt: T0 + index * 60_000,
        endedAt: T0 + index * 60_000 + 20_000
      }))
    })

    expect(outcome).toEqual({ kind: 'carried', sessionRef: SESSION_ID })
    expect(parseSessionTurns(readFileSync(fx.targetFile, 'utf8').split('\n'))).toHaveLength(3)
  })

  it('refuses a session id that is not UUID-shaped — it becomes a file path', () => {
    const fx = claudeFixture()
    const outcome = carrySessionToCwd({
      node: claudeNode({ claudeSessionId: '../../../etc/passwd' }),
      fromCwd: fx.fromCwd,
      toCwd: fx.toCwd,
      projectsDir: fx.projectsDir
    })
    expect(outcome).toEqual({ kind: 'unavailable' })
  })
})

describe('carrySessionToCwd — harnesses that need nothing', () => {
  it('leaves Codex alone: a rollout resumes by global id from any directory', () => {
    const outcome = carrySessionToCwd({
      node: {
        id: 'term-2',
        command: 'codex --dangerously-bypass-approvals-and-sandbox',
        codexSessionRef: '/home/u/.codex/sessions/2026/rollout-x-33333333-2222-4333-8444-555555555555.jsonl'
      },
      fromCwd: '/a',
      toCwd: '/b'
    })
    expect(outcome).toEqual({ kind: 'not-needed' })
  })

  it('leaves OpenCode alone for the same reason', () => {
    const outcome = carrySessionToCwd({
      node: { id: 'term-3', command: 'opencode', opencodeSessionId: 'ses_abc123' },
      fromCwd: '/a',
      toCwd: '/b'
    })
    expect(outcome).toEqual({ kind: 'not-needed' })
  })

  it('has nothing to carry for a plain shell', () => {
    const outcome = carrySessionToCwd({
      node: { id: 'term-4', command: '' },
      fromCwd: '/a',
      toCwd: '/b'
    })
    expect(outcome).toEqual({ kind: 'not-needed' })
  })

  it('is a no-op when the directory did not actually change', () => {
    const fx = claudeFixture()
    const outcome = carrySessionToCwd({
      node: claudeNode(),
      fromCwd: fx.fromCwd,
      toCwd: fx.fromCwd,
      projectsDir: fx.projectsDir
    })
    expect(outcome).toEqual({ kind: 'not-needed' })
  })
})

describe('withPiHeaderCwd', () => {
  const header = (cwd: string): string =>
    JSON.stringify({ type: 'session', id: 'sess-1', cwd, timestamp: '2026-08-13T10:00:00.000Z' })

  it('repoints the header cwd and leaves every other record byte-identical', () => {
    const body = JSON.stringify({ type: 'message', text: 'hello' })
    const moved = withPiHeaderCwd(`${header('/old')}\n${body}\n`, '/new')
    expect(moved).not.toBeNull()
    const lines = (moved as string).trim().split('\n')
    expect(JSON.parse(lines[0])).toMatchObject({ type: 'session', id: 'sess-1', cwd: '/new' })
    expect(lines[1]).toBe(body)
  })

  it('refuses a file whose first record is not a session header', () => {
    expect(withPiHeaderCwd(`${JSON.stringify({ type: 'message' })}\n`, '/new')).toBeNull()
    expect(withPiHeaderCwd('not json\n', '/new')).toBeNull()
    expect(withPiHeaderCwd('', '/new')).toBeNull()
  })
})

describe('carrySessionToCwd — Pi', () => {
  function piFixture(): { root: string; fromCwd: string; toCwd: string; file: string } {
    const root = mkdtempSync(path.join(tmpdir(), 'cookrew-pi-move-'))
    const fromCwd = path.join(root, 'repo-a')
    const toCwd = path.join(root, 'repo-b')
    mkdirSync(fromCwd, { recursive: true })
    mkdirSync(toCwd, { recursive: true })
    const exclusive = piNodeSessionDir('term-pi', { rootDir: path.join(root, 'pi-sessions') })
    mkdirSync(exclusive, { recursive: true })
    const file = path.join(exclusive, '2026-08-13_sess-1.jsonl')
    writeFileSync(
      file,
      `${JSON.stringify({
        type: 'session',
        id: 'sess-1',
        cwd: fromCwd,
        timestamp: '2026-08-13T10:00:00.000Z'
      })}\n${JSON.stringify({ type: 'message', text: 'hello' })}\n`,
      'utf8'
    )
    return { root, fromCwd, toCwd, file }
  }

  it('repoints the session at the new directory so the respawn resumes it', () => {
    const fx = piFixture()
    const outcome = carrySessionToCwd({
      node: { id: 'term-pi', command: 'pi', piSessionId: 'sess-1' },
      fromCwd: fx.fromCwd,
      toCwd: fx.toCwd,
      piSessionsRoot: path.join(fx.root, 'pi-sessions')
    })

    expect(outcome).toEqual({ kind: 'carried', sessionRef: 'sess-1' })
    const header = JSON.parse(readFileSync(fx.file, 'utf8').split('\n')[0]) as { cwd: string }
    expect(header.cwd).toBe(fx.toCwd)
  })

  it('reports unavailable when the node has no bound Pi session', () => {
    const fx = piFixture()
    const outcome = carrySessionToCwd({
      node: { id: 'term-pi', command: 'pi', piSessionId: null },
      fromCwd: fx.fromCwd,
      toCwd: fx.toCwd,
      piSessionsRoot: path.join(fx.root, 'pi-sessions')
    })
    expect(outcome).toEqual({ kind: 'unavailable' })
  })
})
