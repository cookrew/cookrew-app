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

/** This script as the owner's app: invoke/send over fd 3, window events back. */
function owner(pipe) {
  let next = 1
  const waiting = new Map()
  const events = []
  let buffered = ''
  pipe.setEncoding('utf8')
  pipe.on('data', (chunk) => {
    buffered += chunk
    let at = buffered.indexOf('\n')
    while (at !== -1) {
      const frame = JSON.parse(buffered.slice(0, at))
      buffered = buffered.slice(at + 1)
      if (frame.t === 'result') {
        waiting.get(frame.id)?.(frame)
        waiting.delete(frame.id)
      } else if (frame.t === 'event') events.push(frame)
      at = buffered.indexOf('\n')
    }
  })
  return {
    events,
    invoke(channel, args = []) {
      const id = next++
      pipe.write(`${JSON.stringify({ t: 'invoke', id, channel, args })}\n`)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${channel}: no answer in 30 s`)), 30_000)
        waiting.set(id, (frame) => {
          clearTimeout(timer)
          frame.ok ? resolve(frame.value) : reject(new Error(`${channel}: ${frame.error}`))
        })
      })
    },
    send(channel, args = []) {
      pipe.write(`${JSON.stringify({ t: 'send', channel, args })}\n`)
    }
  }
}

/**
 * The owner link end to end: an owner-only handler answers the owner (it
 * answers null to anyone else), typing over the link comes back as the owner
 * window's pty events, and a shell the daemon spawned holds no unix socket
 * (so no copy of the owner's pipe).
 */
async function ownerChecks(link, terminalId, call, seenOverHttp) {
  const status = await link.invoke('launch-settings:status')
  if (status === null || typeof status !== 'object') return fail(`launch-settings:status answered the owner ${JSON.stringify(status)} (owner check did not hold)`)
  const list = await link.invoke('workspace:list')
  if (!Array.isArray(list?.workspaces) || list.workspaces.length === 0) return fail(`workspace:list over the owner link: ${JSON.stringify(list)}`)
  await link.invoke('pty:attach', [terminalId])
  link.send('pty:input', [terminalId, 'echo owner-$((6*7))\r'])
  const typed = await waitFor(
    () => link.events.some((e) => e.channel === `pty:data:${terminalId}` && JSON.stringify(e.args).includes('owner-42')),
    15_000,
    'the owner window to see its own typing'
  )
  if (typed) console.log('cookrewd smoke: owner link OK (owner-only handler, invoke, send, window events)')
  await call(`/api/terminal/${terminalId}/raw`, {
    method: 'POST',
    // Both probes: unix sockets the shell holds, and fd 3 itself (a pipe() would not show as unix).
    body: JSON.stringify({
      data: 'echo UNIXFDS=$(lsof -a -p $$ -U 2>/dev/null | tail -n +2 | wc -l | tr -d " ") FD3=$( { : >&3; } 2>/dev/null && echo open || echo closed)\r',
      id: 'smoke-fds'
    })
  })
  const probe = /UNIXFDS=(\d+) FD3=(open|closed)/
  if (await waitFor(() => probe.test(seenOverHttp()), 15_000, 'the descriptor probe')) {
    const [, count, fd3] = probe.exec(seenOverHttp())
    if (Number(count) !== 0 || fd3 !== 'closed') fail(`a pane holds ${count} unix socket(s) and its fd 3 is ${fd3}: the owner pipe may have leaked`)
    else console.log('cookrewd smoke: no unix socket and no fd 3 in a pane (the owner pipe did not leak)')
  }
}

/**
 * SIGUSR1 must not open a Node inspector on the daemon (no-inspector.ts): any
 * same-user agent could send it and attach as the owner.
 */
async function inspectorCheck(daemon) {
  process.kill(daemon.pid, 'SIGUSR1')
  await sleep(1500)
  if (daemon.exitCode !== null || daemon.signalCode !== null) return fail('SIGUSR1 ended the daemon')
  let listening = ''
  try {
    listening = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(daemon.pid), '-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' })
  } catch {
    listening = '' // lsof exits 1 when it finds nothing
  }
  if (/:9229\b|:922\d\b/.test(listening)) fail(`SIGUSR1 opened an inspector:\n${listening}`)
  else console.log('cookrewd smoke: SIGUSR1 opened no inspector (daemon alive, nothing on 9229)')
}

async function main() {
  if (!existsSync(path.join(root, 'out/daemon/index.js'))) return fail('build first: node scripts/daemon-build.mjs')
  if (herdrOnDaemonPath()) return fail(`herdr is on ${DAEMON_PATH}; the daemon could reach the live fleet`)
  const panesBefore = livePanes()
  // Short on purpose: a unix socket path must fit in 104 bytes on macOS, and the
  // CLI socket lives under TMPDIR/cookrew-runtime/ (os.tmpdir() is /var/folders/… and too long).
  const base = mkdtempSync('/tmp/cookrewd-')
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
    COOKREWD_OWNER_FD: '3',
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
  // fd 3 is the owner link (src/main/daemon/owner-link.ts): this script plays the owner's app.
  const daemon = spawn(electron, [path.join(root, 'out/daemon/index.js')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
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
    await ownerChecks(owner(daemon.stdio[3]), created.id, call, () => seen)
    await inspectorCheck(daemon)
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
    if (/Starting the CLI socket .* failed/.test(log)) fail('the daemon could not start its CLI socket')
    const missing = [...new Set(log.match(/electron\.[^\n]* is not available in the daemon/g) ?? [])]
    if (missing.length > 0) console.log(`cookrewd smoke: still missing in the daemon:\n  ${missing.join('\n  ')}`)
    if (process.exitCode) console.error(log.slice(-4000))
    rmSync(base, { recursive: true, force: true })
  }
}

main().catch((error) => fail(error instanceof Error ? error.stack : String(error)))
