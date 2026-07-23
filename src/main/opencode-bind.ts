// OpenCode session binder (agent-recover feature; recipe validated by Tinker):
// OpenCode persists each session at
// ~/.local/share/opencode/storage/session/<projectID>/ses_<id>.json with
// {id, directory (cwd), projectID, title, time:{created,updated}}. A terminal
// binds to the newest session whose directory == its cwd within the spawn
// window; the id (ses_<base62>) persists on the node as opencodeSessionId,
// so `opencode --session <id>` resumes it. Mirrors codex-bind exactly.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { realCwd } from './claude-fork'

export function isOpenCodeCommand(command: string): boolean {
  return /^\s*opencode\b/.test(command)
}

/** |session.time.created - spawnedAt| tolerance for the spawn-time bind. */
export const OPENCODE_SPAWN_WINDOW_MS = 180_000

export function defaultOpencodeStorageDir(): string {
  return path.join(homedir(), '.local', 'share', 'opencode', 'storage', 'session')
}

interface OpencodeSession {
  id: string
  directory: string
  created: number
}

function readSession(file: string): OpencodeSession | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const r = raw as { id?: unknown; directory?: unknown; time?: { created?: unknown } }
    if (typeof r.id !== 'string' || typeof r.directory !== 'string') return null
    return {
      id: r.id,
      directory: r.directory,
      created: typeof r.time?.created === 'number' ? r.time.created : 0
    }
  } catch {
    return null
  }
}

/** The ses_ id an opencode PROCESS holds open (deterministic, 1:1). Pure. */
export function opencodeSessionFromOpenFiles(openFiles: readonly string[]): string | null {
  // Dedupe: lsof -Fn lists one line per fd; the same session held on two fds
  // is one session, not an ambiguous pair.
  const ids = [
    ...new Set(
      openFiles
        .filter((f) => /\/ses_[A-Za-z0-9]+\.json$/.test(f) && f.includes('storage'))
        .map((f) => path.basename(f, '.json'))
    )
  ]
  return ids.length === 1 ? ids[0] : null
}

/**
 * Does a resumable session file still exist for this ses_ id? (S1 — the
 * EXACT-CONTEXT gate must not pass a DELETED opencode session and fresh-boot.)
 * The file lives under a hashed <projectID>/ we don't reconstruct, so scan the
 * project dirs for `<sessionId>.json`. The shape check also guards traversal.
 */
export function opencodeSessionFileExists(
  sessionId: string,
  storageDir: string = defaultOpencodeStorageDir()
): boolean {
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId)) return false
  if (!existsSync(storageDir)) return false
  let projects: string[]
  try {
    projects = readdirSync(storageDir)
  } catch {
    return false
  }
  return projects.some((proj) => existsSync(path.join(storageDir, proj, `${sessionId}.json`)))
}

export type OpencodeOpenFilesReader = (pid: number) => string[]

const defaultOpencodeOpenFiles: OpencodeOpenFilesReader = (pid) => {
  try {
    return execFileSync('lsof', ['-p', String(pid), '-Fn'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000
    })
      .toString('utf8')
      .split('\n')
      .filter((l) => l.startsWith('n'))
      .map((l) => l.slice(1))
  } catch {
    return []
  }
}

/** Deterministically resolve an opencode session by the file its process holds open. */
export function resolveOpencodeSessionByPid(
  pid: number | null,
  readOpenFiles: OpencodeOpenFilesReader = defaultOpencodeOpenFiles
): string | null {
  if (pid === null || !Number.isFinite(pid) || pid <= 0) return null
  return opencodeSessionFromOpenFiles(readOpenFiles(pid))
}

export interface OpencodeBindOptions {
  cwd: string
  /** Epoch ms of spawn; null = lazy bind (cwd match only, no time window). */
  spawnedAt: number | null
  /** Override for tests; defaults to the real storage dir. */
  storageDir?: string
  /** opencodeSessionIds already claimed by other terminals (disambiguation). */
  exclude?: ReadonlySet<string>
}

/**
 * The OpenCode session id a terminal belongs to: newest cwd-matching session
 * within the spawn window (dropped for a lazy bind), excluding sibling-claimed
 * ids. Null when nothing matches.
 */
export function resolveOpencodeSession(options: OpencodeBindOptions): string | null {
  const base = options.storageDir ?? defaultOpencodeStorageDir()
  if (!existsSync(base)) return null
  let projects: string[]
  try {
    projects = readdirSync(base)
  } catch {
    return null
  }
  const candidates: OpencodeSession[] = []
  for (const proj of projects) {
    const dir = path.join(base, proj)
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of files) {
      if (!name.startsWith('ses_') || !name.endsWith('.json')) continue
      const s = readSession(path.join(dir, name))
      if (!s || s.directory !== realCwd(options.cwd)) continue
      if (options.exclude?.has(s.id)) continue
      if (
        options.spawnedAt !== null &&
        Math.abs(s.created - options.spawnedAt) > OPENCODE_SPAWN_WINDOW_MS
      ) {
        continue
      }
      candidates.push(s)
    }
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.created - a.created)
  return candidates[0].id
}
