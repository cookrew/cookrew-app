// The app half of the Chrome leak: a headless Chromium whose Electron parent
// died hard is still running, holding its profile and its renderers.
import { describe, expect, it } from 'vitest'
import { elapsedMs, HeadlessReaper, leakedHeadlessShells, lsofVerdict, orphanChromePids, reapOrphanChrome } from '../src/main/orphan-chrome'

const BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ROOT = '/Users/drej/Library/Application Support/cookrew/interactive-browser'

const ps = [
  `  201     1 ${BIN} --headless=new --user-data-dir=${ROOT}/card-a`,
  `  202     1 ${BIN} --type=renderer --user-data-dir=${ROOT}/card-a`,
  `  203  7000 ${BIN} --headless=new --user-data-dir=${ROOT}/card-b`,
  `  204     1 ${BIN} --headless=new --user-data-dir=/var/folders/T/cookrew-dom-probe-x`,
  `  205     1 /bin/sh -c "tail -f ${ROOT}/card-a/Log"`,
  ''
].join('\n')

describe('orphanChromePids — the app’s own leftovers', () => {
  it('takes the card’s browser and its helpers once the app is gone', () => {
    expect(orphanChromePids(ps, ROOT)).toEqual([201, 202])
  })

  it('leaves a Chromium whose app is running', () => {
    expect(orphanChromePids(ps, ROOT)).not.toContain(203)
  })

  it('is scoped to this app, so a test-launcher leftover is not touched', () => {
    expect(orphanChromePids(ps, ROOT)).not.toContain(204)
  })

  it('never kills a non-browser that merely names the profile', () => {
    expect(orphanChromePids(ps, ROOT)).not.toContain(205)
  })
})

describe('reapOrphanChrome — the boot sweep', () => {
  it('kills exactly the planned pids and reports them', () => {
    const killed: number[] = []
    const pids = reapOrphanChrome(ROOT, {
      ps: () => `  11     1 ${BIN} --user-data-dir=${ROOT}/a\n  12   500 ${BIN} --user-data-dir=${ROOT}/b\n`,
      kill: (pid) => killed.push(pid)
    })
    expect(pids).toEqual([11])
    expect(killed).toEqual([11])
  })

  it('boot never fails because ps did', () => {
    expect(
      reapOrphanChrome(ROOT, {
        ps: () => {
          throw new Error('no ps')
        },
        kill: () => {
          throw new Error('unreachable')
        }
      })
    ).toEqual([])
  })
})

// The other half, measured 2026-11-05: 13 Playwright headless shells left by
// agents' QA scripts, up to three days old, every one reparented to launchd,
// 3.1 GB of footprint in a machine already 20 GB over its RAM. Nothing owns
// them, so nothing stops them; the boot sweep above never sees them because
// they carry no profile of ours, and they outlive the app's restarts anyway.
describe('leakedHeadlessShells — browsers nobody is driving', () => {
  const SHELL = '/Users/me/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell'
  const HOUR = 3_600_000
  const rows = [
    `  301     1 03-05:28:48 ${SHELL} --no-sandbox --remote-debugging-port=9537 --user-data-dir=/tmp/fva`,
    `  302     1    16:51 ${SHELL} --remote-debugging-port=9377 --user-data-dir=/tmp/first-run-chrome`,
    `  303  7000 01-00:00:00 ${SHELL} --remote-debugging-port=9391`,
    `  304     1 01-00:00:00 ${SHELL} --type=renderer --remote-debugging-port=9483`,
    `  305     1 02:00:00 ${SHELL} --no-sandbox`,
    `  306     1 05:00:00 /bin/zsh -c "echo ${SHELL} --remote-debugging-port=9001"`,
    ''
  ].join('\n')

  it('reads ps elapsed time in all three of its shapes', () => {
    expect(elapsedMs('16:51')).toBe(16 * 60_000 + 51_000)
    expect(elapsedMs('02:00:00')).toBe(2 * HOUR)
    expect(elapsedMs('03-05:28:48')).toBe((3 * 24 + 5) * HOUR + 28 * 60_000 + 48_000)
    expect(elapsedMs('garbage')).toBeNull()
  })

  it('takes an old shell whose launcher is gone, and notes its debug port', () => {
    expect(leakedHeadlessShells(rows, 2 * HOUR)).toContainEqual({ pid: 301, port: 9537 })
  })

  it('leaves a young shell: an agent launches one detached and is still driving it', () => {
    expect(leakedHeadlessShells(rows, 2 * HOUR).map((l) => l.pid)).not.toContain(302)
  })

  it('leaves a shell whose launcher is alive', () => {
    expect(leakedHeadlessShells(rows, 2 * HOUR).map((l) => l.pid)).not.toContain(303)
  })

  it('a helper left behind has no browser to serve, so its port is nobody\'s', () => {
    expect(leakedHeadlessShells(rows, 2 * HOUR)).toContainEqual({ pid: 304, port: null })
  })

  it('a shell with no debug port has no one who could reach it', () => {
    expect(leakedHeadlessShells(rows, 2 * HOUR)).toContainEqual({ pid: 305, port: null })
  })

  it('is only ever the binary, never a command that mentions it', () => {
    expect(leakedHeadlessShells(rows, 2 * HOUR).map((l) => l.pid)).not.toContain(306)
  })

  it('asks about a port-0 shell by its process: the chosen port is not in its args', () => {
    const line = `  307     1 05:00:00 ${SHELL} --remote-debugging-port=0\n`
    expect(leakedHeadlessShells(line, 2 * HOUR)).toEqual([{ pid: 307, port: 0 }])
  })

  it('reads lsof honestly: exit 1 with an error is a failed look, not an empty answer', () => {
    expect(lsofVerdict({ code: 1, stderr: '' })).toBe(false)
    expect(() => lsofVerdict({ code: 1, stderr: 'lsof: unacceptable port specification' })).toThrow()
    expect(() => lsofVerdict({ code: 'ETIMEDOUT', stderr: '' })).toThrow()
  })
})

describe('HeadlessReaper — a browser must STAY clientless, across sweeps', () => {
  const SHELL = '/x/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell'
  const HOUR = 3_600_000
  const QUIET = HOUR
  const row = (pid: number, port: number) => `  ${pid}     1 05:00:00 ${SHELL} --remote-debugging-port=${port}\n`
  const reaper = (rows: string, hasClient: (leak: { pid: number; port: number | null }) => Promise<boolean>, killed: number[]) =>
    new HeadlessReaper(2 * HOUR, QUIET, { ps: async () => rows, hasClient, kill: (pid) => killed.push(pid) })

  it('one empty look proves nothing: a script connects, acts and closes', async () => {
    const killed: number[] = []
    const r = reaper(row(401, 9001), async () => false, killed)
    expect(await r.sweep(0)).toEqual([])
    expect(await r.sweep(QUIET - 1)).toEqual([])
    expect(killed).toEqual([])
  })

  it('stops it once it has been clientless for the whole quiet period', async () => {
    const killed: number[] = []
    const r = reaper(row(401, 9001), async () => false, killed)
    await r.sweep(0)
    expect(await r.sweep(QUIET)).toEqual([401])
    expect(killed).toEqual([401])
  })

  it('a client seen in between starts the quiet period over', async () => {
    const killed: number[] = []
    let client = false
    const r = reaper(row(401, 9001), async () => client, killed)
    await r.sweep(0)
    client = true
    await r.sweep(QUIET / 2)
    client = false
    await r.sweep(QUIET / 2 + 1)
    expect(await r.sweep(QUIET)).toEqual([])
    expect(await r.sweep(QUIET / 2 + 1 + QUIET)).toEqual([401])
  })

  it('a look that fails keeps it, and restarts nothing it cannot see: blindness is not absence', async () => {
    const killed: number[] = []
    const r = reaper(row(401, 9001), async () => { throw new Error('lsof failed') }, killed)
    await r.sweep(0)
    expect(await r.sweep(10 * QUIET)).toEqual([])
    expect(killed).toEqual([])
  })

  it('a helper with no browser goes at once: nobody can ever connect to it', async () => {
    const killed: number[] = []
    const r = reaper(`  402     1 05:00:00 ${SHELL} --type=renderer --remote-debugging-port=9483\n`, async () => true, killed)
    expect(await r.sweep(0)).toEqual([402])
  })

  it('a failed listing reaps nothing', async () => {
    const r = new HeadlessReaper(2 * HOUR, QUIET, { ps: async () => { throw new Error('ps failed') }, kill: () => { throw new Error('no') } })
    expect(await r.sweep(0)).toEqual([])
  })
})
