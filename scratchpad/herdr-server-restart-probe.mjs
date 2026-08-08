// Does a Cookrew pane survive the herdr SERVER dying (reboot, crash, update)?
//
// The dangerous outcome is not "the pane is gone" — Cookrew handles that. It is
// "the pane comes back with its LABEL but WITHOUT its agent": ensureSession
// looks up by label, finds one, early-returns, and never boots the agent. The
// terminal would reattach to a bare shell and Cookrew would think it recovered.

import { execFileSync } from 'node:child_process'

const SESSION = 'cookrewrestart'
const CONFIG = '/tmp/cookrew-herdr-e2e/cookrew.herdr.toml'
const env = { ...process.env, HERDR_SESSION: SESSION, HERDR_CONFIG_PATH: CONFIG }
const cli = (args, quiet = false) => {
  try {
    return execFileSync('herdr', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (e) {
    return quiet ? '' : `ERR ${e.message.slice(0, 120)}`
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const panes = () => {
  try {
    return JSON.parse(cli(['pane', 'list'])).result.panes
  } catch {
    return []
  }
}

const { HerdrHostMultiplexer } = await import('../src/main/herdr-host-multiplexer.ts')
const SPEC = {
  sessionName: 'cookrew_restart1',
  // A distinctive long-lived "agent" whose presence is checkable by pid/cmdline.
  command: `sh -c 'echo AGENT_IS_ALIVE_MARKER; exec sleep 9999'`,
  shell: '/bin/sh',
  terminalId: 'restart-1',
  socketPath: '/tmp/rs.sock',
  cliDir: '/tmp/rscli',
  path: '/tmp/rscli:/usr/bin:/bin',
  cwd: '/tmp'
}

cli(['server', 'stop'], true)
await sleep(800)

const mux = new HerdrHostMultiplexer({ session: SESSION, configPath: CONFIG })
mux.ensureSession(SPEC)
await sleep(2500)

const before = panes().find((p) => p.label === SPEC.sessionName)
const pidBefore = mux.panePid(SPEC.sessionName)
console.log('BEFORE  label:', before?.label, ' pane:', before?.pane_id, ' pid:', pidBefore)
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
console.log('BEFORE  agent process alive:', pidBefore ? alive(pidBefore) : 'no pid')

// The event under test: the server goes away.
console.log('\n--- stopping the herdr server ---')
cli(['server', 'stop'], true)
await sleep(2500)
console.log('agent process still alive after server stop:', pidBefore ? alive(pidBefore) : 'n/a')

// Cookrew's next launch: ensureSession runs again and must do the RIGHT thing.
console.log('\n--- Cookrew restarts: ensureSession again ---')
const mux2 = new HerdrHostMultiplexer({ session: SESSION, configPath: CONFIG })
mux2.ensureSession(SPEC)
await sleep(2500)

const after = panes().find((p) => p.label === SPEC.sessionName)
const pidAfter = mux2.panePid(SPEC.sessionName)
console.log('AFTER   label:', after?.label, ' pane:', after?.pane_id, ' pid:', pidAfter)
const cap = mux2.capture(SPEC.sessionName) ?? ''
console.log('AFTER   agent booted (marker on screen):', cap.includes('AGENT_IS_ALIVE_MARKER'))
console.log('AFTER   capture tail:', JSON.stringify(cap.slice(-160)))

console.log('\nVERDICT:')
if (!after) console.log('  pane GONE after server restart -> ensureSession recreates. Safe.')
else if (cap.includes('AGENT_IS_ALIVE_MARKER')) console.log('  pane restored AND agent rebooted. Safe.')
else console.log('  *** LABEL SURVIVED WITHOUT THE AGENT — ensureSession early-returns on a dead pane ***')

cli(['server', 'stop'], true)
process.exit(0)
