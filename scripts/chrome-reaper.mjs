// A HEADLESS CHROME MUST NEVER OUTLIVE THE TEST THAT OPENED IT.
//
// Measured on the owner's Mac 2026-10-31: ten orphaned headless Chrome
// instances, ~3.6 GB, the oldest 37 hours old, every one of them reparented
// to launchd. Nine carried a `cookrew-dom-probe-*` profile — the launchers
// below — and one carried the app's own `interactive-browser` profile from an
// app that had died hard. Chrome does not notice its parent is gone; the only
// thing that ever killed it was `kill()` in a `finally` block, which never
// runs when the vitest worker is killed on timeout.
//
// Two guards, because one is not enough:
//   - guardChromeWithParent: a detached `sh` watches BOTH pids and kills the
//     Chrome the moment the launching process vanishes. This covers the kill
//     path (worker timeout, Ctrl-C, crash).
//   - reapOrphans: at launch, anything already orphaned (ppid 1) whose profile
//     carries our marker is killed. This covers what leaked before the guards
//     existed, and anything that slips past them.
//
// A live Chrome is never a candidate: its parent is alive, so its ppid is not
// 1. That is the whole safety argument for the sweep.
import { execFileSync, spawn } from 'node:child_process'

/**
 * A process is only ever a candidate when it IS a browser: the marker is a
 * profile path, and anything else carrying that string in its arguments (a
 * shell, a log tail) must never be killed.
 */
const CHROME_BINARY = /Contents\/MacOS\/(?:Google Chrome(?: Canary)?|Chromium)\b/

/**
 * Pids of Chrome processes that match `marker` in their command line AND have
 * been reparented to init — i.e. their launcher is gone.
 *
 * Input is `ps -Aww -o pid=,ppid=,args=` output. -ww is belt-and-braces: through
 * a pipe macOS already prints the whole command line, but a tty truncates it to
 * the window, and the marker (a profile path) sits at the END of the arguments. Every matching pid is returned,
 * helpers included: if the browser process is already gone a stale helper is
 * still worth killing, and killing helpers while the browser lives does no
 * harm because the browser exits with them.
 */
export function orphanChromePids(psOutput, marker) {
  const pids = []
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

/**
 * Kill every orphaned Chrome carrying `marker`; returns the pids killed.
 * `ps` and `kill` are injectable so the planning half is unit-testable
 * without a process table.
 */
export function reapOrphans(marker, over = {}) {
  const readPs =
    over.ps ??
    (() =>
      execFileSync('ps', ['-Aww', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 5000 }))
  const kill = over.kill ?? ((pid) => process.kill(pid, 'SIGKILL'))
  const killed = []
  let output
  try {
    output = readPs()
  } catch {
    return killed
  }
  for (const pid of orphanChromePids(String(output), marker)) {
    try {
      kill(pid)
      killed.push(pid)
    } catch {
      // gone between the listing and the kill
    }
  }
  return killed
}

/**
 * Tie a Chrome's lifetime to its launcher's.
 *
 * The watcher is a detached shell, so it is reparented to launchd when the
 * launcher dies and keeps running — which is exactly the case it exists for.
 * It also exits on its own once the Chrome is gone, so a normal `kill()` needs
 * no cleanup; `stop()` is there for a launcher that wants it now.
 */
export function guardChromeWithParent({ childPid, parentPid = process.pid, pollMs = 1000 }) {
  if (!childPid) return { stop() {} }
  const seconds = Math.max(1, Math.round(pollMs / 1000))
  const script =
    `while kill -0 ${parentPid} 2>/dev/null && kill -0 ${childPid} 2>/dev/null; ` +
    `do sleep ${seconds}; done; kill -9 ${childPid} 2>/dev/null; true`
  const guard = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' })
  guard.unref()
  return {
    stop() {
      try {
        guard.kill()
      } catch {
        // already exited with its child
      }
    }
  }
}
