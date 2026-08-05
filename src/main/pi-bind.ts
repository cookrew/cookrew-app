// Pi harness session integration.
//
// Pi can resume a session by id (`--session`) and scope all session lookup and
// creation to a caller-chosen directory (`--session-dir`). Cookrew gives every
// terminal its own directory, so the real Pi-generated id can be discovered
// without the mtime/lsof cross-agent races needed by shared session trees.

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { shellQuotePath } from '../shared/attach'

const PI_SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/
const PI_VALUE_SESSION_FLAGS_RE = /\s+(?:--session(?:-id|-dir)?|--fork)(?:=\S*|\s+(?!-)\S+)?/g
const PI_SWITCH_SESSION_FLAGS_RE = /\s+(?:--continue|--resume|--no-session|-c|-r)(?=\s|$)/g

export function isPiCommand(command: string): boolean {
  return /^\s*pi(?=\s|$)/.test(command)
}

export function validPiSessionId(value: string): boolean {
  return PI_SESSION_ID_RE.test(value)
}

/** Remove every Pi flag that could select, create, or fork another session. */
export function stripPiSessionFlags(command: string): string {
  return command
    .replace(PI_VALUE_SESSION_FLAGS_RE, '')
    .replace(PI_SWITCH_SESSION_FLAGS_RE, '')
    .trim()
}

function sessionDirFlag(sessionDir: string): string {
  return `--session-dir ${shellQuotePath(path.resolve(resolveHome(sessionDir)))}`
}

/** A fresh Pi session inside this terminal's exclusive session directory. */
export function piFreshCommand(command: string, sessionDir: string): string {
  return `${stripPiSessionFlags(command)} ${sessionDirFlag(sessionDir)}`
}

export function piResumeCommand(command: string, sessionId: string, sessionDir?: string): string {
  if (!validPiSessionId(sessionId)) throw new Error('Invalid Pi session id')
  const dir = sessionDir ? ` ${sessionDirFlag(sessionDir)}` : ''
  return `${stripPiSessionFlags(command)} --session ${sessionId}${dir}`
}

function resolveHome(value: string): string {
  return value === '~' ? homedir() : value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value
}

function realCwd(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    return path.resolve(cwd)
  }
}

/** Pi's exact cwd-to-session-directory encoding. */
export function piSessionDir(
  cwd: string,
  options: { agentDir?: string; sessionsDir?: string } = {}
): string {
  const configuredSessions = options.sessionsDir ?? process.env.PI_CODING_AGENT_SESSION_DIR
  if (configuredSessions) return path.resolve(resolveHome(configuredSessions))
  const configuredAgent = options.agentDir ?? process.env.PI_CODING_AGENT_DIR
  const agentDir = path.resolve(resolveHome(configuredAgent ?? path.join(homedir(), '.pi', 'agent')))
  const safeCwd = `--${realCwd(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return path.join(agentDir, 'sessions', safeCwd)
}

/** Cookrew's exclusive Pi session directory for one terminal node. */
export function piNodeSessionDir(
  terminalId: string,
  options: { rootDir?: string } = {}
): string {
  const root = path.resolve(resolveHome(options.rootDir ?? path.join(homedir(), '.cookrew', 'pi-sessions')))
  const key = createHash('sha256').update(terminalId).digest('hex')
  return path.join(root, key)
}

interface PiSessionHeader {
  type?: string
  id?: string
  cwd?: string
}

export interface PiSessionMatch {
  id: string
  file: string
}

function piSessions(
  cwd: string,
  options: { agentDir?: string; sessionsDir?: string } = {}
): PiSessionMatch[] {
  const dir = piSessionDir(cwd, options)
  if (!existsSync(dir)) return []
  const expectedCwd = realCwd(cwd)
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .flatMap((entry): Array<PiSessionMatch & { mtimeMs: number }> => {
        try {
          const file = path.join(dir, entry.name)
          const header = readHeader(file)
          if (
            header?.type !== 'session' ||
            typeof header.id !== 'string' ||
            !validPiSessionId(header.id) ||
            !entry.name.endsWith(`_${header.id}.jsonl`) ||
            typeof header.cwd !== 'string' ||
            realCwd(header.cwd) !== expectedCwd
          ) return []
          return [{ id: header.id, file, mtimeMs: statSync(file).mtimeMs }]
        } catch {
          return []
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map(({ id, file }) => ({ id, file }))
  } catch {
    return []
  }
}

/** Most recently active valid session in a directory (Pi's --continue rule). */
export function latestPiSession(
  cwd: string,
  options: { agentDir?: string; sessionsDir?: string } = {}
): PiSessionMatch | null {
  return piSessions(cwd, options)[0] ?? null
}

export interface PiLaunchBinding {
  command: string
  sessionId: string | null
  sessionDir: string
}

/** Resolve one node's published-Pi CLI command without consulting other nodes. */
export function piLaunchBinding(options: {
  command: string
  cwd: string
  terminalId: string
  sessionsRoot?: string
}): PiLaunchBinding {
  const sessionDir = piNodeSessionDir(options.terminalId, { rootDir: options.sessionsRoot })
  const session = latestPiSession(options.cwd, { sessionsDir: sessionDir })
  return {
    command: session
      ? piResumeCommand(options.command, session.id, sessionDir)
      : piFreshCommand(options.command, sessionDir),
    sessionId: session?.id ?? null,
    sessionDir
  }
}

function readHeader(file: string): PiSessionHeader | null {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(4096)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    const first = buffer.subarray(0, bytes).toString('utf8').split('\n', 1)[0]
    const parsed: unknown = JSON.parse(first)
    return typeof parsed === 'object' && parsed !== null ? parsed as PiSessionHeader : null
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** Locate the exact cwd-scoped Pi session file for a persisted session id. */
export function piSessionFile(
  cwd: string,
  sessionId: string,
  options: { agentDir?: string; sessionsDir?: string } = {}
): string | null {
  if (!validPiSessionId(sessionId)) return null
  return piSessions(cwd, options).find((match) => match.id === sessionId)?.file ?? null
}

/** Session file to poll for durable turn history (SessionTurnSync), inside
 *  this terminal's exclusive session directory. */
export function piWatchFile(
  node: { id: string; cwd: string; piSessionId?: string | null },
  options: { piSessionsRoot?: string } = {}
): string | null {
  if (!node.piSessionId) return null
  const sessionsDir = piNodeSessionDir(node.id, { rootDir: options.piSessionsRoot })
  return piSessionFile(node.cwd, node.piSessionId, { sessionsDir })
}
