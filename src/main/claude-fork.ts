// Native Claude Code session integration, filesystem side.
//
// Every Claude terminal is bound to a known session id at spawn
// (claudeSpawnCommand), so session-file features never guess which session
// file under ~/.claude/projects belongs to a terminal. Forking copies the
// source's session file truncated at the fork turn under a fresh id — the
// origin file is opened read-only. Terminals from before ids were stored
// fall back to matching their scraped turn history against candidate files.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { TurnRecord } from '../shared/turn'
import { parseClaudeTrace } from '../shared/trace-blocks'
import {
  buildForkedSessionLinesAtTurn,
  buildForkedSessionLinesAtUuid,
  buildForkedSessionLinesForUuids,
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

/**
 * The cwd as the AGENT process sees it: session files are keyed by the
 * realpath, not the symlink the terminal was launched with (macOS /tmp ->
 * /private/tmp). Resolving the wrong slug made existsSync miss the session
 * file, so recover silently minted a fresh session instead of resuming (R2).
 */
export function realCwd(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}

export function claudeProjectDir(cwd: string, projectsDir?: string): string {
  const base = projectsDir ?? path.join(homedir(), '.claude', 'projects')
  return path.join(base, claudeProjectSlug(realCwd(cwd)))
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

/**
 * True when a session id is UUID-shaped — the ONLY shape safe to interpolate
 * into session-file paths (claudeSessionFile is a bare path.join, so a
 * tampered id like '../../etc/x' would otherwise escape the project dir).
 */
export function isSessionUuid(id: string): boolean {
  return SESSION_UUID_RE.test(id)
}

/**
 * Session file to poll for durable turn history (SessionTurnSync), or null
 * when the stored id is unusable. Defense-in-depth (mirrors the codex
 * planted-ref defense): the id flows into a path on a poll timer, so it is
 * UUID-checked here even though spawn already validates it.
 */
export function claudeWatchFile(
  node: { cwd: string; claudeSessionId?: string | null },
  options: { projectsDir?: string } = {}
): string | null {
  const id = node.claudeSessionId
  if (!id || !isSessionUuid(id)) return null
  return claudeSessionFile(node.cwd, id, options.projectsDir)
}

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
/**
 * Strict resolution for the RECOVER path (EXACT-CONTEXT gate): returns the
 * exact existing session id (stored-with-file, flagged, or turn-history
 * match) or NULL — it NEVER mints a fresh id. Recover uses null to report
 * "cannot restore exact session" instead of silently booting fresh.
 */
export function resolveExistingClaudeSession(options: ResolveSessionOptions): string | null {
  // The recover gate and the spawn resolver MUST agree on what "the existing
  // session" is — a drift between two copies is how recover minted fresh over
  // a live conversation (R2). Both derive from this ONE core; strict returns
  // its null, the spawn resolver falls back to minting.
  return findExistingClaudeSession(options)
}

/**
 * The exact existing session id — stored-with-file, a flagged id whose file
 * exists, or the best turn-history match — or NULL. Pure lookup, never mints.
 * Single source of truth for both the strict (recover) and minting (spawn)
 * resolvers so the EXACT-CONTEXT gate can never disagree with what spawns.
 */
function findExistingClaudeSession(options: ResolveSessionOptions): string | null {
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
    if (flagged && existsSync(claudeSessionFile(cwd, flagged, projectsDir))) return flagged
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
    console.error('Claude session resolution failed:', error)
  }
  return null
}

export function resolveClaudeSessionId(options: ResolveSessionOptions): string {
  const existing = findExistingClaudeSession(options)
  if (existing !== null) return existing
  // No existing session: keep a valid stored id (idempotent) or mint a fresh
  // one that claude adopts on a genuinely new terminal's first boot.
  return options.storedId && SESSION_UUID_RE.test(options.storedId)
    ? options.storedId
    : randomUUID()
}

export interface ClaudeForkOptions {
  command: string
  cwd: string
  /** The source terminal's bound session id, when it has one. */
  sessionId?: string | null
  turns: TurnRecord[]
  turnIndex: number
  /**
   * Directory the FORK will run in; the copy is written into ITS project
   * dir (worktree / fresh team dir) so `--resume` finds it there. Defaults
   * to `cwd`.
   */
  targetCwd?: string
  /**
   * Snapshot session lines to fork from instead of the live file on disk
   * (team-save snapshots, checkpoint-program-spec item 2b). Treated as an
   * exact (uuid-capable) source.
   */
  sourceLines?: string[]
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
  if (options.sourceLines) return { lines: options.sourceLines, exact: true }
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
    if (!options.sourceLines && !existsSync(dir)) return null

    const source = readSourceLines(dir, options)
    if (source === null) return null

    // Cutoff per the session-binding contract (team-fork-roles-spec-v1):
    // the cut binds to a precise session entry by message uuid whenever the
    // source was resolved exactly (stored sessionId / snapshot lines);
    // otherwise cut by prompt position. Never by timestamp — scrape timing
    // drifts from session write times.
    //
    // TWO INDEX SPACES meet here (checkpoint-session-alignment). The rail and
    // drawer number the CURRENT session file from T1 (file space), while the
    // durable ledger deliberately CONTINUES its numbering across a /compact
    // rotation (ledger space, bca5ed2) — so after a compact the same
    // turnIndex names DIFFERENT turns in the two spaces. The file's OWN block
    // at turnIndex wins: a rail-originated fork means "this row of the file I
    // am looking at", and the block's id is that row's message uuid. A
    // ledger-space caller (call-fork passes the chain's latest index, which
    // can exceed the file's block count) finds no such block and falls back
    // to the ledger record's uuid — the latest turn's uuid is identical in
    // both spaces, so that caller still cuts at the right entry.
    const fileBlock = source.exact
      ? parseClaudeTrace(source.lines).find((b) => b.index === options.turnIndex)
      : undefined
    const cutRecord = options.turns.find((t) => t.index === options.turnIndex)
    const cutoffUuid = fileBlock?.id ?? (source.exact ? cutRecord?.uuid : undefined)
    const sessionId = randomUUID()
    const forked = cutoffUuid
      ? buildForkedSessionLinesAtUuid(source.lines, {
          newSessionId: sessionId,
          cutoffUuid
        })
      : buildForkedSessionLinesAtTurn(source.lines, {
          newSessionId: sessionId,
          keepPrompts: options.turnIndex
        })
    if (forked.length === 0) return null

    writeForkedSession(options, sessionId, forked)
    return { sessionId }
  } catch (error) {
    console.error('Native Claude session fork failed, falling back to preamble:', error)
    return null
  }
}

/** The copy lands in the project dir of the dir the FORK runs in. */
function writeForkedSession(
  options: Pick<ClaudeForkOptions, 'cwd' | 'targetCwd' | 'projectsDir'>,
  sessionId: string,
  lines: string[]
): void {
  const targetDir = claudeProjectDir(options.targetCwd ?? options.cwd, options.projectsDir)
  mkdirSync(targetDir, { recursive: true })
  writeFileSync(path.join(targetDir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
}

/** Stable, role-owned store for checkpoint session copies. */
export function roleSessionDir(baseDir?: string): string {
  return path.join(baseDir ?? path.join(homedir(), '.cookrew'), 'roles', 'sessions')
}

export interface RoleSessionCopyOptions {
  command: string
  cwd: string
  /** The source terminal's bound session id. */
  sessionId?: string | null
  /** Checkpoint message uuid to truncate the copy at (inclusive). */
  sourceTurnUuid: string
  /** Where to write the copy (roleSessionDir). */
  destDir: string
  projectsDir?: string
}

/**
 * Save-role-from-checkpoint (checkpoint-program-spec item 4): write a
 * TRUNCATED copy of the source Claude session — up to and including the
 * checkpoint's uuid — into destDir under a fresh id, returned as the role's
 * sessionCopyRef. Null when the source is not Claude or its session file
 * can't be found (Codex/legacy → no native restore; caller boots fresh).
 * Uses the same uuid-cut machinery as the fork engine.
 */
export function saveRoleSessionCopy(options: RoleSessionCopyOptions): string | null {
  try {
    if (!isClaudeCommand(options.command) || !options.sessionId) return null
    const file = claudeSessionFile(options.cwd, options.sessionId, options.projectsDir)
    if (!existsSync(file)) return null
    const refId = randomUUID()
    const truncated = buildForkedSessionLinesAtUuid(readFileSync(file, 'utf8').split('\n'), {
      newSessionId: refId,
      cutoffUuid: options.sourceTurnUuid
    })
    if (truncated.length === 0) return null
    mkdirSync(options.destDir, { recursive: true })
    writeFileSync(path.join(options.destDir, `${refId}.jsonl`), `${truncated.join('\n')}\n`, 'utf8')
    return refId
  } catch (error) {
    console.error('Role session copy failed, role will boot fresh:', error)
    return null
  }
}

export interface RoleSessionResumeOptions {
  sessionCopyRef: string
  /** Where the copy was stored (roleSessionDir). */
  copyDir: string
  /** The booting terminal's cwd (its Claude project dir receives the copy). */
  cwd: string
  projectsDir?: string
}

/**
 * Role-boot native restore: copy the stored checkpoint session under a FRESH
 * id into the booting terminal's Claude project dir so the agent can
 * --resume the checkpoint context. Returns the fresh id to bind, or null when
 * the stored copy is missing (caller boots fresh). Each boot gets its own id
 * so one role can seed many terminals without sharing a session file.
 */
export function resumeRoleSession(options: RoleSessionResumeOptions): string | null {
  try {
    // Refs are always app-minted UUIDs; validate anyway so a future caller
    // forwarding a user-supplied ref can never traverse out of copyDir.
    if (!SESSION_UUID_RE.test(options.sessionCopyRef)) return null
    const src = path.join(options.copyDir, `${options.sessionCopyRef}.jsonl`)
    if (!existsSync(src)) return null
    const freshId = randomUUID()
    const restamped = readFileSync(src, 'utf8')
      .split('\n')
      .map((line) => {
        if (line.trim().length === 0) return line
        try {
          const rec = JSON.parse(line) as { sessionId?: string }
          return typeof rec.sessionId === 'string'
            ? JSON.stringify({ ...rec, sessionId: freshId })
            : line
        } catch {
          return line
        }
      })
      .join('\n')
    const destDir = claudeProjectDir(options.cwd, options.projectsDir)
    mkdirSync(destDir, { recursive: true })
    writeFileSync(path.join(destDir, `${freshId}.jsonl`), restamped, 'utf8')
    return freshId
  } catch (error) {
    console.error('Role session resume failed, booting fresh:', error)
    return null
  }
}

export interface ClaudeAssembledForkOptions extends Omit<ClaudeForkOptions, 'turnIndex'> {
  /** Checkpoint (turn) indexes whose uuid ranges the fork keeps. */
  turnIndexes: number[]
}

/**
 * Assembled native fork (checkpoint-program-spec item 2a): copy the session
 * keeping ONLY the selected checkpoints' uuid ranges. Requires an exact
 * source (stored session id or snapshot lines) and uuid-bearing records for
 * EVERY selected checkpoint — anything less returns null and the caller
 * falls back to the preamble replay (Codex/legacy).
 */
export function forkClaudeSessionAssembled(
  options: ClaudeAssembledForkOptions
): ClaudeForkResult | null {
  try {
    if (!isClaudeCommand(options.command)) return null
    const dir = claudeProjectDir(options.cwd, options.projectsDir)
    if (!options.sourceLines && !existsSync(dir)) return null

    const source = readSourceLines(dir, { ...options, turnIndex: 0 })
    if (source === null || !source.exact) return null

    // TODO(checkpoint-session-alignment, ruled 2026-08-30): keepUuids resolves
    // through the LEDGER by index, the exact wrong-space join forkClaudeSession
    // above was cured of — on a compacted terminal a rail-selected "T5" is the
    // ledger's fifth turn, which can be a pre-compact turn from another file.
    // Deliberately left as-is (owner ruling: implement when the multi-select
    // fork is actually used). The fix is the same shape as above: resolve each
    // selected index against parseClaudeTrace(source.lines) first, ledger
    // record second. The coverage check below at least refuses a fork whose
    // resolved uuid is absent from the source file, so the failure is an
    // honest null (preamble fallback), never a silently wrong assembly.
    const byIndex = new Map(options.turns.map((t) => [t.index, t]))
    const keepUuids = options.turnIndexes.map((i) => byIndex.get(i)?.uuid)
    if (keepUuids.length === 0 || keepUuids.some((u) => u === undefined)) return null

    const sessionId = randomUUID()
    const forked = buildForkedSessionLinesForUuids(source.lines, {
      newSessionId: sessionId,
      keepUuids: keepUuids as string[]
    })
    if (forked.length === 0) return null

    // A /rewind between reconcile and a live assembled fork can leave a
    // selected checkpoint's uuid absent from the source lines — the builder
    // then returns header-only/partial content while the fork notice still
    // claims every checkpoint. Verify coverage; fall back to preamble if any
    // selected checkpoint didn't actually make it into the fork.
    const forkedUuids = new Set(
      forked.map((line) => {
        try {
          return (JSON.parse(line) as { uuid?: string }).uuid
        } catch {
          return undefined
        }
      })
    )
    if ((keepUuids as string[]).some((u) => !forkedUuids.has(u))) return null

    writeForkedSession(options, sessionId, forked)
    return { sessionId }
  } catch (error) {
    console.error('Assembled native fork failed, falling back to preamble:', error)
    return null
  }
}
