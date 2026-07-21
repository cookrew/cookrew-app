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
  buildForkedSessionLinesAtTurn,
  buildForkedSessionLinesAtUuid,
  buildResumeCommand,
  buildSessionIdCommand,
  claudeProjectSlug,
  extractSessionFlag,
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

/** Session ids must be UUID-shaped before use in file paths / launch commands. */
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ResolveSessionOptions {
  command: string
  cwd: string
  /** Session id currently persisted on the terminal node (may be stale/phantom). */
  storedId?: string | null
  /** The terminal's persisted turn history, used to recover a diverged id. */
  turns: TurnRecord[]
  /** Override for tests; defaults to ~/.claude/projects. */
  projectsDir?: string
}

/**
 * The session id a Claude terminal should bind to at (re)spawn.
 *
 * A terminal whose tmux session is still alive keeps whatever session claude
 * is really running: `new-session -A` REATTACHES and ignores our boot command,
 * so any session id minted here never reaches claude and silently diverges
 * from the file claude actually writes. That divergence is invisible until a
 * COLD boot (system reboot / tmux server death), when the phantom id has no
 * session file and naively resuming it starts the agent from an EMPTY
 * conversation — the "agent didn't recover after reboot" bug.
 *
 * Resolution order:
 *  1. A stored id whose session file exists — the normal resume path.
 *  2. A session id baked into the launch command whose file exists (legacy forks).
 *  3. Recovery: match the terminal's turn history against the real session files
 *     under its cwd and adopt the best (newest on ties). scoreSessionMatch only
 *     credits THIS terminal's own prompts, so a match is always one of this
 *     agent's own sessions — its real conversation, never a neighbour's.
 *  4. No signal → keep a valid stored id (idempotent) or mint a fresh one that
 *     claude adopts on a genuinely new terminal's first boot.
 */
export function resolveClaudeSessionId(options: ResolveSessionOptions): string {
  const { command, cwd, storedId, turns, projectsDir } = options
  try {
    if (
      storedId &&
      SESSION_UUID_RE.test(storedId) &&
      existsSync(claudeSessionFile(cwd, storedId, projectsDir))
    ) {
      return storedId
    }
    const flagged = extractSessionFlag(command)
    if (flagged && existsSync(claudeSessionFile(cwd, flagged, projectsDir))) {
      return flagged
    }
    const dir = claudeProjectDir(cwd, projectsDir)
    if (turns.length > 0 && existsSync(dir)) {
      // readCandidates sorts newest-first; the strict-greater reduce keeps the
      // newest file on score ties — the live conversation over a stale sibling.
      const best = readCandidates(dir, turns).reduce<Candidate | null>(
        (acc, c) => (acc === null || c.score > acc.score ? c : acc),
        null
      )
      if (best !== null && best.score >= 1) return path.basename(best.file, '.jsonl')
    }
  } catch (error) {
    console.error('Claude session id resolution failed, keeping stored/fresh id:', error)
  }
  return storedId && SESSION_UUID_RE.test(storedId) ? storedId : randomUUID()
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
 * `exact` truncation (uuid, else position) by real message boundaries
 * applies. Terminals from before ids existed fall back to scoring candidate
 * files against scraped turn history and cut by prompt position.
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

    // Cutoff per the session-binding contract (team-fork-roles-spec-v1):
    // the fork turn's message uuid binds the cut to the precise session
    // entry whenever the record carries one AND the file was resolved
    // exactly by sessionId; otherwise cut by prompt position. Never by
    // timestamp — scrape timing drifts from session write times.
    const cutRecord = options.turns.find((t) => t.index === options.turnIndex)
    const sessionId = randomUUID()
    const forked =
      source.exact && cutRecord?.uuid
        ? buildForkedSessionLinesAtUuid(source.lines, {
            newSessionId: sessionId,
            cutoffUuid: cutRecord.uuid
          })
        : buildForkedSessionLinesAtTurn(source.lines, {
            newSessionId: sessionId,
            keepPrompts: options.turnIndex
          })
    if (forked.length === 0) return null

    writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${forked.join('\n')}\n`, 'utf8')
    return { sessionId }
  } catch (error) {
    console.error('Native Claude session fork failed, falling back to preamble:', error)
    return null
  }
}
