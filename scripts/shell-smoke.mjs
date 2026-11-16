#!/usr/bin/env node
/**
 * THE SHELL SMOKE (D0 step 3): the Electron shell plus its daemon, fully
 * isolated and with the window hidden, driven through the real renderer over
 * CDP: the app's own preload API (window.cookrew) is called the way the UI
 * calls it, and the answers must come from the daemon across the owner link.
 *
 *   npm run shell:smoke
 *
 * Isolation as scripts/daemon-smoke.mjs: herdr off PATH (refused otherwise),
 * an empty environment, its own HOME, TMPDIR, user data and ports, a dead
 * registry. The live fleet's pane ids are compared before and after.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const SHELL_PATH = '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
const CDP_PORT = Number(process.env.COOKREW_SHELL_SMOKE_CDP ?? 9351)
const PHONE_PORT = Number(process.env.COOKREW_SHELL_SMOKE_PORT ?? 18649)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fail(message) {
  console.error(`shell smoke: FAIL — ${message}`)
  process.exitCode = 1
}

function livePanes() {
  try {
    return new Set(JSON.parse(execFileSync('herdr', ['pane', 'list'], { encoding: 'utf8', timeout: 10_000 })).result.panes.map((p) => p.pane_id))
  } catch {
    return null
  }
}

function portBusy(port) {
  try {
    execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** A minimal CDP client: Runtime.evaluate in the renderer page. */
async function rendererPage() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
      const page = pages.find((p) => p.type === 'page' && /renderer\/index\.html|localhost/.test(p.url))
      if (page) return page
    } catch {
      // not up yet
    }
    await sleep(250)
  }
  return null
}

function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl)
  let next = 1
  const waiting = new Map()
  socket.onmessage = (message) => {
    const frame = JSON.parse(message.data)
    if (frame.id && waiting.has(frame.id)) {
      waiting.get(frame.id)(frame)
      waiting.delete(frame.id)
    }
  }
  const opened = new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = reject
  })
  return {
    async evaluate(expression) {
      await opened
      const id = next++
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
      const frame = await new Promise((resolve) => waiting.set(id, resolve))
      if (frame.result?.exceptionDetails) throw new Error(frame.result.exceptionDetails.exception?.description ?? 'evaluation failed')
      return frame.result?.result?.value
    },
    close: () => socket.close()
  }
}

async function drive(page) {
  const r = cdp(page.webSocketDebuggerUrl)
  try {
    const hasApi = await r.evaluate('typeof window.cookrew === "object"')
    if (!hasApi) return fail('the renderer has no window.cookrew (the preload did not load)')
    const listed = await r.evaluate('window.cookrew.listWorkspaces().then((l) => JSON.stringify(l))')
    const workspaces = JSON.parse(listed)
    if (!Array.isArray(workspaces?.workspaces) || workspaces.workspaces.length === 0) return fail(`listWorkspaces over the shell: ${listed}`)
    console.log(`shell smoke: renderer -> shell -> daemon OK (${workspaces.workspaces.length} workspace)`)
    // The launch settings are owner-only: null for anyone but the owner window.
    const launch = await r.evaluate('window.cookrew.launchSettings().then((s) => JSON.stringify(s))')
    if (launch === 'null' || launch === undefined) return fail(`launchSettings answered ${launch}: the owner check did not hold across the shell`)
    console.log('shell smoke: an owner-only call answered the owner window')
    // A terminal, typed into through the renderer's own bridge, its bytes back as window events.
    const typed = await r.evaluate(`(async () => {
      const node = await window.cookrew.createTerminal({ name: 'shell-smoke', preset: 'shell' })
      let seen = ''
      window.cookrew.ptyAttach(node.id, (d) => { seen += d })
      await new Promise((r) => setTimeout(r, 1500))
      window.cookrew.ptyInput(node.id, 'echo shell-$((7*6))\\r')
      for (let i = 0; i < 60 && !seen.includes('shell-42'); i++) await new Promise((r) => setTimeout(r, 250))
      return seen.includes('shell-42') ? 'typed' : 'silent: ' + seen.slice(-200)
    })()`)
    if (typed !== 'typed') return fail(`a terminal through the shell: ${typed}`)
    console.log('shell smoke: a terminal round trip through the renderer bridge OK')
    // The window never follows a page elsewhere (it would inherit the preload).
    // A file: URL on purpose: an http one would be handed to the owner's real browser.
    await r.evaluate('location.href = "file:///etc/hosts"; true').catch(() => undefined)
    await sleep(1500)
    const where = await r.evaluate('location.href')
    if (!/renderer\/index\.html/.test(String(where))) return fail(`the window followed a page elsewhere: ${where}`)
    const still = await r.evaluate('window.cookrew.listWorkspaces().then(() => "ok")')
    if (still !== 'ok') return fail('the bridge stopped after a refused navigation')
    console.log('shell smoke: a navigation away was refused; the window stayed the owner page')
  } finally {
    r.close()
  }
}

async function main() {
  for (const file of ['out/shell/index.js', 'out/daemon/index.js', 'out/preload/index.cjs', 'out/renderer/index.html']) {
    if (!existsSync(path.join(root, file))) return fail(`${file} is missing (npm run build, then node scripts/shell-build.mjs)`)
  }
  if (SHELL_PATH.split(':').some((dir) => existsSync(path.join(dir, 'herdr')))) return fail('herdr is on the shell PATH')
  if (portBusy(CDP_PORT)) return fail(`port ${CDP_PORT} is in use; set COOKREW_SHELL_SMOKE_CDP`)
  const before = livePanes()
  const base = mkdtempSync('/tmp/crshell-')
  const env = {
    HOME: path.join(base, 'home'),
    TMPDIR: path.join(base, 'tmp') + '/',
    TMUX_TMPDIR: path.join(base, 'tmp'),
    USER: process.env.USER ?? 'cookrew',
    LANG: 'en_US.UTF-8',
    PATH: SHELL_PATH,
    COOKREW_SHELL_HIDDEN: '1',
    COOKREW_MULTIPLEXER: 'direct',
    COOKREW_REGISTRY: 'http://127.0.0.1:9',
    COOKREW_INTERACTIVE_BROWSER: '0',
    COOKREW_MOBILE_PORT: String(PHONE_PORT),
    COOKREW_MOBILE_HTTPS_PORT: String(PHONE_PORT + 4)
  }
  for (const dir of [env.HOME, env.TMPDIR]) execFileSync('mkdir', ['-p', dir])
  const shell = spawn(electron, [path.join(root, 'out/shell/index.js'), `--user-data-dir=${path.join(base, 'userdata')}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  shell.stdout.on('data', (b) => (log += b))
  shell.stderr.on('data', (b) => (log += b))
  shell.on('error', (error) => fail(`the shell did not start: ${error.message}`))
  const stop = () => {
    shell.kill('SIGKILL')
    rmSync(base, { recursive: true, force: true })
    process.exit(130)
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, stop)
  try {
    const page = await rendererPage()
    if (!page) return fail('the shell window never appeared on CDP')
    await sleep(2000)
    await drive(page)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  } finally {
    shell.kill('SIGTERM')
    await new Promise((resolve) => {
      shell.once('exit', resolve)
      setTimeout(() => {
        shell.kill('SIGKILL')
        resolve()
      }, 10_000)
    })
    await sleep(1000)
    const leftover = (() => {
      try {
        return execFileSync('/usr/bin/pgrep', ['-f', base], { encoding: 'utf8' }).trim()
      } catch {
        return ''
      }
    })()
    if (leftover) fail(`processes outlived the shell: ${leftover}`)
    const after = livePanes()
    if (before === null || after === null) console.log('shell smoke: live fleet NOT VERIFIED (herdr not reachable here)')
    else {
      const gone = [...before].filter((id) => !after.has(id))
      if (gone.length > 0) fail(`live panes vanished: ${gone.join(', ')}`)
      else console.log(`shell smoke: live fleet untouched (all ${before.size} panes still there)`)
    }
    const bridged = /bridged (\d+) handled and (\d+) sent/.exec(log)
    if (bridged) console.log(`shell smoke: the shell bridged ${bridged[1]} handled and ${bridged[2]} sent channels`)
    const missing = [...new Set(log.match(/electron\.[^\n]* is not available in the daemon/g) ?? [])]
    if (missing.length > 0) console.log(`shell smoke: still missing in the daemon:\n  ${missing.join('\n  ')}`)
    if (process.exitCode) console.error(log.slice(-5000))
    rmSync(base, { recursive: true, force: true })
  }
}

main().catch((error) => fail(error instanceof Error ? error.stack : String(error)))
