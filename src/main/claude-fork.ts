// Native Claude Code session fork, filesystem side: find the source
// terminal's live session file, write a truncated copy under a fresh session
// id, and hand back the `--resume` command for the fork terminal. The origin
// session file is opened read-only — a failed or impossible fork returns
// null and the caller falls back to the prompt-preamble fork.

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { TurnRecord } from '../shared/turn'
import {
  buildForkedSessionLines,
  buildResumeCommand,
  claudeProjectSlug,
  forkCutoffMs,
  isClaudeCommand,
  scoreSessionMatch,
  sessionPrompts
} from '../shared/claude-fork'

/** Newest session files considered when looking for the live session. */
const CANDIDATE_FILES = 8

export interface ClaudeForkOptions {
  command: string
  cwd: string
  turns: TurnRecord[]
  turnIndex: number
  /** Override for tests; defaults to ~/.claude/projects. */
  projectsDir?: string
}

export interface ClaudeForkResult {
  sessionId: string
  /** Launch command for the fork terminal (source command + --resume). */
  command: string
}

interface Candidate {
  file: string
  lines: string[]
  score: number
}

function readCandidates(dir: string, turns: TurnRecord[]): Candidate[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, CANDIDATE_FILES)
  return files.map((file) => {
    const lines = readFileSync(file, 'utf8').split('\n')
    return { file, lines, score: scoreSessionMatch(sessionPrompts(lines), turns) }
  })
}

/**
 * Fork the Claude session behind a terminal at the given turn. Returns null
 * when the terminal is not Claude Code, no session file matches the
 * terminal's turn history, or anything goes wrong — callers must then fall
 * back to the preamble fork.
 */
export function forkClaudeSession(options: ClaudeForkOptions): ClaudeForkResult | null {
  try {
    if (!isClaudeCommand(options.command)) return null
    const projectsDir = options.projectsDir ?? path.join(homedir(), '.claude', 'projects')
    const dir = path.join(projectsDir, claudeProjectSlug(options.cwd))
    if (!existsSync(dir)) return null

    // Newest-first order breaks score ties in favor of the most recent file.
    const best = readCandidates(dir, options.turns).reduce<Candidate | null>(
      (acc, c) => (acc === null || c.score > acc.score ? c : acc),
      null
    )
    if (!best || best.score < 1) return null

    const sessionId = randomUUID()
    const forked = buildForkedSessionLines(best.lines, {
      newSessionId: sessionId,
      cutoffMs: forkCutoffMs(options.turns, options.turnIndex)
    })
    if (forked.length === 0) return null

    writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${forked.join('\n')}\n`, 'utf8')
    return { sessionId, command: buildResumeCommand(options.command, sessionId) }
  } catch (error) {
    console.error('Native Claude session fork failed, falling back to preamble:', error)
    return null
  }
}
