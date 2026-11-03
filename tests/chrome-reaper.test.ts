// The Chrome leak, pinned.
//
// 2026-10-31: ten orphaned headless Chromes (~3.6 GB on a 16 GB Mac, swap at
// 22.9 GB) — nine from `launchChrome` in scripts/perf-dom-probe.mjs, one from
// the app's own browser cards. The launcher's `kill()` lives in a `finally`,
// which never runs when the vitest worker is killed; Chrome then reparents to
// launchd and runs until someone notices.
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { guardChromeWithParent, orphanChromePids, reapOrphans } from '../scripts/chrome-reaper.mjs'

const BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (check: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

describe('orphanChromePids — who is a leftover', () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const ps = [
    `  101     1 ${chrome} --headless=new --user-data-dir=/var/folders/x/T/cookrew-dom-probe-AAA`,
    `  102   101 ${chrome} --type=renderer --user-data-dir=/var/folders/x/T/cookrew-dom-probe-AAA`,
    `  103  9000 ${chrome} --headless=new --user-data-dir=/var/folders/x/T/cookrew-dom-probe-BBB`,
    `  104     1 ${chrome} --headless=new --user-data-dir=/Users/drej/Library/Application Support/cookrew/interactive-browser/n1`,
    `  105     1 /usr/bin/sleep 30 cookrew-dom-probe-not-chrome`,
    `  106     1 ${chrome} --type=renderer --user-data-dir=/var/folders/x/T/cookrew-dom-probe-AAA`,
    ''
  ].join('\n')

  it('takes every reparented Chrome carrying the marker, helpers included', () => {
    expect(orphanChromePids(ps, 'cookrew-dom-probe-')).toEqual([101, 106])
  })

  it('never kills a process that is not a browser, marker or not', () => {
    expect(orphanChromePids(ps, 'cookrew-dom-probe-')).not.toContain(105)
  })

  it('leaves a Chrome whose launcher is alive', () => {
    expect(orphanChromePids(ps, 'cookrew-dom-probe-')).not.toContain(103)
  })

  it('is scoped by marker, so the probe sweep never touches the app’s cards', () => {
    expect(orphanChromePids(ps, 'interactive-browser')).toEqual([104])
  })

  it('ignores anything that is not a process line', () => {
    expect(orphanChromePids('garbage\n\n  x y z\n', 'cookrew-dom-probe-')).toEqual([])
  })
})

describe('reapOrphans — the sweep at launch', () => {
  it('kills exactly the planned pids', () => {
    const killed: number[] = []
    const pids = reapOrphans('cookrew-dom-probe-', {
      ps: () => `  11     1 ${BIN} --user-data-dir=/t/cookrew-dom-probe-a\n  12  500 ${BIN} --user-data-dir=/t/cookrew-dom-probe-b\n`,
      kill: (pid: number) => killed.push(pid)
    })
    expect(pids).toEqual([11])
    expect(killed).toEqual([11])
  })

  it('survives a process gone between the listing and the kill', () => {
    const pids = reapOrphans('m', {
      ps: () => `  11     1 ${BIN} --user-data-dir=/t/m\n`,
      kill: () => {
        throw new Error('ESRCH')
      }
    })
    expect(pids).toEqual([])
  })

  it('says nothing and does nothing when ps fails', () => {
    const killed: number[] = []
    const pids = reapOrphans('m', {
      ps: () => {
        throw new Error('no ps')
      },
      kill: (pid: number) => killed.push(pid)
    })
    expect(pids).toEqual([])
    expect(killed).toEqual([])
  })
})

describe('guardChromeWithParent — the Chrome dies with its launcher', () => {
  it('kills the child once the parent disappears', async () => {
    const parent = spawn('sleep', ['60'], { stdio: 'ignore' })
    const child = spawn('sleep', ['60'], { stdio: 'ignore' })
    try {
      guardChromeWithParent({ childPid: child.pid as number, parentPid: parent.pid as number, pollMs: 100 })
      expect(alive(child.pid as number)).toBe(true)
      parent.kill('SIGKILL')
      expect(await waitFor(() => !alive(child.pid as number), 5000)).toBe(true)
    } finally {
      if (alive(child.pid as number)) child.kill('SIGKILL')
      if (alive(parent.pid as number)) parent.kill('SIGKILL')
    }
  }, 10_000)

  it('leaves the child alone while the parent lives', async () => {
    const parent = spawn('sleep', ['60'], { stdio: 'ignore' })
    const child = spawn('sleep', ['60'], { stdio: 'ignore' })
    try {
      guardChromeWithParent({ childPid: child.pid as number, parentPid: parent.pid as number, pollMs: 100 })
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(alive(child.pid as number)).toBe(true)
    } finally {
      child.kill('SIGKILL')
      parent.kill('SIGKILL')
    }
  }, 10_000)
})
