#!/usr/bin/env node
// COOKREW-ACP: an agent that has no terminal UI of its own, run in a card's pane.
//
// Some agents ship no TUI (DeepSeek Harness removed its own in 2026-08; ACP is
// its non-web surface) and some are a stateful server with an API (Alma). This
// host draws the pane itself and drives whichever the card names:
//
//   cookrew-acp dsh  …   ACP v1 over stdio to `dsh --profile acp`   (cli/host/acp.mjs)
//   cookrew-acp alma …   Alma's HTTP API, its socket only to stop  (cli/host/alma.mjs)
//
// Either way it writes Cookrew's transcript of the session to
// ~/.cookrew/hosted/<agent>/<session>.jsonl and HOLDS IT OPEN: that file is the
// card's binding (lsof, harness.ts 'pid-held'), and its `end` record is the
// end-of-turn proof (shared/hosted-trace.ts). The screen it draws is the one
// Cookrew's readers already understand — a `❯ ` box, `⏺` tool lines, and an
// approval as a numbered menu with an `esc to cancel` footer (cli/host/ui.mjs).
//
// Usage: cookrew-acp <agent> [--model M] [--effort E] [--resume ID] [--mcp URL]…
//                    [--base-url URL] [--key-command CMD] [--permission MODE]
//                    [--effort-option ID] [--command '["bin","arg"]']
//
// Runs on the app's own Node (Electron as node, the `cookrew` shim's way), so
// it uses nothing but Node's own modules.

import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { AcpBackend } from './host/acp.mjs'
import { AlmaBackend } from './host/alma.mjs'
import { Screen } from './host/ui.mjs'

delete process.env.ELECTRON_RUN_AS_NODE

/** What the host knows of each agent it runs directly (ACP agents a card can also name by --command). */
const AGENTS = {
  dsh: {
    kind: 'acp',
    name: 'DeepSeek Harness',
    bin: 'dsh',
    install: 'npm i -g @deepseek-ai/dsh',
    args: (patch) => ['--profile', 'acp', ...(patch ? ['--patch', patch] : [])],
    env: { DSH_TELEMETRY_DISABLED: '1' },
    keyEnv: 'DEEPSEEK_API_KEY',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    permissionEnv: 'DSH_PERMISSION_MODE',
    // A patch row sets the model, so a name outside dsh's own catalog (a
    // gateway's `group/smart`) works too; a patch replaces the row's config.
    modelPatch: (model) => `- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: ${JSON.stringify(model)}\n`,
    effortOption: 'reasoning_effort'
  },
  alma: {
    kind: 'alma',
    name: 'Alma',
    baseUrl: 'http://127.0.0.1:23001'
  }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const ESC_GAP_MS = 800
const FLUSH_MS = 300

// ---- arguments ----

function parseArgs(argv) {
  const opts = { mcp: [] }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = () => {
      const next = argv[i + 1]
      if (next === undefined) fail(`${arg} needs a value`)
      i += 1
      return next
    }
    if (arg === '--model') opts.model = value()
    else if (arg === '--effort') opts.effort = value()
    else if (arg === '--resume') opts.resume = value()
    else if (arg === '--mcp') opts.mcp.push(value())
    else if (arg === '--base-url') opts.baseUrl = value()
    else if (arg === '--key-command') opts.keyCommand = value()
    else if (arg === '--permission') opts.permission = value()
    else if (arg === '--effort-option') opts.effortOption = value()
    else if (arg === '--command') opts.command = JSON.parse(value())
    else rest.push(arg)
  }
  opts.agentId = rest[0] ?? (opts.command ? 'custom' : undefined)
  return opts
}

function fail(message, code = 2) {
  process.stderr.write(`cookrew-acp: ${message}\n`)
  process.exit(code)
}

const opts = parseArgs(process.argv.slice(2))
if (!opts.agentId || !NAME_RE.test(opts.agentId)) fail('usage: cookrew-acp <agent> [--model M] [--resume ID] …')
const spec = opts.command ? { kind: 'acp', name: opts.agentId, bin: opts.command[0], args: () => opts.command.slice(1), env: {}, effortOption: opts.effortOption } : { ...AGENTS[opts.agentId] }
if (!spec?.kind) fail(`no agent named ${opts.agentId}; known: ${Object.keys(AGENTS).join(', ')}`)
if (opts.effortOption && spec.kind === 'acp') spec.effortOption = opts.effortOption
if (opts.resume !== undefined && !ID_RE.test(opts.resume)) fail('--resume takes a session id')

const cwd = process.cwd()
const home = path.join(process.env.HOME || homedir(), '.cookrew', 'hosted', opts.agentId)
mkdirSync(home, { recursive: true, mode: 0o700 })

// ---- the transcript ----

let transcript = null
let pendingText = null
let flushTimer = null

function record(rec) {
  if (!transcript) return
  try {
    writeSync(transcript.fd, `${JSON.stringify({ ...rec, at: rec.at ?? Date.now() })}\n`)
  } catch (error) {
    process.stderr.write(`cookrew-acp: transcript write failed: ${error.message}\n`)
  }
}

function openTranscript(sessionId, resumed) {
  if (!ID_RE.test(sessionId)) throw new Error(`the agent named an unusable session id: ${sessionId}`)
  closeTranscript()
  const file = path.join(home, `${sessionId}.jsonl`)
  const existed = existsSync(file)
  transcript = { fd: openSync(file, 'a', 0o600), file, sessionId }
  record(existed || resumed ? { t: 'resume', id: sessionId, cwd } : { t: 'session', v: 1, agent: opts.agentId, id: sessionId, cwd })
}

function closeTranscript() {
  flushText()
  if (transcript) closeSync(transcript.fd)
  transcript = null
}

/** Reply text arrives a few characters at a time: written in coalesced runs. */
function bufferText(kind, message, text) {
  if (pendingText && (pendingText.kind !== kind || pendingText.message !== message)) flushText()
  pendingText = pendingText ?? { kind, message, text: '' }
  pendingText.text += text
  if (!flushTimer) flushTimer = setTimeout(flushText, FLUSH_MS)
}

function flushText() {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  if (!pendingText) return
  const { kind, message, text } = pendingText
  pendingText = null
  record({ t: kind, message, text })
}

// ---- the screen ----

const out = (text) => process.stdout.write(text)
const screen = new Screen(out, { name: spec.name })

let state = 'boot'
let buffer = ''
let menu = null
const queue = []
let lastMessage = null
let thinking = false

// ---- herdr status (the pane's lifecycle, when a herdr hosts it) ----

const herdrPane = process.env.HERDR_ENV === '1' && process.env.HERDR_PANE_ID && process.env.HERDR_SOCKET_PATH ? process.env.HERDR_PANE_ID : null
let lastReport = null
function report(status) {
  if (!herdrPane || status === lastReport) return
  lastReport = status
  const herdr = process.env.HERDR_BIN_PATH || path.join(homedir(), '.local', 'bin', 'herdr')
  const seq = String(Date.now() * 1000 + (process.hrtime()[1] % 1000))
  try {
    const child = spawn(herdr, ['pane', 'report-agent', herdrPane, '--source', 'cookrew-acp', '--agent', opts.agentId, '--state', status, '--seq', seq], { stdio: 'ignore', detached: true })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // Status is a nicety; the transcript is the record.
  }
}

// ---- what the agent says ----

const showText = (message, text) => {
  screen.newline()
  if (message !== lastMessage) {
    if (lastMessage !== null) screen.print('\n')
    lastMessage = message
  }
  bufferText('text', message, text)
  screen.print(text)
}

const events = {
  // The session is known and its transcript opens before its first record.
  session: ({ id, resumed }) => openTranscript(id, resumed),
  text: showText,
  thought: (message, text) => {
    bufferText('thought', message, text)
    if (!thinking) {
      screen.newline()
      // No spinner glyph: Cookrew reads one as a live turn, which would keep
      // an approval from being offered while the card waits for the person.
      screen.print(`\x1b[2m  thinking…\x1b[22m\n`)
      thinking = true
    }
  },
  tool: (id, title, about, kind = null) => {
    flushText()
    record({ t: 'tool', id, title, kind, input: about })
    screen.newline()
    screen.print(`⏺ ${title}${about ? ` \x1b[2m${about}\x1b[22m` : ''}\n`)
    lastMessage = null
  },
  toolDone: (id, status, output) => {
    flushText()
    record({ t: 'tool_done', id, status, output: String(output).slice(0, 2000) })
    // The first line that says something: not dsh's <path> wrapper, not a bare [stderr] tag.
    const first = String(output).split('\n').find((l) => l.trim() && !l.startsWith('<') && !/^\[\w+\]$/.test(l.trim())) ?? (status === 'failed' ? 'failed' : 'done')
    screen.newline()
    screen.print(`  \x1b[2m⎿ ${first.slice(0, screen.width() - 8)}\x1b[22m\n`)
  },
  permissionRecord: ({ about, options }) => {
    flushText()
    record({ t: 'permission', about, options })
  },
  permission: ({ about, options }) =>
    new Promise((resolve) => {
      screen.newline()
      state = 'menu'
      menu = { options, cursor: 0, about, question: 'Allow this?', drawn: 0, resolve }
      screen.drawMenu(menu)
      report('blocked')
    }),
  answered: (name) => {
    record({ t: 'answer', option: name })
    screen.clearMenu(menu)
    if (menu) screen.print(`  \x1b[2m${name}\x1b[22m\n`)
    menu = null
    state = 'working'
    report('working')
  },
  model: ({ model, effort }) => {
    screen.model = model ?? ''
    screen.effort = effort ?? ''
    record({ t: 'model', model: screen.model, effort: screen.effort })
    if (screen.inputDrawn) { screen.eraseInput(); screen.drawInput(state) }
  },
  notice: (message) => {
    screen.newline()
    screen.print(`\x1b[2m  ${message}\x1b[22m\n`)
  },
  exit: ({ error, code, signal }) => {
    if (state === 'closing') return
    closeTranscript()
    restoreTerminal()
    screen.newline()
    const why = error ? (error.code === 'ENOENT' ? `${spec.bin} is not installed.${spec.install ? ` Install it: ${spec.install}` : ''}` : `${spec.bin} did not start: ${error.message}`) : `${spec.name} exited (${signal ?? code}).`
    process.stderr.write(`cookrew-acp: ${why}\n${(childErr ?? '').trim().split('\n').slice(-5).join('\n')}\n`)
    process.exit(error?.code === 'ENOENT' ? 127 : 1)
  }
}
let childErr = ''

// ---- the backend ----

function makeBackend() {
  if (spec.kind === 'alma') {
    const baseUrl = opts.baseUrl ?? process.env.ALMA_API_URL ?? spec.baseUrl
    return new AlmaBackend({ baseUrl, model: opts.model, effort: opts.effort, cwd, events })
  }
  const env = { ...process.env, ...spec.env }
  delete env.ELECTRON_RUN_AS_NODE
  if (opts.baseUrl && spec.baseUrlEnv) env[spec.baseUrlEnv] = opts.baseUrl
  if (opts.permission && spec.permissionEnv) env[spec.permissionEnv] = opts.permission
  if (opts.keyCommand && spec.keyEnv) {
    try {
      env[spec.keyEnv] = execFileSync('/bin/sh', ['-c', opts.keyCommand], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      fail('the key command did not answer', 1)
    }
  }
  let patch = null
  if (opts.model && spec.modelPatch) {
    const card = (process.env.COOKREW_TERMINAL_ID || '').match(/^[A-Za-z0-9-]{1,64}$/) ? process.env.COOKREW_TERMINAL_ID : `pid-${process.pid}`
    mkdirSync(path.join(home, 'patches'), { recursive: true, mode: 0o700 })
    patch = path.join(home, 'patches', `${card}.yml`)
    writeFileSync(patch, spec.modelPatch(opts.model), { mode: 0o600 })
  }
  return new AcpBackend({
    bin: spec.bin,
    args: spec.args(patch),
    env,
    cwd,
    mcp: opts.mcp,
    model: opts.model,
    effort: opts.effort,
    effortOption: spec.effortOption,
    events,
    onChildStderr: (chunk) => { childErr = `${childErr}${chunk}`.slice(-4000) }
  })
}

let backend = makeBackend()

// ---- turns ----

let cancelArmedAt = 0

async function runTurn(text) {
  state = 'working'
  screen.eraseInput()
  screen.print(`\n❯ ${text.replace(/\n/g, '\n  ')}\n`)
  screen.print(`\x1b[2m… working (esc esc to stop)\x1b[22m\n`)
  lastMessage = null
  thinking = false
  record({ t: 'user', text })
  report('working')
  try {
    const { stop } = await backend.prompt(text)
    flushText()
    record({ t: 'end', stop: stop ?? 'end_turn' })
  } catch (error) {
    flushText()
    screen.newline()
    screen.print(`\x1b[2m✗ ${error.message}\x1b[22m\n`)
    record({ t: 'error', message: error.message })
    record({ t: 'end', stop: 'error' })
  }
  screen.newline()
  report('idle')
  state = 'idle'
  if (queue.length > 0) return runTurn(queue.shift())
  screen.drawInput(state)
}

async function openSession({ resume } = {}) {
  return backend.open({ resume })
}

async function newSession() {
  backend.close()
  backend = makeBackend()
  await openSession({})
}

async function command(text) {
  const word = text.trim().split(/\s+/)[0]
  if (word === '/new' || word === '/clear') {
    screen.eraseInput()
    await newSession()
    screen.print(`\n✓ New session \x1b[2m${transcript?.sessionId ?? ''}\x1b[22m\n`)
    screen.drawInput(state)
    return true
  }
  if (word === '/exit' || word === '/quit') {
    quit(0)
    return true
  }
  return false
}

async function submit() {
  const text = buffer
  buffer = ''
  if (!text.trim()) return screen.redrawPrompt()
  if (state !== 'idle') {
    queue.push(text)
    screen.print(`\x1b[2m  queued: ${text.split('\n')[0].slice(0, 60)}\x1b[22m\n`)
    return
  }
  if (text.trim().startsWith('/') && (await command(text))) return
  await runTurn(text)
}

// ---- keys ----

let pasting = false

function onKeys(data) {
  let at = 0
  while (at < data.length) {
    if (data.startsWith('\x1b[200~', at)) { pasting = true; at += 6; continue }
    if (data.startsWith('\x1b[201~', at)) { pasting = false; at += 6; continue }
    if (pasting) {
      const end = data.indexOf('\x1b[201~', at)
      const chunk = data.slice(at, end < 0 ? data.length : end)
      buffer += chunk.replace(/\r\n?/g, '\n')
      at += chunk.length
      screen.buffer = buffer
      screen.redrawPrompt()
      continue
    }
    const seq = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(data.slice(at))
    if (seq) { onSequence(seq[0]); at += seq[0].length; continue }
    onKey(data[at])
    at += 1
  }
}

function onSequence(seq) {
  if (!menu) return
  if (seq === '\x1b[A') menu.cursor = (menu.cursor + menu.options.length - 1) % menu.options.length
  else if (seq === '\x1b[B') menu.cursor = (menu.cursor + 1) % menu.options.length
  else return
  screen.drawMenu(menu)
}

function answerMenu(index) {
  if (!menu) return
  menu.resolve(index)
  menu = null
}

function onKey(key) {
  if (menu) {
    if (key === '\r' || key === '\n') return answerMenu(menu.cursor)
    if (key === '\x1b') return answerMenu(null)
    if (/[1-9]/.test(key) && Number(key) <= menu.options.length) return answerMenu(Number(key) - 1)
    return
  }
  if (key === '\x1b' || key === '\x03') {
    if (state === 'working') {
      const now = Date.now()
      if (key === '\x03' || now - cancelArmedAt < ESC_GAP_MS) {
        cancelArmedAt = 0
        void backend.cancel()
        screen.print(`\x1b[2m  stopping…\x1b[22m\n`)
      } else cancelArmedAt = now
      return
    }
    if (key === '\x03') {
      if (buffer) { buffer = ''; screen.buffer = buffer; return screen.redrawPrompt() }
      const now = Date.now()
      if (now - cancelArmedAt < 1000) return quit(0)
      cancelArmedAt = now
    }
    return
  }
  if (key === '\x04') return state === 'idle' && !buffer ? quit(0) : undefined
  if (key === '\r') return void submit()
  if (key === '\n') { buffer += '\n'; screen.buffer = buffer; return screen.redrawPrompt() }
  if (key === '\x7f' || key === '\b') { buffer = buffer.slice(0, -1); screen.buffer = buffer; return screen.redrawPrompt() }
  if (key === '\x15') { buffer = ''; screen.buffer = buffer; return screen.redrawPrompt() }
  if (key >= ' ' || key === '\t') { buffer += key; screen.buffer = buffer; screen.redrawPrompt() }
}

// ---- life ----

function restoreTerminal() {
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false) } catch { /* gone */ }
  }
  out('\x1b[?2004l')
}

function quit(code) {
  state = 'closing'
  screen.eraseInput()
  closeTranscript()
  restoreTerminal()
  report('idle')
  backend.close()
  process.exit(code)
}

process.on('SIGTERM', () => quit(0))
process.on('SIGHUP', () => quit(0))
process.stdout.on('resize', () => { if (screen.inputDrawn) { screen.eraseInput(); screen.drawInput(state) } })
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', onKeys)
out('\x1b[?2004h')
screen.print(`\x1b[2mCookrew ·\x1b[22m ${spec.name} \x1b[2m(${spec.kind === 'alma' ? 'Alma API' : 'ACP'}) · ${cwd}\x1b[22m\n`)

try {
  if (opts.resume) {
    try {
      await openSession({ resume: opts.resume })
      screen.print(`\x1b[2mresumed ${opts.resume}\x1b[22m\n`)
    } catch (error) {
      // Never a silent fresh start in its place: the card would lose its
      // conversation without a word. The person decides.
      screen.print(`✗ Session ${opts.resume} could not be resumed: ${error.message}\n  Press Enter for a new session, or Ctrl-D to quit.\n`)
      state = 'stuck'
      await new Promise((resolve) => {
        const onStuckKey = (data) => {
          if (data.includes('\x04')) return quit(1)
          if (data.includes('\r')) { process.stdin.off('data', onStuckKey); resolve() }
        }
        process.stdin.off('data', onKeys)
        process.stdin.on('data', onStuckKey)
      })
      process.stdin.on('data', onKeys)
      buffer = ''
      await newSession()
    }
  } else {
    await openSession({})
  }
} catch (error) {
  restoreTerminal()
  const refused = /ECONNREFUSED/.test(String(error.cause ?? error)) ? `Alma is not running at ${opts.baseUrl ?? spec.baseUrl}. Open Alma once.` : error.message
  process.stderr.write(`cookrew-acp: ${spec.name} did not open a session: ${refused}\n${(childErr ?? '').trim().split('\n').slice(-5).join('\n')}\n`)
  state = 'closing'
  backend.close()
  process.exit(1)
}

state = 'idle'
report('idle')
if (queue.length > 0) void runTurn(queue.shift())
else screen.drawInput(state)
