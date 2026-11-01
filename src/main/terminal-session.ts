import { execFile } from 'node:child_process'

/**
 * TERMINALS FROM AN EARLIER LOGIN (owner, 2026-11-01).
 *
 * Every Cookrew terminal is a child of the detached herdr server, which
 * outlives Cookrew on purpose (herdr-host-multiplexer.ts · spawnHerdrServer) —
 * and so can outlive the macOS login it was started in. After a logout, or a
 * WindowServer crash, its panes sit in that login's dead Mach bootstrap
 * namespace: nothing reaches launchd's services, so no host name resolves
 * (curl, aws, npm: "could not resolve host"), launchctl answers 141 and `open`
 * fails, while the same command works in a terminal opened since. Measured:
 * aws_mfa_refresh said "No MFA device found" in Cookrew and worked in iTerm.
 *
 * It cannot be repaired from inside: a pane cannot join the new login. The fix
 * is restarting herdr in this login, which closes every terminal — the owner's
 * call. This only finds it out, so the app can say so: the server started
 * before this login's loginwindow.
 */

export interface PsRow {
  pid: number
  ppid: number
  uid: number
  startedAt: number
  args: string
}

export interface TerminalSession {
  /** The herdr server predates this login: its terminals cannot resolve names or open apps. */
  stale: boolean
  serverPid: number | null
  serverStartedAt: number | null
  loginAt: number | null
}

/** The ps line this reads: `ps -axo pid=,ppid=,uid=,lstart=,args=`. */
export const PS_ARGS = ['-axo', 'pid=,ppid=,uid=,lstart=,args=']

/** One row per process; lstart is five words ("Sun Nov  1 13:30:29 2026"), local time. */
export function parsePs(out: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of out.split('\n')) {
    const words = line.trim().split(/\s+/)
    if (words.length < 9) continue
    const [pid, ppid, uid] = words.slice(0, 3).map(Number)
    const startedAt = Date.parse(words.slice(3, 8).join(' '))
    if (![pid, ppid, uid, startedAt].every(Number.isFinite)) continue
    const args = line.trim().replace(/^(\S+\s+){8}/, '')
    rows.push({ pid, ppid, uid, startedAt, args })
  }
  return rows
}

/** The detached server (`herdr server`, parent launchd), not herdr's attach clients. */
const HERDR_SERVER = /(?:^|\/)herdr server$/
const LOGINWINDOW = /\/loginwindow\.app\//

export function terminalSessionOf(rows: readonly PsRow[], uid: number): TerminalSession {
  const mine = rows.filter((row) => row.uid === uid)
  const server = mine.filter((row) => row.ppid === 1 && HERDR_SERVER.test(row.args)).sort((a, b) => a.startedAt - b.startedAt)[0] ?? null
  // This login is the user's newest loginwindow.
  const login = mine.filter((row) => LOGINWINDOW.test(row.args)).sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
  return {
    stale: server !== null && login !== null && server.startedAt < login.startedAt,
    serverPid: server?.pid ?? null,
    serverStartedAt: server?.startedAt ?? null,
    loginAt: login?.startedAt ?? null
  }
}

/** Read at most once a minute: one ps, never on a hot path. */
const CACHE_MS = 60_000
let cached: { at: number; value: Promise<TerminalSession> } | null = null

export function readTerminalSession(now = Date.now()): Promise<TerminalSession> {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') {
    return Promise.resolve({ stale: false, serverPid: null, serverStartedAt: null, loginAt: null })
  }
  if (cached && now - cached.at < CACHE_MS) return cached.value
  const uid = process.getuid()
  const value = new Promise<TerminalSession>((resolve) => {
    execFile('/bin/ps', PS_ARGS, { maxBuffer: 8 * 1024 * 1024, timeout: 5000 }, (error, stdout) => {
      // A failed read says nothing is wrong rather than guessing that something is.
      resolve(error ? { stale: false, serverPid: null, serverStartedAt: null, loginAt: null } : terminalSessionOf(parsePs(stdout), uid))
    })
  })
  cached = { at: now, value }
  return value
}
