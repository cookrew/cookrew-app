// DEVIN CLI SESSION INTEGRATION (harness expansion P3).
//
// Facts read off Devin 3000.14.30821 on this machine (2026-11-26/27; captures
// in ~/.cookrew/captures/2026-11-26/devin):
//  - A session is a lowercase word slug (`wary-seeker`). With
//    `session_store: "files"` it lives in <data>/sessions/<slug>/{log.jsonl,
//    meta.json}, <data> = ~/.local/share/devin/cli ($XDG_DATA_HOME moves it;
//    DEVIN_SESSIONS_DIR was ignored). The default store is SQLite
//    (sessions.db), which nothing can tail, so a card runs on its own config
//    that names the files store.
//  - `--process-model in-process` keeps the agent in the card's own process
//    tree: the default runs every session in one shared daemon, and the lock
//    would sit in a process no pane owns. The agent worker (a CHILD of the
//    pane's process) then holds <data>/session_locks/<slug>.lock — the
//    deterministic bind (contract rule 3). The lock exists from boot, the
//    session's files from its first prompt; a card binds to the second.
//  - `-r <slug>` resumes from any folder (measured: it appended to the same
//    log and noted the new folder), so a card's folder never strands it.
//  - Devin reads ~/.claude/settings.json hooks and ~/.claude/CLAUDE.md unless
//    `read_config_from.claude` is false: Cookrew's Claude hooks would run in a
//    Devin pane. The card's config turns it off.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from './atomic-file'
import { realCwd } from './claude-fork'
import { defaultOpenFiles, type OpenFilesReader } from './codex-bind'
import { shellQuote } from './shell-quote'

const SESSION_RE = /^[a-z0-9]+(?:-[a-z0-9]+){0,7}$/
const TERMINAL_RE = /^[A-Za-z0-9-]{1,64}$/

export function defaultDevinDataDir(): string {
  return path.join(process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share'), 'devin', 'cli')
}

/** The person's own Devin config, merged under every card's. */
export function defaultDevinUserConfig(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'devin', 'config.json')
}

/** A session id in Devin's closed alphabet: the check before it reaches a path or a shell line. */
export function validDevinSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && SESSION_RE.test(value)
}

export function devinLogFile(id: string, dataDir = defaultDevinDataDir()): string {
  return path.join(dataDir, 'sessions', id, 'log.jsonl')
}

/** The session a log path belongs to, or undefined for any other path. */
export function devinSessionOfFile(file: string): string | undefined {
  const parts = file.split(path.sep)
  const at = parts.lastIndexOf('sessions')
  const id = at >= 0 && parts[at + 2] === 'log.jsonl' ? parts[at + 1] : undefined
  return validDevinSessionId(id) ? id : undefined
}

/** A session that has had its first prompt: its meta file is written then. */
export function devinSessionExists(id: string, dataDir = defaultDevinDataDir()): boolean {
  return validDevinSessionId(id) && existsSync(path.join(dataDir, 'sessions', id, 'meta.json'))
}

/** The session whose lock is among these open files, or null. Data dir as written and as resolved (lsof prints the second). */
export function devinSessionFromOpenFiles(files: readonly string[], dataDir = defaultDevinDataDir()): string | null {
  const locks = [...new Set([dataDir, realCwd(dataDir)])].map((dir) => path.join(dir, 'session_locks') + path.sep)
  for (const file of files) {
    if (!locks.some((dir) => file.startsWith(dir)) || !file.endsWith('.lock')) continue
    const id = path.basename(file, '.lock')
    if (validDevinSessionId(id)) return id
  }
  return null
}

export type ChildPids = (pid: number) => number[]

const defaultChildPids: ChildPids = (pid) => {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 })
      .toString('utf8')
      .split('\n')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    // pgrep exits 1 when a process has no children.
    return []
  }
}

/** The pane's process and its descendants, nearest first, a few levels deep. */
export function processTree(pid: number, children: ChildPids = defaultChildPids, depth = 3): number[] {
  const out = [pid]
  let level = [pid]
  for (let d = 0; d < depth && level.length > 0; d += 1) {
    level = level.flatMap((p) => children(p)).filter((p) => !out.includes(p))
    out.push(...level)
  }
  return out
}

/** The session the Devin under `pid` holds, once it has had its first prompt; else null. */
export function resolveDevinSessionByPid(
  pid: number | null,
  readOpenFiles: OpenFilesReader = defaultOpenFiles,
  children: ChildPids = defaultChildPids,
  dataDir = defaultDevinDataDir()
): string | null {
  if (pid === null || !Number.isFinite(pid) || pid <= 0) return null
  for (const p of processTree(pid, children)) {
    const id = devinSessionFromOpenFiles(readOpenFiles(p), dataDir)
    if (id) return devinSessionExists(id, dataDir) ? id : null
  }
  return null
}

/** The log SessionTurnSync polls for a bound card, or null. */
export function devinWatchFile(node: { devinSessionId?: string | null }, options: { devinDataDir?: string } = {}): string | null {
  const id = node.devinSessionId
  return validDevinSessionId(id) ? devinLogFile(id, options.devinDataDir) : null
}

const VALUE_FLAGS_RE = /\s+(?:--config|--process-model|--respect-workspace-trust|--export)(?:=(?:"[^"]*"|'[^']*'|\S*)|\s+(?!-)(?:"[^"]*"|'[^']*'|\S+))/g
const RESUME_RE = /\s+(?:-r|--resume)(?:=\S+|\s+(?!-)\S+)?(?=\s|$)/g
const CONTINUE_RE = /\s+(?:--continue|-c)(?=\s|$)/g

/** The line with every session binding removed: which session, and the card settings each spawn adds. */
export function stripDevinSessionFlags(command: string): string {
  return command.replace(VALUE_FLAGS_RE, '').replace(RESUME_RE, '').replace(CONTINUE_RE, '').trim()
}

export function devinResumeCommand(command: string, id: string): string {
  return `${stripDevinSessionFlags(command)} -r ${id}`
}

export function devinCardConfigFile(terminalId: string, home = homedir()): string {
  return path.join(home, '.cookrew', 'harness', 'devin', `${terminalId}.json`)
}

const readObject = (file: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * The card's Devin config: what Devin itself wrote into it before (its org,
 * its setup answers), the person's own config over that, and the two keys
 * Cookrew needs over everything. Devin writes back into the file it was
 * given, so the card keeps its own.
 */
export function devinCardConfig(card: Record<string, unknown>, user: Record<string, unknown>): Record<string, unknown> {
  const from = (o: Record<string, unknown>): Record<string, unknown> =>
    typeof o.read_config_from === 'object' && o.read_config_from !== null ? (o.read_config_from as Record<string, unknown>) : {}
  return { ...card, ...user, read_config_from: { ...from(card), ...from(user), claude: false }, session_store: 'files' }
}

export interface DevinLaunchOptions {
  userConfig?: string
  home?: string
}

/**
 * The line a Devin card boots: its own config (written now), the agent in the
 * card's process tree, and the folder trusted by the card being opened there.
 * A line that names its own --config keeps it; Cookrew's flags still go on.
 */
export function devinSessionLine(command: string, terminalId: string, options: DevinLaunchOptions = {}): string {
  const extra: string[] = []
  if (!/\s--config(?:[=\s]|$)/.test(command) && TERMINAL_RE.test(terminalId)) {
    const file = devinCardConfigFile(terminalId, options.home)
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      const config = devinCardConfig(readObject(file), readObject(options.userConfig ?? defaultDevinUserConfig()))
      writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`)
      extra.push('--config', shellQuote(file))
    } catch (error) {
      console.error('Devin card config could not be written:', error)
    }
  }
  if (!/\s--process-model(?:[=\s]|$)/.test(command)) extra.push('--process-model', 'in-process')
  if (!/\s--respect-workspace-trust(?:[=\s]|$)/.test(command)) extra.push('--respect-workspace-trust', 'false')
  return extra.length > 0 ? `${command} ${extra.join(' ')}` : command
}

/**
 * Did a Devin session start after the bound one? A new lock is the hint that
 * a card may have moved (/clear, /resume): only then is its process looked up.
 */
export function devinNewerLock(bound: string, dataDir = defaultDevinDataDir()): boolean {
  const dir = path.join(dataDir, 'session_locks')
  try {
    const since = statSync(path.join(dir, `${bound}.lock`)).mtimeMs
    return readdirSync(dir).some((name) => name.endsWith('.lock') && name !== `${bound}.lock` && !name.startsWith('__') && statSync(path.join(dir, name)).mtimeMs > since)
  } catch {
    return false
  }
}
