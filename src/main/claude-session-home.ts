// WHERE A CLAUDE SESSION REALLY LIVES — whatever the card's cwd says.
//
// Claude files a transcript under ~/.claude/projects/<slug of its LAUNCH
// directory>/<session id>.jsonl. Cookrew derives that path from the card's
// cwd, which is right only when the agent was started there. 2026-11-04:
// eight GOAT Team cards said goat-dev while their claude ran in
// goat-testnet/solis-orch (an adopted herdr pane kept its old directory), so
// the session observer watched a file that never appeared, never
// materialized, and the dispatch sweep interrupted every --no-wait ask to
// them 60 s in — while the agents answered.
//
// A session id is a UUID Claude mints, so `<id>.jsonl` names one conversation;
// a copy can exist (session-move.ts carries a transcript to a new dir and
// leaves the source), and then the one most recently written is the live one.
// Found files are cached (re-checked with one stat); a miss is retried after
// MISS_RETRY_MS, because a fresh session has no file yet.
//
// The LAUNCH DIRECTORY (claudeLaunchDir) is only needed to repair a card, so
// it is computed on demand and never cached: first a `cwd` record in the
// file's head whose slug is the project dir's name, else the directory
// rebuilt from that name by walking the filesystem — a slug maps every
// non-alphanumeric to '-', so text alone cannot invert it, but the disk can.
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { claudeProjectSlug } from '../shared/claude-fork'

export interface ClaudeSessionHome {
  file: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MISS_RETRY_MS = 5_000
const HEAD_BYTES = 64 * 1024

const found = new Map<string, ClaudeSessionHome>()
const missedAt = new Map<string, number>()

/** Drop every cached answer (tests; a projects dir that moved). */
export function forgetClaudeSessionHomes(): void {
  found.clear()
  missedAt.clear()
}

export function findClaudeSessionHome(
  sessionId: string,
  options: { projectsDir?: string; now?: () => number } = {}
): ClaudeSessionHome | null {
  if (!UUID_RE.test(sessionId)) return null
  const base = options.projectsDir ?? path.join(homedir(), '.claude', 'projects')
  const key = `${base}\0${sessionId}`
  const cached = found.get(key)
  if (cached && existsSync(cached.file)) return cached
  found.delete(key)
  const now = (options.now ?? Date.now)()
  const missed = missedAt.get(key)
  if (missed !== undefined && now - missed < MISS_RETRY_MS) return null
  const home = scan(base, sessionId)
  if (home) {
    found.set(key, home)
    missedAt.delete(key)
  } else {
    missedAt.set(key, now)
  }
  return home
}

function scan(base: string, sessionId: string): ClaudeSessionHome | null {
  let dirs: string[]
  try {
    dirs = readdirSync(base)
  } catch {
    return null
  }
  const files = dirs
    .map((dir) => path.join(base, dir, `${sessionId}.jsonl`))
    .filter((file) => existsSync(file))
  if (files.length === 0) return null
  // A carried copy leaves its source behind: the file still being written is
  // the conversation.
  const file = files.reduce((a, b) => (mtimeOf(b) > mtimeOf(a) ? b : a))
  return { file }
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/**
 * The directory claude was launched in for a transcript: its project dir's
 * name read back into a real, existing path. Null only when no directory
 * matches — never a guess.
 */
export function claudeLaunchDir(file: string, root: string = path.sep): string | null {
  const projectDir = path.basename(path.dirname(file))
  return cwdFromHead(file, projectDir) ?? dirForSlug(projectDir, root)
}

/**
 * Walk the filesystem from `root` along the slug: at each level, the entries
 * whose own slug continues it. Depth-first, so a dir named `a-b` and a path
 * `a/b` are both tried; the first full match that exists wins.
 */
export function dirForSlug(slug: string, root: string = path.sep): string | null {
  const walk = (dir: string, rest: string): string | null => {
    if (rest === '') return dir
    if (!rest.startsWith('-')) return null
    let names: string[]
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
    } catch {
      return null
    }
    for (const name of names) {
      const piece = `-${claudeProjectSlug(name)}`
      if (rest === piece || rest.startsWith(`${piece}-`)) {
        const hit = walk(path.join(dir, name), rest.slice(piece.length))
        if (hit !== null) return hit
      }
    }
    return null
  }
  // The root itself contributes its own slug ('/' → '-'), consumed up front.
  const rootSlug = claudeProjectSlug(root.endsWith(path.sep) ? root.slice(0, -1) : root)
  if (!slug.startsWith(rootSlug)) return null
  return walk(root, slug.slice(rootSlug.length))
}

/** The `cwd` a head record carries whose project slug is the file's own dir name. */
function cwdFromHead(file: string, projectDir: string): string | null {
  let head: string
  try {
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(HEAD_BYTES)
      const read = readSync(fd, buffer, 0, HEAD_BYTES, 0)
      head = buffer.subarray(0, read).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
  for (const line of head.split('\n')) {
    const cwd = cwdOf(line)
    if (cwd !== null && claudeProjectSlug(cwd) === projectDir && existsSync(cwd)) return cwd
  }
  return null
}

function cwdOf(line: string): string | null {
  if (!line.includes('"cwd"')) return null
  try {
    const record = JSON.parse(line) as { cwd?: unknown }
    return typeof record.cwd === 'string' && path.isAbsolute(record.cwd) ? record.cwd : null
  } catch {
    return null
  }
}
