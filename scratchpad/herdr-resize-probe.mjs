// Does the herdr attach client REPAINT when its PTY is resized?
//
// The mobile terminal view depends on exactly this: it opens with a weak
// plain-text snapshot, then POSTs /resize expecting the multiplexer to answer
// with a full redraw (tmux does — resizing a client rewraps the session and
// repaints every cell). If herdr's client ignores SIGWINCH, the phone never
// gets a base screen and every delta lands on the wrong coordinates — which is
// precisely the "words in a mess" screenshot.
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const pty = require('node-pty')
const SESSION = 'cookrewresize'
const CONFIG = '/tmp/cookrew-herdr-e2e/cookrew.herdr.toml'
const env = { ...process.env, HERDR_SESSION: SESSION, HERDR_CONFIG_PATH: CONFIG }
const cli = (a, q) => {
  try {
    return execFileSync('herdr', a, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (e) {
    return q ? '' : 'ERR'
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rows = () => {
  try {
    return JSON.parse(cli(['pane', 'list'])).result.panes[0].scroll.viewport_rows
  } catch {
    return '?'
  }
}

cli(['server', 'stop'], 1)
await sleep(600)
const { HerdrHostMultiplexer } = await import('../src/main/herdr-host-multiplexer.ts')
const SPEC = {
  sessionName: 'cookrew_rz1',
  command: '', // plain shell is fine — we only need painted content
  shell: '/bin/zsh',
  terminalId: 'rz1',
  socketPath: '/tmp/rz.sock',
  cliDir: '/tmp/rzcli',
  path: `/tmp/rzcli:${process.env.PATH}`,
  cwd: '/tmp'
}
const mux = new HerdrHostMultiplexer({ session: SESSION, configPath: CONFIG })
mux.ensureSession(SPEC)
await sleep(2000)

const spawnSpec = mux.attachSpawn(SPEC)
const p = pty.spawn(spawnSpec.file, spawnSpec.args, {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: '/tmp',
  env: { ...process.env, ...spawnSpec.env }
})
let bytes = 0
p.onData((d) => (bytes += d.length))
await sleep(3000)
// Put some content on screen so a repaint is visible.
p.write('seq 1 40\r')
await sleep(1500)
console.log(`attached at 80x24: pane viewport_rows=${rows()}  bytes so far=${bytes}`)

const before = bytes
p.resize(120, 35)
await sleep(2500)
console.log(`after resize to 120x35: pane viewport_rows=${rows()}  bytes since resize=${bytes - before}`)
console.log(bytes - before > 500 ? 'CLIENT REPAINTS ON RESIZE' : '*** CLIENT IGNORES RESIZE — no repaint ***')

p.kill()
cli(['server', 'stop'], 1)
process.exit(0)
