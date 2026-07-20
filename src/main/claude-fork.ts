// Native Claude Code session integration, filesystem side.
//
// Every Claude terminal is bound to a known session id at spawn
// (claudeSpawnCommand), so session-file features never guess which session
// file under ~/.claude/projects belongs to a terminal. Forking copies the
// source's session file truncated at the fork turn under a fresh id — the
// origin file is opened read-only. Terminals from before ids were stored
// fall back to matching their scraped turn history against candidate files.

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { TurnRecord } from '../shared/turn'
import {
  buildForkedSessionLines,
  buildForkedSessionLinesAtTurn,
  buildResumeCommand,
  buildSessionIdCommand,
  claudeProjectSlug,
  forkCutoffMs,
  isClaudeCommand,
  scoreSessionMatch,
  sessionPrompts
} from '../shared/claude-fork'

/** Newest session files considered by the legacy (no stored id) fallback. */
const CANDIDATE_FILES = 8

function claudeProjectDir(cwd: string, projectsDir?: string): string {
  const base = projectsDir ?? path.join(homedir(), '.claude', 'projects')
  return path.join(base, claudeProjectSlug(cwd))
}

/** On-disk session file for a terminal bound to sessionId. */
export function claudeSessionFile(cwd: string, sessionId: string, projectsDir?: string): string {
  return path.join(claudeProjectDir(cwd, projectsDir), `${sessionId}.jsonl`)
}

/**
 * Effective launch command for a Claude terminal bound to sessionId:
 * --resume when its session file already exists (app restart after the tmux
 * session died, freshly forked copy), else --session-id so the new
 * conversation is recorded under the known id from its first turn.
 */
export function claudeSpawnCommand(
  command: string,
  cwd: string,
  sessionId: string,
  projectsDir?: string
): string {
  return existsSync(claudeSessionFile(cwd, sessionId, projectsDir))
    ? buildResumeCommand(command, sessionId)
    : buildSessionIdCommand(command, sessionId)
}

export interface ClaudeForkOptions {
  command: string
  cwd: string
  /** The source terminal's bound session id, when it has one. */
  sessionId?: string | null
  turns: TurnRecord[]
  turnIndex: number
  /** Override for tests; defaults to ~/.claude/projects. */
  projectsDir?: string
}

export interface ClaudeForkResult {
  /** Session id of the truncated copy — bind the fork terminal to it. */
  sessionId: string
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
 * The source session's lines. A stored session id resolves the file
 * directly — its turn records are session-derived (SessionTurnSync), so
 * `exact` truncation by real message boundaries applies. Terminals from
 * before ids existed fall back to scoring candidate files against scraped
 * turn history, whose indexes can be offset — those keep timestamp cutoffs.
 */
function readSourceLines(
  dir: string,
  options: ClaudeForkOptions
): { lines: string[]; exact: boolean } | null {
  if (options.sessionId) {
    const file = path.join(dir, `${options.sessionId}.jsonl`)
    if (existsSync(file)) return { lines: readFileSync(file, 'utf8').split('\n'), exact: true }
  }
  // Newest-first order breaks score ties in favor of the most recent file.
  const best = readCandidates(dir, options.turns).reduce<Candidate | null>(
    (acc, c) => (acc === null || c.score > acc.score ? c : acc),
    null
  )
  return best !== null && best.score >= 1 ? { lines: best.lines, exact: false } : null
}

/**
 * Fork the Claude session behind a terminal at the given turn. Returns null
 * when the terminal is not Claude Code, its session file can't be found, or
 * anything goes wrong — callers must then fall back to the preamble fork.
 */
export function forkClaudeSession(options: ClaudeForkOptions): ClaudeForkResult | null {
  try {
    if (!isClaudeCommand(options.command)) return null
    const dir = claudeProjectDir(options.cwd, options.projectsDir)
    if (!existsSync(dir)) return null

    const source = readSourceLines(dir, options)
    if (source === null) return null

    const sessionId = randomUUID()
    const forked = source.exact
      ? buildForkedSessionLinesAtTurn(source.lines, {
          newSessionId: sessionId,
          keepPrompts: options.turnIndex
        })
      : buildForkedSessionLines(source.lines, {
          newSessionId: sessionId,
          cutoffMs: forkCutoffMs(options.turns, options.turnIndex)
        })
    if (forked.length === 0) return null

    writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${forked.join('\n')}\n`, 'utf8')
    return { sessionId }
  } catch (error) {
    console.error('Native Claude session fork failed, falling back to preamble:', error)
    return null
  }
}
