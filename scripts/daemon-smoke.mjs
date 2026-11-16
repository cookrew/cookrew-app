#!/usr/bin/env node
/**
 * cookrewd SMOKE: boot the daemon (out/daemon/index.js) in full isolation,
 * prove the API, a terminal round trip over HTTP + SSE, then stop it and
 * prove the live fleet was not touched.
 *
 *   node scripts/daemon-build.mjs && node scripts/daemon-smoke.mjs
 *
 * ISOLATION (memory: a second instance once closed 56 panes): herdr is kept
 * OFF the daemon's PATH (its session name is hard-coded, so a separate HOME
 * alone does not protect the fleet), the environment starts empty (env -i
 * style), and HOME, TMPDIR (the CLI socket lives under it), userData and both
 * phone ports are the smoke's own. The run refuses to start when herdr would
 * be reachable from the daemon's PATH.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const DAEMON_PATH = '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
const PORT = Number(process.env.COOKREWD_SMOKE_PORT ?? 18639)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fail(message) {
  console.error(`cookrewd smoke: FAIL — ${message}`)
  process.exitCode = 1
}

/** The live fleet's pane ids, read by THIS process (which may reach herdr); null when it can't. */
function livePanes() {
  try {
    const out = execFileSync('herdr', ['pane', 'list'], { encoding: 'utf8', timeout: 10_000 })
    return new Set(JSON.parse(out).result.panes.map((pane) => pane.pane_id))
  } catch {
    return null
  }
}

/** Panes that were live before and are gone after: the only thing a stray daemon would do to the fleet. */
function vanished(before, after) {
  return [...before].filter((id) => !after.has(id))
}

function herdrOnDaemonPath() {
  return DAEMON_PATH.split(':').some((dir) => existsSync(path.join(dir, 'herdr')))
}

async function waitFor(check, ms, what) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check()) return true
    await sleep(250)
  }
  fail(`${what} within ${ms} ms`)
  return false
}

async function main() {
  if (!existsSync(path.join(root, 'out/daemon/index.js'))) return fail('build first: node scripts/daemon-build.mjs')
  if (herdrOnDaemonPath()) return fail(`herdr is on ${DAEMON_PATH}; the daemon could reach the live fleet`)
  const panesBefore = livePanes()
  const base = mkdtempSync(path.join(tmpdir(), 'cookrewd-smoke-'))
  const home = path.join(base, 'home')
  const env = {
    HOME: home,
    TMPDIR: path.join(base, 'tmp') + '/',
    USER: process.env.USER ?? 'cookrew',
    LANG: 'en_US.UTF-8',
    PATH: DAEMON_PATH,
    TMUX_TMPDIR: path.join(base, 'tmp'),
    COOKREWD: '1',
    COOKREWD_PARENT_PIPE: '1',
    COOKREW_MULTIPLEXER: 'direct',
    // Nothing here may talk to production or open a real browser.
    COOKREW_REGISTRY: 'http://127.0.0.1:9',
    COOKREW_INTERACTIVE_BROWSER: '0',
    COOKREW_MOBILE_PORT: String(PORT),
    COOKREW_MOBILE_HTTPS_PORT: String(PORT + 4),
    COOKREWD_USER_DATA: path.join(base, 'userdata'),
    COOKREWD_APP_ROOT: root,
    ELECTRON_RUN_AS_NODE: '1'
  }
  for (const dir of [home, env.TMPDIR, env.COOKREWD_USER_DATA]) execFileSync('mkdir', ['-p', dir])
  // stdin is a pipe the daemon watches: if this script dies, the daemon exits too.
  const daemon = spawn(electron, [path.join(root, 'out/daemon/index.js')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let log = ''
  daemon.stdout.on('data', (b) => (log += b))
  daemon.stderr.on('data', (b) => (log += b))
  daemon.on('error', (error) => fail(`the daemon did not start: ${error.message}`))
  const stopOnSignal = () => {
    daemon.kill('SIGKILL')
    rmSync(base, { recursive: true, force: true })
    process.exit(130)
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, stopOnSignal)
  const api = `http://127.0.0.1:${PORT}`
  const tokenFile = path.join(home, '.cookrew', 'pairing-token')
  try {
    if (!(await waitFor(() => existsSync(tokenFile), 30_000, 'a pairing token'))) return
    const token = readFileSync(tokenFile, 'utf8').trim()
    const call = (route, init = {}) =>
      fetch(api + route, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } })
    if (!(await waitFor(async () => (await call('/api/auth/status').catch(() => null))?.ok, 30_000, 'the API'))) return
    const created = await (await call('/api/terminals', { method: 'POST', body: JSON.stringify({ name: 'smoke', preset: 'shell' }) })).json()
    if (typeof created.id !== 'string') return fail(`no terminal: ${JSON.stringify(created)}`)
    const stream = await call(`/api/terminal/${created.id}/stream`, { headers: { accept: 'text/event-stream' } })
    const reader = stream.body.getReader()
    let seen = ''
    const reading = (async () => {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        seen += new TextDecoder().decode(value)
      }
    })().catch(() => undefined)
    await waitFor(() => seen.includes('event: hello'), 15_000, 'the terminal hello')
    await call(`/api/terminal/${created.id}/raw`, { method: 'POST', body: JSON.stringify({ data: 'echo smoke-$((40+2))\r', id: 'smoke-1' }) })
    if (await waitFor(() => seen.includes('smoke-42'), 15_000, 'the shell to answer')) {
      console.log('cookrewd smoke: API, terminal and SSE round trip OK')
    }
    await reader.cancel().catch(() => undefined)
    await reading
  } finally {
    daemon.kill('SIGTERM')
    await new Promise((resolve) => {
      daemon.once('exit', resolve)
      setTimeout(() => {
        daemon.kill('SIGKILL')
        resolve()
      }, 10_000)
    })
    const panesAfter = livePanes()
    if (panesBefore === null || panesAfter === null) {
      console.log('cookrewd smoke: live fleet NOT VERIFIED (herdr not reachable from this shell)')
    } else {
      const gone = vanished(panesBefore, panesAfter)
      if (gone.length > 0) fail(`live panes vanished during the run: ${gone.join(', ')}`)
      else console.log(`cookrewd smoke: live fleet untouched (all ${panesBefore.size} panes still there)`)
    }
    const missing = [...new Set(log.match(/electron\.[^\n]* is not available in the daemon/g) ?? [])]
    if (missing.length > 0) console.log(`cookrewd smoke: still missing in the daemon:\n  ${missing.join('\n  ')}`)
    if (process.exitCode) console.error(log.slice(-4000))
    rmSync(base, { recursive: true, force: true })
  }
}

main().catch((error) => fail(error instanceof Error ? error.stack : String(error)))
