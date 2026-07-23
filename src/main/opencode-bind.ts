// OpenCode session binder (agent-recover feature; recipe validated by Tinker):
// OpenCode persists each session at
// ~/.local/share/opencode/storage/session/<projectID>/ses_<id>.json with
// {id, directory (cwd), projectID, title, time:{created,updated}}. A terminal
// binds to the newest session whose directory == its cwd within the spawn
// window; the id (ses_<base62>) persists on the node as opencodeSessionId,
// so `opencode --session <id>` resumes it. Mirrors codex-bind exactly.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

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
      if (!s || s.directory !== options.cwd) continue
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
