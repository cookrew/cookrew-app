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
// --fork takes a VALUE (path|id, per pi's CLI), so it stays a value flag —
// eating its token is correct, not a bug. Values may be QUOTED (a fork path
// can contain spaces), so the value pattern eats a quoted string whole;
// leaving `"my` behind and `id"` in the command would corrupt the rebuilt
// launch. `--flag=value` and `--flag value` forms are both covered.
const PI_VALUE_SESSION_FLAGS_RE =
  /\s+(?:--session(?:-id|-dir)?|--fork)(?:=(?:"[^"]*"|'[^']*'|\S*)|\s+(?!-)(?:"[^"]*"|'[^']*'|\S+))?/g
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
  timestamp?: string
}

export interface PiSessionMatch {
  id: string
  file: string
}

/** A session match plus the ordering/ownership facts read off its header. */
interface PiSessionEntry extends PiSessionMatch {
  mtimeMs: number
  /** Session start from the header timestamp; null when absent/unparsable. */
  startedAtMs: number | null
}

function piSessionEntries(
  cwd: string,
  options: { agentDir?: string; sessionsDir?: string } = {}
): PiSessionEntry[] {
  const dir = piSessionDir(cwd, options)
  if (!existsSync(dir)) return []
  const expectedCwd = realCwd(cwd)
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .flatMap((entry): PiSessionEntry[] => {
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
          const startedAtMs = header.timestamp ? Date.parse(header.timestamp) : NaN
          return [{
            id: header.id,
            file,
            mtimeMs: statSync(file).mtimeMs,
            startedAtMs: Number.isNaN(startedAtMs) ? null : startedAtMs
          }]
        } catch {
          return []
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return []
  }
}

function piSessions(
  cwd: string,
  options: { agentDir?: string; sessionsDir?: string } = {}
): PiSessionMatch[] {
  return piSessionEntries(cwd, options).map(({ id, file }) => ({ id, file }))
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

export interface PiSessionHome {
  /** The directory holding the session — exclusive, or pi's own cwd dir. */
  dir: string
  file: string
}

/**
 * Where a bound session ACTUALLY lives. Normally this terminal's exclusive
 * dir; for a session adopted from a legacy pane (see resolvePiSessionByPane)
 * it is pi's own cwd dir instead, and every path that acts on the binding —
 * resume, watch, trace, the recover EXACT-CONTEXT gate — has to agree on that
 * or they silently disagree about which conversation the node owns. Exact-id
 * lookup with the header cwd check, never a most-recent guess. Null = the id
 * resolves nowhere (rotated, deleted, or never real).
 */
export function piSessionHome(
  cwd: string,
  sessionId: string,
  terminalId: string,
  options: { sessionsRoot?: string; agentDir?: string } = {}
): PiSessionHome | null {
  const exclusive = piNodeSessionDir(terminalId, { rootDir: options.sessionsRoot })
  const owned = piSessionFile(cwd, sessionId, { sessionsDir: exclusive })
  if (owned) return { dir: exclusive, file: owned }
  const adopted = piSessionFile(cwd, sessionId, { agentDir: options.agentDir })
  return adopted ? { dir: piSessionDir(cwd, { agentDir: options.agentDir }), file: adopted } : null
}

/** Resolve one node's published-Pi CLI command without consulting other nodes. */
export function piLaunchBinding(options: {
  command: string
  cwd: string
  terminalId: string
  sessionsRoot?: string
  /** Session already bound to this node — it may live in pi's own cwd dir
   *  (adopted from a legacy pane), which is where it must resume. */
  storedSessionId?: string | null
  agentDir?: string
}): PiLaunchBinding {
  const sessionDir = piNodeSessionDir(options.terminalId, { rootDir: options.sessionsRoot })
  const session = latestPiSession(options.cwd, { sessionsDir: sessionDir })
  if (session) {
    return {
      command: piResumeCommand(options.command, session.id, sessionDir),
      sessionId: session.id,
      sessionDir
    }
  }
  // Nothing in the exclusive dir, but the node IS bound: its session was
  // adopted from a pane pi launched before the exclusive-dir wiring, so it
  // lives in pi's cwd-derived dir. Resume it THERE (exact id) — booting fresh
  // in the empty exclusive dir would strand the whole conversation.
  const adopted = options.storedSessionId
    ? piSessionHome(options.cwd, options.storedSessionId, options.terminalId, {
        sessionsRoot: options.sessionsRoot,
        agentDir: options.agentDir
      })
    : null
  if (adopted && options.storedSessionId) {
    return {
      command: piResumeCommand(options.command, options.storedSessionId, adopted.dir),
      sessionId: options.storedSessionId,
      sessionDir: adopted.dir
    }
  }
  return {
    command: piFreshCommand(options.command, sessionDir),
    sessionId: null,
    sessionDir
  }
}

/**
 * How long AFTER its pane started a Pi session may open and still be adopted
 * as that pane's own. Deliberately tight: pi writes its session header within
 * a second or two of launch, and every extra second widens the band in which
 * a second pi in the same directory could be mistaken for ours.
 */
export const PI_PANE_WINDOW_MS = 30_000

const PI_SESSION_DIR_VALUE_RE =
  /--session-dir(?:=|\s+)("[^"]*"|'[^']*'|(?:\\.|[^\s"'])+)/g

/**
 * The session directory a LIVE pane was actually launched with, read off its
 * recorded start command — the only honest answer for a tmux session that
 * `new-session -A` reattached, whose running pi predates (and ignores) the
 * command Cookrew would build today. Null when the launch declared none.
 */
export function piSessionDirFromCommand(command: string): string | null {
  // LAST occurrence: Cookrew appends its own --session-dir after whatever the
  // preset command carried, and the last flag is the one pi obeys.
  const matches = [...command.matchAll(PI_SESSION_DIR_VALUE_RE)]
  const match = matches[matches.length - 1]
  if (!match) return null
  const raw = match[1]
  const value =
    (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1)
      : raw.replace(/\\(.)/g, '$1')
  return value ? path.resolve(resolveHome(value)) : null
}

export interface PiPaneBindOptions {
  cwd: string
  terminalId: string
  /** The command tmux launched the live pane with, or null when unknown. */
  command: string | null
  /** Epoch ms the pane started (tmux session_created), or null when unknown. */
  paneStartedAtMs: number | null
  /** Session ids already claimed by OTHER terminals — never reassignable. */
  exclude?: ReadonlySet<string>
  sessionsRoot?: string
  agentDir?: string
}

function match(entry: PiSessionEntry | undefined): PiSessionMatch | null {
  return entry ? { id: entry.id, file: entry.file } : null
}

/**
 * The session a live Pi pane is really writing to.
 *
 * Panes Cookrew launched declare an exclusive `--session-dir`, so everything
 * inside it is theirs. A LEGACY pane — created before that wiring and kept
 * alive across restarts by `new-session -A`, or started by hand — writes to
 * pi's shared cwd-derived dir instead, and scanning only the exclusive dir is
 * why such a node never bound (its rail fell back to PTY scrapes reading
 * '(recovered turn)'). Adopting from the shared dir stays deterministic: the
 * session's own start timestamp must fall inside the pane's start window, so
 * a pi the user runs elsewhere in the same cwd is never stolen. No pane start
 * time = no proof, so no adoption (EXACT-CONTEXT gate: never an mtime guess).
 */
export function resolvePiSessionByPane(options: PiPaneBindOptions): PiSessionMatch | null {
  const exclusiveDir = piNodeSessionDir(options.terminalId, { rootDir: options.sessionsRoot })
  const declared = options.command === null ? null : piSessionDirFromCommand(options.command)
  const dir =
    declared ??
    (options.command === null
      ? exclusiveDir
      : piSessionDir(options.cwd, { agentDir: options.agentDir }))
  const entries = piSessionEntries(options.cwd, { sessionsDir: dir }).filter(
    (entry) => !options.exclude?.has(entry.id)
  )
  // This terminal's exclusive dir holds nothing but this terminal's sessions,
  // so its most recently active one is ours by construction (pi's --continue
  // rule). Every OTHER directory — pi's shared cwd tree, or a path someone
  // hand-launched the pane with — can hold other agents' work and needs proof.
  if (path.resolve(dir) === path.resolve(exclusiveDir)) return match(entries[0])
  const paneStartedAtMs = options.paneStartedAtMs
  if (paneStartedAtMs === null) return null
  // Proof, in order of strength: a session pi opened for THIS pane cannot
  // predate the pane (so the window is forward-only — a session already
  // running when the pane booted is somebody else's, e.g. a pi the user
  // started by hand), must open promptly after it, and among survivors the
  // one that opened NEAREST the pane start wins. Picking by mtime instead
  // would hand a quiet pane's session to whichever agent typed most recently.
  const candidates = entries.filter(
    (entry) =>
      entry.startedAtMs !== null &&
      entry.startedAtMs >= paneStartedAtMs &&
      entry.startedAtMs - paneStartedAtMs <= PI_PANE_WINDOW_MS
  )
  return match(
    candidates.reduce<PiSessionEntry | undefined>(
      (best, entry) =>
        best === undefined || (entry.startedAtMs as number) < (best.startedAtMs as number)
          ? entry
          : best,
      undefined
    )
  )
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
  options: { piSessionsRoot?: string; piAgentDir?: string } = {}
): string | null {
  if (!node.piSessionId) return null
  // Exclusive dir, or the legacy pane's own cwd dir when the session was
  // adopted from one (piSessionHome keeps every consumer on the same answer).
  return (
    piSessionHome(node.cwd, node.piSessionId, node.id, {
      sessionsRoot: options.piSessionsRoot,
      agentDir: options.piAgentDir
    })?.file ?? null
  )
}
