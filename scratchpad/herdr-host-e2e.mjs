// LIVE end-to-end proof for HerdrHostMultiplexer.
//
// The unit tests script the runner, so they prove the LOGIC and nothing about
// herdr. This drives the real backend against a real, Cookrew-owned herdr
// server on its own socket and does exactly what PtySession does:
// ensureSession -> attachSpawn -> pty.spawn.
//
// It asserts the things a mocked test cannot:
//   - Cookrew's herdr server starts on its own socket (isolation)
//   - the pane boots the command and Cookrew's env reaches the agent
//   - node-pty gets a usable stream (echo, no chrome)
//   - the session SURVIVES the client dying, and reattach finds the same pane
//     with its scrollback intact  <- the whole reason for a multiplexer

import { createRequire } from 'node:module'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { register } from 'node:module'

const require = createRequire(import.meta.url)
const pty = require('node-pty')

const DIR = '/tmp/cookrew-herdr-e2e'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

const SESSION = 'cookrewe2e'
const CONFIG = `${DIR}/cookrew.herdr.toml`
writeFileSync(
  CONFIG,
  [
    'onboarding = false',
    '[ui]',
    'sidebar_start_collapsed = true',
    'sidebar_collapsed_mode = "hidden"',
    'hide_tab_bar_when_single_tab = true',
    'pane_borders = false',
    'pane_scrollbars = false',
    'pane_gaps = false',
    'host_cursor = "native"'
  ].join('\n')
)

const { HerdrHostMultiplexer } = await import('../src/main/herdr-host-multiplexer.ts')

const SPEC = {
  sessionName: 'cookrew_e2etest',
  // A shell that proves Cookrew's env arrived, then stays alive like an agent.
  command: `sh -c 'echo TERMID=[$COOKREW_TERMINAL_ID]; echo CLI=[$COOKREW_CLI]; exec sh'`,
  shell: '/bin/sh',
  terminalId: 'e2e-abc',
  socketPath: '/tmp/cookrew-e2e.sock',
  cliDir: '/tmp/cookrew-e2e-cli',
  path: `/tmp/cookrew-e2e-cli:${process.env.PATH}`,
  cwd: '/tmp'
}

// A server surviving a previous run would make ensureSession correctly do
// nothing, and the test would then measure a pane it never booted.
try {
  execFileSync('herdr', ['server', 'stop'], { env: { ...process.env, HERDR_SESSION: SESSION }, stdio: 'ignore' })
} catch {
  // Not running is the normal case.
}
rmSync(`${process.env.HOME}/.config/herdr/sessions/${SESSION}`, { recursive: true, force: true })

const mux = new HerdrHostMultiplexer({ session: SESSION, configPath: CONFIG })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

const attach = () => {
  const spawnSpec = mux.attachSpawn(SPEC)
  // Spawn EXACTLY as PtySession does: base env + the backend's declared env.
  // Hand-injecting HERDR_SESSION here is what previously masked a real bug —
  // the app spawned attaches without it and every terminal rendered blank
  // while this probe passed 14/14.
  return pty.spawn(spawnSpec.file, spawnSpec.args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: SPEC.cwd,
    env: { ...process.env, ...spawnSpec.env }
  })
}

const run = async () => {
  check('binary available', mux.available())

  mux.ensureSession(SPEC)
  check('session exists after ensureSession', mux.sessionExists(SPEC.sessionName))

  // Isolation: Cookrew's server must be its own, not the user's.
  // A stopped default server is itself proof of isolation, and `pane list`
  // exits 1 there — so a throw must not be read as a failure of the check.
  let userPanes = ''
  try {
    userPanes = execFileSync('herdr', ['pane', 'list'], {
      encoding: 'utf8',
      env: { ...process.env, HERDR_SOCKET_PATH: `${process.env.HOME}/.config/herdr/herdr.sock` },
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    userPanes = ''
  }
  check(
    'ISOLATION: cookrew pane absent from the user\'s own herdr server',
    !userPanes.includes('cookrew_e2etest')
  )

  // Idempotence: a second call must not reboot a running agent.
  const before = mux.listSessions().length
  mux.ensureSession(SPEC)
  check('ensureSession is idempotent', mux.listSessions().length === before, `${before} sessions`)

  let out = ''
  const p1 = attach()
  p1.onData((d) => (out += d))
  await sleep(4000)

  const plain = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  check('COOKREW_TERMINAL_ID reached the agent', plain.includes('TERMID=[e2e-abc]'))
  check('COOKREW_CLI reached the agent', plain.includes('CLI=[/tmp/cookrew-e2e-cli/cookrew]'))
  // Match herdr's UI strings, not any occurrence of the word: the boot
  // command echoes PATH, which on this machine contains "/workspace/".
  check('no herdr chrome in the stream', !/prefix mode|ctrl\+b|herdr —|\bsidebar\b/i.test(plain))

  // Write a marker, then kill the CLIENT (not the session) — a workspace
  // switch or app quit.
  p1.write('echo SURVIVES_RESTART_MARKER\r')
  await sleep(1200)
  check('echo works through the attach', out.includes('SURVIVES_RESTART_MARKER'))

  p1.kill()
  await sleep(1500)
  check('SESSION SURVIVED the client dying', mux.sessionExists(SPEC.sessionName))

  // Reattach: the same pane, with its scrollback.
  const p2 = attach()
  let out2 = ''
  p2.onData((d) => (out2 += d))
  await sleep(3000)
  // Strip escapes first: herdr repaints with colour runs interleaved, so the
  // marker is split across SGR sequences in the raw stream even when it is
  // plainly on screen.
  const plain2 = out2
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  check(
    'REATTACH shows the pre-restart scrollback',
    plain2.includes('SURVIVES_RESTART_MARKER'),
    'the whole point of a multiplexer'
  )

  const scroll = mux.scrollState(SPEC.sessionName)
  check('scrollState reports live + a history number', scroll.scrollRow === null && scroll.historySize !== null,
    JSON.stringify(scroll))
  const pid = mux.panePid(SPEC.sessionName)
  check('panePid resolves', typeof pid === 'number' && pid > 0, String(pid))
  const cap = mux.capture(SPEC.sessionName)
  check('capture returns scrollback text', typeof cap === 'string' && cap.includes('SURVIVES_RESTART_MARKER'))

  p2.kill()
  mux.killSession(SPEC.sessionName)
  await sleep(1000)
  check('killSession removes the pane', !mux.sessionExists(SPEC.sessionName))

  execFileSync('herdr', ['server', 'stop'], {
    env: { ...process.env, HERDR_SESSION: SESSION },
    stdio: 'ignore'
  })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

run().catch((e) => {
  console.error('E2E FAILED:', e.message)
  process.exit(1)
})
