// "AGENTS KEEP RUNNING" IS A CLAIM ON A BUTTON, SO IT IS PROVED AND NOT ASSUMED.
//
// Restart Cookrew tells the owner their agents live through it. This takes the
// real herdr and tmux binaries, starts a pane the way the app does from a
// stand-in process, kills that process, and watches the pane go on working.
// The direct backend (and so every served session) is the case where the claim
// is false: there the pane is the app's own child.
//
// Opt-in: COOKREW_REAL_MUX_TEST=1. It must never touch the fleet, so every
// call runs under `env -i` with a private HOME: the socket a stray `server
// stop` could reach is inside that HOME and nowhere else (the trap in
// memory: an inherited HERDR_SOCKET_PATH outranks the session name).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const run = process.env.COOKREW_REAL_MUX_TEST === '1'
const HERDR = path.join(process.env.HOME ?? '', '.local/bin/herdr')
const TMUX = '/opt/homebrew/bin/tmux'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const beatLoop = (file: string): string => `while :; do date +%s > ${file}; sleep 1; done`

/** The app, as far as the panes are concerned: a process that starts them and then dies. */
function standIn(script: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, ['-e', script], { env, stdio: 'ignore' })
}

async function until<T>(what: string, read: () => T | null, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(200)
  }
}

const beatOf = (file: string): number | null => {
  if (!existsSync(file)) return null
  const beat = Number(readFileSync(file, 'utf8').trim())
  return Number.isFinite(beat) && beat > 0 ? beat : null
}

const killAndWait = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    child.once('exit', () => resolve())
    child.kill('SIGKILL')
  })

describe.skipIf(!run)('a restart leaves the agents running (real binaries)', () => {
  let home = ''
  const herdrEnv = (): NodeJS.ProcessEnv => ({ HOME: home, PATH: '/usr/bin:/bin', HERDR_SESSION: 'rdproof', TERM: 'xterm' })
  const herdr = (...args: string[]): string => execFileSync(HERDR, args, { env: herdrEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const tmuxLabel = `rdproof-${process.pid}`
  const tmux = (...args: string[]): string => execFileSync(TMUX, ['-L', tmuxLabel, '-f', '/dev/null', ...args], { env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'xterm' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  beforeAll(() => {
    // Short on purpose: a Unix socket's path has about a hundred bytes.
    home = mkdtempSync('/tmp/rdp-')
    // The guard: a socket under this HOME, and nobody home yet.
    let said = ''
    try {
      said = herdr('pane', 'list')
    } catch (error) {
      said = String((error as { stdout?: string }).stdout ?? '') + String((error as { stderr?: string }).stderr ?? '')
    }
    if (!said.includes('server_not_running') || !said.includes(home)) throw new Error(`herdr is not isolated: ${said.slice(0, 200)}`)
  })

  afterAll(() => {
    // Only ever this HOME's server: herdrEnv carries nothing else.
    try { herdr('server', 'stop') } catch { /* not running */ }
    try { tmux('kill-server') } catch { /* not running */ }
    rmSync(home, { recursive: true, force: true })
  })

  it('herdr: the pane goes on working after the process that started it is killed', async () => {
    const beat = path.join(home, 'herdr-beat')
    const env = herdrEnv()
    // The same spawn as spawnHerdrServer: detached, unref'd, descriptors raised.
    const app = standIn(
      `const { spawn } = require('node:child_process')
       spawn('/bin/sh', ['-c', 'ulimit -n 4096 2>/dev/null || true; exec "$0" server', ${JSON.stringify(HERDR)}], { detached: true, stdio: 'ignore', env: process.env }).unref()
       setInterval(() => undefined, 1000)`,
      env
    )
    await until('the herdr server', () => {
      try {
        herdr('workspace', 'list')
        return true
      } catch {
        return null
      }
    })
    const made = JSON.parse(herdr('workspace', 'create', '--cwd', home)) as { result?: { root_pane?: { pane_id?: string } } }
    const pane = made.result?.root_pane?.pane_id
    expect(pane).toBeTruthy()
    herdr('pane', 'send-text', String(pane), beatLoop(beat))
    herdr('pane', 'send-keys', String(pane), 'Enter')
    const before = await until('the first beat', () => beatOf(beat))
    await killAndWait(app)
    await sleep(2500)
    expect(beatOf(beat)).toBeGreaterThan(before)
    expect(herdr('pane', 'list')).toContain(String(pane))
  }, 40_000)

  it('tmux: the pane goes on working after the process that started it is killed', async () => {
    const beat = path.join(home, 'tmux-beat')
    const env = { HOME: home, PATH: '/usr/bin:/bin', TERM: 'xterm' }
    const app = standIn(
      `require('node:child_process').execFileSync(${JSON.stringify(TMUX)}, ['-L', ${JSON.stringify(tmuxLabel)}, '-f', '/dev/null', 'new-session', '-d', '-s', 'cookrew_proof', ${JSON.stringify(beatLoop(beat))}], { env: process.env })
       setInterval(() => undefined, 1000)`,
      env
    )
    const before = await until('the first beat', () => beatOf(beat))
    await killAndWait(app)
    await sleep(2500)
    expect(beatOf(beat)).toBeGreaterThan(before)
    expect(tmux('list-sessions', '-F', '#{session_name}')).toContain('cookrew_proof')
  }, 40_000)

  it('direct: the claim is false, a child of the app dies with it', async () => {
    const beat = path.join(home, 'direct-beat')
    // A direct pane is a plain child of the app: not detached, sharing its fate
    // through the PTY's hangup. A pipe closing is the same message to the shell.
    const app = standIn(
      `const child = require('node:child_process').spawn('/bin/sh', ['-c', ${JSON.stringify(`trap 'exit 0' HUP TERM; ${beatLoop(beat)}`)}], { stdio: 'ignore' })
       process.on('SIGTERM', () => { child.kill('SIGHUP'); process.exit(0) })
       setInterval(() => undefined, 1000)`,
      { HOME: home, PATH: '/usr/bin:/bin' }
    )
    await until('the first beat', () => beatOf(beat))
    await new Promise<void>((resolve) => {
      app.once('exit', () => resolve())
      app.kill('SIGTERM')
    })
    await sleep(1500)
    const after = beatOf(beat)
    await sleep(2500)
    expect(beatOf(beat)).toBe(after)
  }, 30_000)
})
