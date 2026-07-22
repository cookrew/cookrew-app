// Codex rollout binder (note trace-sourced-context-final): Codex writes
// append-only rollouts at ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
// whose FIRST record is session_meta {session_id, cwd, timestamp}. A terminal
// binds to the newest rollout matching its cwd within the spawn window; the
// ref persists on the node (codexSessionRef) like claudeSessionId.

import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { CodexSessionMeta, parseCodexSessionMeta } from '../shared/trace-blocks'

/** |session_meta.timestamp - spawnedAt| tolerance for the spawn-time bind. */
export const CODEX_SPAWN_WINDOW_MS = 180_000

/** session_meta always fits well within the first lines of a rollout. */
const HEAD_BYTES = 8192

export function isCodexCommand(command: string): boolean {
  return /^\s*codex\b/.test(command)
}

export function defaultCodexSessionsDir(): string {
  return path.join(homedir(), '.codex', 'sessions')
}

/** First line of a (possibly large) rollout, without reading the file. */
function readFirstLine(file: string): string | null {
  try {
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(HEAD_BYTES)
      const bytes = readSync(fd, buffer, 0, HEAD_BYTES, 0)
      const head = buffer.toString('utf8', 0, bytes)
      const newline = head.indexOf('\n')
      return newline === -1 ? head : head.slice(0, newline)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Rollout day dirs to scan for a moment: its UTC date and the day before. */
function dayDirs(base: string, aroundMs: number): string[] {
  const dirs: string[] = []
  for (const deltaDays of [0, -1, 1]) {
    const d = new Date(aroundMs + deltaDays * 86_400_000)
    dirs.push(
      path.join(
        base,
        String(d.getUTCFullYear()),
        String(d.getUTCMonth() + 1).padStart(2, '0'),
        String(d.getUTCDate()).padStart(2, '0')
      )
    )
  }
  return dirs
}

export interface CodexBindOptions {
  cwd: string
  /** Epoch ms the terminal spawned; null = lazy bind (cwd match only). */
  spawnedAt: number | null
  /** Override for tests; defaults to ~/.codex/sessions. */
  sessionsDir?: string
  /**
   * Rollout files already claimed by OTHER terminals (resolved paths) —
   * two codex terminals in one cwd must never bind the same file.
   */
  exclude?: ReadonlySet<string>
  /** Rebind hint: a candidate with this session_id wins outright. */
  preferSessionId?: string | null
}

/** The rollout uuid baked into a ref's filename, for rebind preference. */
export function sessionIdFromRolloutPath(file: string): string | null {
  const match = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
    file
  )
  return match ? match[1] : null
}

interface Candidate {
  file: string
  meta: CodexSessionMeta
}

/**
 * The rollout file a Codex terminal belongs to: newest session_meta with
 * cwd == terminal cwd, constrained to the spawn window when spawnedAt is
 * known (spawn-time bind); the lazy bind (first trace fetch) drops the time
 * constraint — rollouts appear seconds AFTER our spawn, so the lazy retry
 * is what usually wins. Null when nothing matches.
 */
export function resolveCodexRollout(options: CodexBindOptions): string | null {
  const base = options.sessionsDir ?? defaultCodexSessionsDir()
  const scanDirs = dayDirs(base, options.spawnedAt ?? Date.now())
  const candidates: Candidate[] = []
  for (const dir of scanDirs) {
    if (!existsSync(dir)) continue
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of files) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
      const file = path.join(dir, name)
      if (options.exclude?.has(path.resolve(file))) continue
      const first = readFirstLine(file)
      const meta = first === null ? null : parseCodexSessionMeta(first)
      if (!meta || meta.cwd !== options.cwd) continue
      if (
        options.spawnedAt !== null &&
        Math.abs(meta.timestampMs - options.spawnedAt) > CODEX_SPAWN_WINDOW_MS
      ) {
        continue
      }
      candidates.push({ file, meta })
    }
  }
  if (candidates.length === 0) return null
  if (options.preferSessionId) {
    const preferred = candidates.find((c) => c.meta.sessionId === options.preferSessionId)
    if (preferred) return preferred.file
  }
  candidates.sort((a, b) => b.meta.timestampMs - a.meta.timestampMs)
  return candidates[0].file
}
