import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TurnRecord } from '../src/shared/turn'
import {
  buildForkedSessionLines,
  buildResumeCommand,
  buildSessionIdCommand,
  claudeProjectSlug,
  extractSessionFlag,
  forkCutoffMs,
  isClaudeCommand,
  scoreSessionMatch,
  sessionPrompts,
  stripSessionFlags
} from '../src/shared/claude-fork'
import { buildResumeForkNotice } from '../src/shared/fork'
import { claudeSpawnCommand, forkClaudeSession } from '../src/main/claude-fork'

const T0 = Date.parse('2026-07-19T10:00:00.000Z')

function turn(index: number, overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    index,
    prompt: `prompt ${index}`,
    reply: `reply ${index}`,
    startedAt: T0 + index * 60_000,
    endedAt: T0 + index * 60_000 + 30_000,
    ...overrides
  }
}

/** A user-prompt record as Claude Code writes it, timed to `turn(index)`. */
function promptLine(index: number, sessionId = 'origin-id'): string {
  return JSON.stringify({
    type: 'user',
    uuid: `u${index}`,
    sessionId,
    timestamp: new Date(T0 + index * 60_000 + 100).toISOString(),
    message: { role: 'user', content: `prompt ${index}` }
  })
}

function replyLine(index: number, sessionId = 'origin-id'): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `a${index}`,
    sessionId,
    timestamp: new Date(T0 + index * 60_000 + 20_000).toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: `reply ${index}` }] }
  })
}

function sessionLines(turnCount: number, sessionId = 'origin-id'): string[] {
  const header = [
    JSON.stringify({ type: 'mode', sessionId }),
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'x' })
  ]
  const body = Array.from({ length: turnCount }, (_, i) => [
    promptLine(i + 1, sessionId),
    replyLine(i + 1, sessionId)
  ]).flat()
  return [...header, ...body]
}

describe('claudeProjectSlug', () => {
  it('replaces path separators, dots and underscores with dashes', () => {
    expect(claudeProjectSlug('/Users/drej/workspace/cookrew-dev')).toBe(
      '-Users-drej-workspace-cookrew-dev'
    )
    expect(claudeProjectSlug('/tmp/my_app.v2')).toBe('-tmp-my-app-v2')
  })
})

describe('isClaudeCommand / buildResumeCommand', () => {
  it('recognizes claude commands only', () => {
    expect(isClaudeCommand('claude --permission-mode bypassPermissions')).toBe(true)
    expect(isClaudeCommand('  claude')).toBe(true)
    expect(isClaudeCommand('codex')).toBe(false)
    expect(isClaudeCommand('claudette')).toBe(false)
  })

  it('appends --resume to the source command', () => {
    expect(buildResumeCommand('claude --permission-mode bypassPermissions', 'abc')).toBe(
      'claude --permission-mode bypassPermissions --resume abc'
    )
  })

  it('appends --session-id for fresh conversations', () => {
    expect(buildSessionIdCommand('claude --verbose', 'abc')).toBe(
      'claude --verbose --session-id abc'
    )
  })

  it('strips a previous --resume/--session-id (fork of a fork)', () => {
    expect(buildResumeCommand('claude --resume old-id --verbose', 'new-id')).toBe(
      'claude --verbose --resume new-id'
    )
    expect(buildResumeCommand('claude --session-id=old-id', 'new-id')).toBe(
      'claude --resume new-id'
    )
    expect(stripSessionFlags('claude --resume old-id --verbose')).toBe('claude --verbose')
    expect(stripSessionFlags('codex')).toBe('codex')
  })
})

describe('extractSessionFlag', () => {
  it('recovers an id baked into an older fork command', () => {
    expect(extractSessionFlag('claude --resume 4188d6fa-41a0-4618-8e66-ea2af33e42b1')).toBe(
      '4188d6fa-41a0-4618-8e66-ea2af33e42b1'
    )
    expect(extractSessionFlag('claude --session-id=00fec4a9-217d-49b0')).toBe(
      '00fec4a9-217d-49b0'
    )
  })

  it('returns null when no session flag is present', () => {
    expect(extractSessionFlag('claude --permission-mode bypassPermissions')).toBeNull()
    expect(extractSessionFlag('codex')).toBeNull()
  })
})

describe('sessionPrompts', () => {
  it('extracts real user prompts, skipping tool results and meta records', () => {
    const lines = [
      promptLine(1),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'x' }] }
      }),
      JSON.stringify({ type: 'user', isMeta: true, message: { content: 'meta note' } }),
      replyLine(1),
      'not json at all'
    ]
    expect(sessionPrompts(lines)).toEqual(['prompt 1'])
  })
})

describe('scoreSessionMatch', () => {
  it('counts turns whose prompts appear in the session', () => {
    const prompts = ['prompt 1', 'prompt 2', 'something else']
    expect(scoreSessionMatch(prompts, [turn(1), turn(2), turn(3)])).toBe(2)
  })

  it('matches on normalized text (whitespace, case)', () => {
    const prompts = ['  Prompt   1 ']
    expect(scoreSessionMatch(prompts, [turn(1)])).toBe(1)
  })
})

describe('forkCutoffMs', () => {
  it('is the start of the turn after the fork point', () => {
    const turns = [turn(1), turn(2), turn(3)]
    expect(forkCutoffMs(turns, 2)).toBe(turns[2].startedAt)
  })

  it('is null when forking from the latest turn', () => {
    expect(forkCutoffMs([turn(1), turn(2)], 2)).toBeNull()
  })
})

describe('buildForkedSessionLines', () => {
  it('drops the turn after the cutoff and everything beyond', () => {
    const lines = sessionLines(3)
    const forked = buildForkedSessionLines(lines, {
      newSessionId: 'fork-id',
      cutoffMs: turn(3).startedAt
    })
    const text = forked.join('\n')
    expect(text).toContain('prompt 2')
    expect(text).toContain('reply 2')
    expect(text).not.toContain('prompt 3')
    expect(text).not.toContain('reply 3')
  })

  it('keeps the whole session when cutoff is null', () => {
    const forked = buildForkedSessionLines(sessionLines(3), {
      newSessionId: 'fork-id',
      cutoffMs: null
    })
    expect(forked.join('\n')).toContain('prompt 3')
  })

  it('rewrites sessionId on every kept record that has one', () => {
    const forked = buildForkedSessionLines(sessionLines(2), {
      newSessionId: 'fork-id',
      cutoffMs: null
    })
    expect(forked.join('\n')).not.toContain('origin-id')
    const withSession = forked.map((l) => JSON.parse(l)).filter((r) => 'sessionId' in r)
    expect(withSession.length).toBeGreaterThan(0)
    expect(withSession.every((r) => r.sessionId === 'fork-id')).toBe(true)
  })

  it('keeps untimestamped header records and skips blank lines', () => {
    const forked = buildForkedSessionLines(['', ...sessionLines(1)], {
      newSessionId: 'fork-id',
      cutoffMs: null
    })
    expect(forked.join('\n')).toContain('file-history-snapshot')
    expect(forked.every((l) => l.trim().length > 0)).toBe(true)
  })

  it('does not mutate the input lines', () => {
    const lines = sessionLines(2)
    const before = [...lines]
    buildForkedSessionLines(lines, { newSessionId: 'fork-id', cutoffMs: null })
    expect(lines).toEqual(before)
  })
})

describe('forkClaudeSession', () => {
  function setup(): { projectsDir: string; dir: string } {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'cookrew-claude-fork-'))
    const dir = path.join(projectsDir, claudeProjectSlug('/work/repo'))
    mkdirSync(dir, { recursive: true })
    return { projectsDir, dir }
  }

  const command = 'claude --permission-mode bypassPermissions'

  it('writes a truncated copy under a fresh session id', () => {
    const { projectsDir, dir } = setup()
    const origin = sessionLines(3).join('\n') + '\n'
    writeFileSync(path.join(dir, 'origin-id.jsonl'), origin)

    const turns = [turn(1), turn(2), turn(3)]
    const result = forkClaudeSession({ command, cwd: '/work/repo', turns, turnIndex: 2, projectsDir })

    expect(result).not.toBeNull()
    const forkFile = path.join(dir, `${result!.sessionId}.jsonl`)
    const forked = readFileSync(forkFile, 'utf8')
    expect(forked).toContain('prompt 2')
    expect(forked).not.toContain('prompt 3')
    expect(forked).not.toContain('origin-id')
  })

  it('uses the stored session id directly, ignoring better-scoring files', () => {
    const { projectsDir, dir } = setup()
    // A decoy that would win prompt-matching: same prompts, more of them.
    writeFileSync(path.join(dir, 'decoy.jsonl'), sessionLines(3, 'decoy').join('\n') + '\n')
    const bound = [
      JSON.stringify({
        type: 'user',
        sessionId: 'bound-id',
        timestamp: new Date(T0 + 60_000).toISOString(),
        message: { content: 'offset text the scraper never saw' }
      })
    ]
    writeFileSync(path.join(dir, 'bound-id.jsonl'), bound.join('\n') + '\n')

    const result = forkClaudeSession({
      command,
      cwd: '/work/repo',
      sessionId: 'bound-id',
      turns: [turn(1), turn(2), turn(3)],
      turnIndex: 3,
      projectsDir
    })
    expect(result).not.toBeNull()
    const forked = readFileSync(path.join(dir, `${result!.sessionId}.jsonl`), 'utf8')
    expect(forked).toContain('offset text the scraper never saw')
    expect(forked).not.toContain('decoy')
  })

  it('falls back to prompt matching when the stored id has no file', () => {
    const { projectsDir, dir } = setup()
    writeFileSync(path.join(dir, 'origin-id.jsonl'), sessionLines(2).join('\n') + '\n')

    const result = forkClaudeSession({
      command,
      cwd: '/work/repo',
      sessionId: 'gone-id',
      turns: [turn(1), turn(2)],
      turnIndex: 2,
      projectsDir
    })
    expect(result).not.toBeNull()
    expect(readFileSync(path.join(dir, `${result!.sessionId}.jsonl`), 'utf8')).toContain(
      'prompt 1'
    )
  })

  it('never modifies the origin session file', () => {
    const { projectsDir, dir } = setup()
    const origin = sessionLines(2).join('\n') + '\n'
    writeFileSync(path.join(dir, 'origin-id.jsonl'), origin)

    forkClaudeSession({
      command,
      cwd: '/work/repo',
      turns: [turn(1), turn(2)],
      turnIndex: 1,
      projectsDir
    })
    expect(readFileSync(path.join(dir, 'origin-id.jsonl'), 'utf8')).toBe(origin)
    expect(readdirSync(dir)).toHaveLength(2)
  })

  it('picks the session file matching the turn history', () => {
    const { projectsDir, dir } = setup()
    const other = [
      JSON.stringify({
        type: 'user',
        sessionId: 'other',
        timestamp: new Date(T0).toISOString(),
        message: { content: 'unrelated conversation' }
      })
    ]
    writeFileSync(path.join(dir, 'other.jsonl'), other.join('\n') + '\n')
    writeFileSync(path.join(dir, 'origin-id.jsonl'), sessionLines(2).join('\n') + '\n')

    const result = forkClaudeSession({
      command,
      cwd: '/work/repo',
      turns: [turn(1), turn(2)],
      turnIndex: 2,
      projectsDir
    })
    expect(result).not.toBeNull()
    expect(readFileSync(path.join(dir, `${result!.sessionId}.jsonl`), 'utf8')).toContain(
      'prompt 1'
    )
  })

  it('returns null for non-claude agents', () => {
    const { projectsDir } = setup()
    const result = forkClaudeSession({
      command: 'codex',
      cwd: '/work/repo',
      turns: [turn(1)],
      turnIndex: 1,
      projectsDir
    })
    expect(result).toBeNull()
  })

  it('returns null when no session matches the turn history', () => {
    const { projectsDir, dir } = setup()
    writeFileSync(path.join(dir, 'other.jsonl'), sessionLines(1, 'other').join('\n') + '\n')
    const result = forkClaudeSession({
      command,
      cwd: '/work/repo',
      turns: [turn(9, { prompt: 'totally different' })],
      turnIndex: 9,
      projectsDir
    })
    expect(result).toBeNull()
  })

  it('returns null when the project directory does not exist', () => {
    const { projectsDir } = setup()
    const result = forkClaudeSession({
      command,
      cwd: '/nowhere/else',
      turns: [turn(1)],
      turnIndex: 1,
      projectsDir
    })
    expect(result).toBeNull()
  })
})

describe('claudeSpawnCommand', () => {
  it('starts fresh conversations with --session-id', () => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'cookrew-claude-spawn-'))
    expect(claudeSpawnCommand('claude --verbose', '/work/repo', 'new-id', projectsDir)).toBe(
      'claude --verbose --session-id new-id'
    )
  })

  it('resumes when the bound session file already exists', () => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'cookrew-claude-spawn-'))
    const dir = path.join(projectsDir, claudeProjectSlug('/work/repo'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'live-id.jsonl'), sessionLines(1, 'live-id').join('\n') + '\n')
    expect(claudeSpawnCommand('claude --verbose', '/work/repo', 'live-id', projectsDir)).toBe(
      'claude --verbose --resume live-id'
    )
  })
})

describe('buildResumeForkNotice', () => {
  it('names the fork, the source and the branch point', () => {
    const notice = buildResumeForkNotice({
      forkName: 'Coder ⑂T2',
      sourceName: 'Coder',
      turnIndex: 2
    })
    expect(notice).toContain('"Coder ⑂T2"')
    expect(notice).toContain('"Coder"')
    expect(notice).toContain('turn 2')
    expect(notice).toContain('unaffected')
  })
})
