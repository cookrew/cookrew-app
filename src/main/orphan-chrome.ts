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
import { execFileSync } from 'node:child_process'

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
