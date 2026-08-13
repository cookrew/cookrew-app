// Carrying an agent's conversation when its terminal moves to another
// working directory.
//
// A live process cannot chdir, so repointing a terminal's cwd kills and
// respawns it. The respawn only continues the SAME conversation if the
// harness can still find its session where the agent now runs — and two
// harnesses key their sessions BY the working directory:
//
//   claude — the session file lives under ~/.claude/projects/<slug(cwd)>/
//   pi     — session files carry the cwd in their header, and the binding
//            only accepts a header whose cwd matches the terminal's
//
// so the move stranded the conversation in the old directory: the agent
// booted empty, and the session-file reconcile then REPLACED the terminal's
// turn records with that empty session's — the checkpoints went with it.
//
// This module carries the session across, under the SAME session ref. Same
// ref, not a fresh one: forking mints a new id because a fork DIVERGES from
// an origin that keeps running, while a move leaves no origin behind.
// Keeping the ref means no lineage transition, no spurious /clear marker on
// the rail, and checkpoint ordinals that are identical either side of the
// move — which is what "keep the checkpoints" has to mean.
//
// Codex and OpenCode need nothing: their sessions are addressed by a global
// id, so `resume <id>` reaches the same conversation from any directory.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { TerminalNodeData } from '../shared/model'
import type { TurnRecord } from '../shared/turn'
import {
  claudeProjectDir,
  claudeSessionFile,
  isSessionUuid,
  resolveExistingClaudeSession
} from './claude-fork'
import { harnessFor, type SessionField } from './harness'
import { piNodeSessionDir, piSessionHome, validPiSessionId } from './pi-bind'

/** The node fields a carry reads: identity, harness, and session bindings. */
export type MovableNode = Pick<TerminalNodeData, 'id' | 'command'> &
  Partial<Pick<TerminalNodeData, SessionField>>

export interface SessionMoveOptions {
  node: MovableNode
  fromCwd: string
  toCwd: string
  /**
   * Terminal id the session lands UNDER, when the card is not the one it left
   * — a cut-and-paste re-ids the terminal, so Pi's per-node session dir has a
   * different name on each side of the move. Defaults to the source's own id
   * (a workdir change, where the card keeps its identity).
   */
  toNodeId?: string
  /**
   * The terminal's turn history. A stored session id can DIVERGE from the
   * file the agent is really writing (a reattach that ignored our boot
   * command, a /clear), and history is what identifies the real one — the
   * same recovery the spawn resolver runs. Without it a drifted terminal
   * would carry nothing and boot empty in the new directory.
   */
  turns?: TurnRecord[]
  /** Override for tests; defaults to ~/.claude/projects. */
  projectsDir?: string
  /** Override for tests; defaults to ~/.cookrew/pi-sessions. */
  piSessionsRoot?: string
  /** Override for tests; defaults to ~/.pi/agent. */
  piAgentDir?: string
}

export type SessionMoveOutcome =
  /** The conversation now resolves from `toCwd` under this ref. */
  | { kind: 'carried'; sessionRef: string }
  /** Nothing to do: no harness, no move, or a globally-addressed session. */
  | { kind: 'not-needed' }
  /** A directory-keyed harness whose session could not be found or written. */
  | { kind: 'unavailable' }

/**
 * Make the terminal's bound session resolvable from `toCwd`, so the respawn
 * resumes the conversation it was having instead of booting a fresh one.
 * Never throws — a move must not be blocked by a conversation we cannot
 * find; the caller respawns either way and reports what happened.
 */
export function carrySessionToCwd(options: SessionMoveOptions): SessionMoveOutcome {
  if (options.fromCwd === options.toCwd) return { kind: 'not-needed' }
  const harness = harnessFor(options.node.command)
  if (!harness) return { kind: 'not-needed' }
  const ref = options.node[harness.sessionField] ?? null
  try {
    if (harness.id === 'claude') return carryClaudeSession(options, ref)
    if (harness.id === 'pi') return carryPiSession(options, ref)
  } catch (error) {
    console.error('Carrying the session to the new directory failed:', error)
    return { kind: 'unavailable' }
  }
  // codex / opencode: the ref IS the address, independent of any directory.
  return { kind: 'not-needed' }
}

/**
 * Copy the session file into the new directory's project dir. A copy, not a
 * rename: the original costs nothing to keep and is the trail back if the
 * user moves the card straight back again.
 *
 * WHICH file is the spawn resolver's answer, not the stored id's — the two
 * diverge, and this must carry the conversation the agent actually had. The
 * respawn re-runs that same resolution in the new directory, so an id it
 * recovered here is the one it adopts there.
 */
function carryClaudeSession(
  options: SessionMoveOptions,
  stored: string | null
): SessionMoveOutcome {
  const ref = resolveExistingClaudeSession({
    command: options.node.command,
    cwd: options.fromCwd,
    storedId: stored,
    turns: options.turns ?? [],
    projectsDir: options.projectsDir
  })
  // The ref becomes a path component, and a stored one can arrive from
  // persisted or mobile-originated node data — UUID-shape it either way.
  if (!ref || !isSessionUuid(ref)) return { kind: 'unavailable' }
  const source = claudeSessionFile(options.fromCwd, ref, options.projectsDir)
  if (!existsSync(source)) return { kind: 'unavailable' }
  const targetDir = claudeProjectDir(options.toCwd, options.projectsDir)
  const target = path.join(targetDir, `${ref}.jsonl`)
  if (target !== source) {
    mkdirSync(targetDir, { recursive: true })
    copyFileSync(source, target)
  }
  return { kind: 'carried', sessionRef: ref }
}

/**
 * Repoint the Pi session at the new directory: rewrite its header cwd (the
 * field the binding matches on) and land it in this terminal's exclusive
 * session dir — which is where the binding looks first, and where a session
 * adopted from a legacy pane's own cwd dir has to end up to survive a move.
 */
function carryPiSession(options: SessionMoveOptions, ref: string | null): SessionMoveOutcome {
  if (!ref || !validPiSessionId(ref)) return { kind: 'unavailable' }
  const home = piSessionHome(options.fromCwd, ref, options.node.id, {
    sessionsRoot: options.piSessionsRoot,
    agentDir: options.piAgentDir
  })
  if (!home) return { kind: 'unavailable' }
  const moved = withPiHeaderCwd(readFileSync(home.file, 'utf8'), options.toCwd)
  if (moved === null) return { kind: 'unavailable' }
  // Source dir keyed by the OLD id (above), destination by the new one: a
  // cut-and-paste re-ids the card, and writing back under the source's id
  // would leave the session in a dir the new terminal never looks in.
  const exclusive = piNodeSessionDir(options.toNodeId ?? options.node.id, {
    rootDir: options.piSessionsRoot
  })
  mkdirSync(exclusive, { recursive: true })
  writeFileSync(path.join(exclusive, path.basename(home.file)), moved, 'utf8')
  return { kind: 'carried', sessionRef: ref }
}

/**
 * A Pi session file with its header cwd repointed, or null when the first
 * record is not a session header — in which case the file is not one we
 * understand and must be left exactly as it is. Every other line is passed
 * through byte-for-byte: only the one field that decides which directory
 * owns the session changes.
 */
export function withPiHeaderCwd(text: string, cwd: string): string | null {
  const lines = text.split('\n')
  const first = lines.findIndex((line) => line.trim().length > 0)
  if (first === -1) return null
  try {
    const header = JSON.parse(lines[first]) as { type?: string; cwd?: string }
    if (header.type !== 'session') return null
    const rewritten = [...lines]
    rewritten[first] = JSON.stringify({ ...header, cwd })
    return rewritten.join('\n')
  } catch {
    return null
  }
}
