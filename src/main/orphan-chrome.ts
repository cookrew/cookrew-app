// CHROMIUM FROM A PREVIOUS APP INSTANCE, STILL RUNNING.
//
// `browserManager.shutdown()` stops every headless Chromium on `before-quit`,
// which covers a normal quit — not a crash, not SIGKILL, not the machine
// going down. A browser card's Chromium does not notice its Electron parent
// is gone; it reparents to launchd and keeps a renderer, a GPU process and
// its profile resident until someone notices (measured 2026-10-31: one such
// instance, and ten in total including the test launchers — ~3.6 GB).
//
// `reapOrphanBrowserProfiles` already deletes the DIRECTORIES of cards that no
// longer exist, but a running Chromium goes on holding the bytes it has open.
// So the processes go first, then the directories.
//
// The safety argument is the same one scripts/chrome-reaper.mjs makes: a live
// Chromium's parent is alive, so its ppid is not 1 — it is never a candidate.
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * A process is only ever a candidate when it IS a browser: the marker is a
 * profile path, and anything else that merely carries that string in its
 * arguments (a shell, a log tail) must never be killed.
 */
const CHROME_BINARY = /Contents\/MacOS\/(?:Google Chrome(?: Canary)?|Chromium)\b/

/** Pids of browser processes matching `marker` whose launcher is gone (ppid 1). */
export function orphanChromePids(psOutput: string, marker: string): number[] {
  const pids: number[] = []
  for (const line of psOutput.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) continue
    if (Number(match[2]) !== 1) continue
    if (!CHROME_BINARY.test(match[3])) continue
    if (!match[3].includes(marker)) continue
    pids.push(Number(match[1]))
  }
  return pids
}

export interface ReapDeps {
  ps?: () => string
  kill?: (pid: number) => void
}

/** Kill every orphaned browser carrying `marker`; returns the pids killed. */
export function reapOrphanChrome(marker: string, over: ReapDeps = {}): number[] {
  const readPs =
    over.ps ??
    (() => execFileSync('ps', ['-Aww', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 5000 }))
  const kill = over.kill ?? ((pid: number) => process.kill(pid, 'SIGKILL'))
  const killed: number[] = []
  let output: string
  try {
    output = String(readPs())
  } catch {
    return killed
  }
  for (const pid of orphanChromePids(output, marker)) {
    try {
      kill(pid)
      killed.push(pid)
    } catch {
      // gone between the listing and the kill
    }
  }
  return killed
}

// ---------------------------------------------------------------------------
// HEADLESS SHELLS NOBODY IS DRIVING.
//
// The sweep above is for this app's own browsers, once, at boot. Measured
// 2026-11-01 and again 2026-11-05: Playwright `chrome-headless-shell`s from
// agents' QA scripts, 13 of them, up to three days old, 3.1 GB, and on the 1st
// 23 of them at 240 % CPU. They carry no profile of ours, the app outlives no
// one's script, and a boot-only sweep would miss them anyway.
//
// ppid 1 alone proves nothing here: an agent launches one detached on purpose
// and drives it with short scripts that connect, act and close. So a leak is
// ppid 1 AND old AND clientless at every look for a whole quiet period, and a
// look that fails keeps the browser. A driver whose scripts always fall between
// the looks is the known limit: all it can lose is page state, after three hours.
// ---------------------------------------------------------------------------

const HEADLESS_SHELL_BINARY = /^\S*\/chrome-headless-shell(?:\s|$)/

/** `ps` etime, `[[dd-]hh:]mm:ss`, in milliseconds. */
export function elapsedMs(etime: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime)
  if (!match) return null
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0))
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000
}

export interface HeadlessLeak {
  pid: number
  /** Its debug port; null when no client could ever be attached to it. */
  port: number | null
}

/** From `ps -Aww -o pid=,ppid=,etime=,args=`: old shells with no parent. */
export function leakedHeadlessShells(psOutput: string, minAgeMs: number): HeadlessLeak[] {
  const leaks: HeadlessLeak[] = []
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match || Number(match[2]) !== 1 || !HEADLESS_SHELL_BINARY.test(match[4])) continue
    const age = elapsedMs(match[3])
    if (age === null || age < minAgeMs) continue
    // A helper at ppid 1 has lost its browser; the port in its args is a copy.
    const port = match[4].includes('--type=') ? null : /--remote-debugging-port=(\d+)/.exec(match[4])?.[1]
    leaks.push({ pid: Number(match[1]), port: port ? Number(port) : null })
  }
  return leaks
}

/**
 * What lsof's end means. It exits 1 both for "no such connection" and for an
 * error (a bad port spec), so only an exit 1 with nothing on stderr is an answer.
 */
export function lsofVerdict(failure: { code?: unknown; stderr?: unknown }): boolean {
  if (failure.code === 1 && String(failure.stderr ?? '').trim() === '') return false
  throw new Error(`lsof failed: ${String(failure.stderr ?? failure.code)}`)
}

/**
 * Asked by process as well as by port: port 0 means Chrome picked one, and it
 * is in no argument. Then any established connection counts, the awake side.
 */
async function headlessHasClient(leak: HeadlessLeak): Promise<boolean> {
  const tcp = leak.port ? `-iTCP:${leak.port}` : '-iTCP'
  try {
    const args = ['-nP', '-a', '-p', String(leak.pid), tcp, '-sTCP:ESTABLISHED', '-t']
    const { stdout } = await execFileAsync('lsof', args, { timeout: 10_000 })
    return stdout.trim() !== ''
  } catch (error) {
    return lsofVerdict(error as { code?: unknown; stderr?: unknown })
  }
}

export interface HeadlessReapDeps {
  ps?: () => Promise<string>
  hasClient?: (leak: HeadlessLeak) => Promise<boolean>
  kill?: (pid: number) => void
}

async function readHeadlessPs(): Promise<string> {
  const { stdout } = await execFileAsync('ps', ['-Aww', '-o', 'pid=,ppid=,etime=,args='], { maxBuffer: 32 * 1024 * 1024, timeout: 10_000 })
  return stdout
}

/**
 * One instance per app: the state is when each candidate was first seen with
 * no client. SIGKILL, not SIGTERM: on 2026-11-01 five `--single-process` shells
 * outlived TERM, and on 2026-11-05 four more did.
 */
export class HeadlessReaper {
  private readonly clientlessSince = new Map<number, number>()

  constructor(
    private readonly minAgeMs: number,
    private readonly quietMs: number,
    private readonly deps: HeadlessReapDeps = {}
  ) {}

  /** Returns the pids killed on this sweep. */
  async sweep(now: number): Promise<number[]> {
    let leaks: HeadlessLeak[]
    try {
      leaks = leakedHeadlessShells(await (this.deps.ps ?? readHeadlessPs)(), this.minAgeMs)
    } catch {
      return []
    }
    const candidates = new Set(leaks.map((leak) => leak.pid))
    for (const pid of [...this.clientlessSince.keys()]) if (!candidates.has(pid)) this.clientlessSince.delete(pid)
    const killed: number[] = []
    for (const leak of leaks) {
      if (await this.isDue(leak, now)) this.stop(leak.pid, killed)
    }
    return killed
  }

  private async isDue(leak: HeadlessLeak, now: number): Promise<boolean> {
    if (leak.port === null) return true
    try {
      if (await (this.deps.hasClient ?? headlessHasClient)(leak)) {
        this.clientlessSince.delete(leak.pid)
        return false
      }
    } catch {
      return false
    }
    const since = this.clientlessSince.get(leak.pid) ?? now
    this.clientlessSince.set(leak.pid, since)
    return now - since >= this.quietMs
  }

  private stop(pid: number, killed: number[]): void {
    try {
      ;(this.deps.kill ?? ((target: number) => process.kill(target, 'SIGKILL')))(pid)
      killed.push(pid)
    } catch {
      // Gone between the listing and the kill.
    }
    this.clientlessSince.delete(pid)
  }
}
