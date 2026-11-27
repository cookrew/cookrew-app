#!/usr/bin/env node
// COOKREW-ACP: an agent that speaks the Agent Client Protocol, run in a pane.
//
// Some agents ship no terminal UI of their own (DeepSeek Harness removed its
// TUI in 2026-08; ACP is its non-web surface). Cookrew runs this host in the
// card's pane instead: it starts the agent as a child, talks ACP v1 to it over
// stdio, and draws a plain inline UI the pane, the phone and Cookrew's own
// readers already understand:
//
//   - a prompt box (`❯ `) between two rules over a `⏎ send` footer;
//   - the agent's reply, tool calls (`⏺ title`) and their results (`⎿`);
//   - an approval as a NUMBERED menu with an `esc to cancel` footer, so
//     Cookrew's wait-menu reader (shared/wait-choice.ts) answers it.
//
// And it writes Cookrew's own transcript of the session,
// ~/.cookrew/hosted/<agent>/<session>.jsonl, holding it open for its whole
// life: the pane's process holds the file, which is how Cookrew binds the card
// (lsof, harness.ts 'pid-held'). Every turn ends on an `end` record, the
// end-of-turn proof (shared/hosted-trace.ts).
//
// Usage: cookrew-acp <agent> [--model M] [--effort E] [--resume ID] [--mcp URL]…
//                    [--base-url URL] [--key-command CMD] [--permission MODE]
//                    [--effort-option ID]
//        cookrew-acp --command '["bin","arg"]' …   (any ACP agent; tests)
//
// Runs on the app's own Node (Electron as node, the `cookrew` shim's way), so
// it uses nothing but Node's own modules.

import { spawn, execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

delete process.env.ELECTRON_RUN_AS_NODE

/** What the host knows of each agent it runs. */
const AGENTS = {
  dsh: {
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
const agent = opts.command
  ? { name: opts.agentId, bin: opts.command[0], args: () => opts.command.slice(1), env: {}, effortOption: opts.effortOption }
  : AGENTS[opts.agentId]
if (agent && opts.effortOption) agent.effortOption = opts.effortOption
if (!agent) fail(`no ACP agent named ${opts.agentId}; known: ${Object.keys(AGENTS).join(', ')}`)
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
const width = () => Math.max(20, process.stdout.columns || 100)
const dim = (text) => `\x1b[2m${text}\x1b[22m`
let atLineStart = true
function print(text) {
  if (!text) return
  out(text)
  atLineStart = text.endsWith('\n')
}
const newline = () => { if (!atLineStart) print('\n') }

let state = 'boot'
let buffer = ''
let inputDrawn = false
let menu = null
const queue = []
let model = ''
let effort = ''

function shown() {
  const lines = buffer.split('\n')
  const last = lines.at(-1)
  const more = lines.length > 1 ? dim(` (+${lines.length - 1} lines)`) : ''
  const room = width() - 6
  return `${last.length > room ? `…${last.slice(-room)}` : last}${more}`
}

function footer() {
  const parts = [agent.name, model, effort].filter(Boolean)
  return dim(`  ${parts.join(' · ')} · ⏎ send · esc esc stop · /new`)
}

function drawInput() {
  if (inputDrawn || state !== 'idle') return
  newline()
  const rule = '─'.repeat(width() - 1)
  out(`${rule}\n❯ ${shown()}\n${rule}\n${footer()}\x1b[2A\r\x1b[2K❯ ${shown()}`)
  inputDrawn = true
  atLineStart = false
}

function redrawPrompt() {
  if (inputDrawn) out(`\r\x1b[2K❯ ${shown()}`)
}

function eraseInput() {
  if (!inputDrawn) return
  out('\x1b[1A\r\x1b[J')
  inputDrawn = false
  atLineStart = true
}

function drawMenu() {
  const { question, about, options, cursor } = menu
  // One line, so the question is the whole line that asks it (a "what" line
  // over it without a "?" would be read as part of the question).
  const lines = [`  ${about ? `${about} · ` : ''}${question}`, ...options.map((o, i) => `${i === cursor ? '❯' : ' '} ${i + 1}. ${o.name}`), dim('  esc to cancel · ↑/↓ to move · enter to select')]
  if (menu.drawn) out(`\x1b[${menu.drawn}A\r\x1b[J`)
  out(`${lines.join('\n')}\n`)
  menu.drawn = lines.length
  atLineStart = true
}

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

// ---- ACP over the child's stdio ----

const childEnv = { ...process.env, ...agent.env }
delete childEnv.ELECTRON_RUN_AS_NODE
if (opts.baseUrl && agent.baseUrlEnv) childEnv[agent.baseUrlEnv] = opts.baseUrl
if (opts.permission && agent.permissionEnv) childEnv[agent.permissionEnv] = opts.permission
if (opts.keyCommand && agent.keyEnv) {
  try {
    childEnv[agent.keyEnv] = execFileSync('/bin/sh', ['-c', opts.keyCommand], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    fail('the key command did not answer', 1)
  }
}
let patch = null
if (opts.model && agent.modelPatch) {
  const card = (process.env.COOKREW_TERMINAL_ID || '').match(/^[A-Za-z0-9-]{1,64}$/) ? process.env.COOKREW_TERMINAL_ID : `pid-${process.pid}`
  mkdirSync(path.join(home, 'patches'), { recursive: true, mode: 0o700 })
  patch = path.join(home, 'patches', `${card}.yml`)
  writeFileSync(patch, agent.modelPatch(opts.model), { mode: 0o600 })
}

const child = spawn(agent.bin, agent.args(patch), { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] })
let childErr = ''
child.stderr.on('data', (chunk) => { childErr = `${childErr}${chunk}`.slice(-4000) })
child.on('error', (error) => {
  restoreTerminal()
  const install = agent.install ? ` Install it: ${agent.install}` : ''
  process.stderr.write(error.code === 'ENOENT' ? `cookrew-acp: ${agent.bin} is not installed.${install}\n` : `cookrew-acp: ${agent.bin} did not start: ${error.message}\n`)
  process.exit(127)
})
child.on('exit', (code, signal) => {
  if (state === 'closing') return
  closeTranscript()
  restoreTerminal()
  newline()
  process.stderr.write(`cookrew-acp: ${agent.name} exited (${signal ?? code}).\n${childErr.trim().split('\n').slice(-5).join('\n')}\n`)
  process.exit(1)
})

let nextId = 0
const waiting = new Map()
let inbound = ''
child.stdout.on('data', (chunk) => {
  inbound += chunk
  let at
  while ((at = inbound.indexOf('\n')) >= 0) {
    const line = inbound.slice(0, at)
    inbound = inbound.slice(at + 1)
    if (line.trim()) handleMessage(line)
  }
})

const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
function call(method, params) {
  return new Promise((resolve, reject) => {
    nextId += 1
    waiting.set(nextId, { resolve, reject })
    send({ id: nextId, method, params })
  })
}

function handleMessage(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id !== undefined && !message.method) {
    const pending = waiting.get(message.id)
    waiting.delete(message.id)
    if (!pending) return
    if (message.error) pending.reject(new Error(message.error.message ?? 'the agent refused'))
    else pending.resolve(message.result ?? {})
    return
  }
  if (message.method === 'session/update') return onUpdate(message.params?.update ?? {})
  if (message.method === 'session/request_permission' && message.id !== undefined) return askPermission(message.id, message.params ?? {})
  // The client capabilities said no file system and no terminals: anything else is refused.
  if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: `${message.method} is not offered by this client` } })
}

// ---- what the agent says ----

const tools = new Map()
let lastMessage = null
let thinking = false

function summary(input) {
  if (!input || typeof input !== 'object') return ''
  const text = input.description ?? input.command ?? input.file_path ?? input.path ?? Object.values(input).find((v) => typeof v === 'string') ?? ''
  const one = String(text).split('\n')[0]
  return one.length > 100 ? `${one.slice(0, 99)}…` : one
}

function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content.map((part) => (part?.content?.type === 'text' ? part.content.text : part?.type === 'text' ? part.text : '')).filter(Boolean).join('\n')
}

function onUpdate(update) {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = update.content?.type === 'text' ? update.content.text : ''
      if (!text) return
      if (update.messageId !== lastMessage) {
        newline()
        if (lastMessage !== null) print('\n')
        lastMessage = update.messageId ?? null
      }
      bufferText('text', update.messageId ?? null, text)
      print(text)
      return
    }
    case 'agent_thought_chunk': {
      const text = update.content?.type === 'text' ? update.content.text : ''
      if (!text) return
      bufferText('thought', update.messageId ?? null, text)
      if (!thinking) {
        newline()
        // No spinner glyph: Cookrew reads one as a live turn, which would keep
        // an approval from being offered while the card waits for the person.
        print(`${dim('  thinking…')}\n`)
        thinking = true
      }
      return
    }
    case 'tool_call': {
      flushText()
      const title = update.title ?? 'tool'
      const about = summary(update.rawInput)
      tools.set(update.toolCallId, { title, about })
      record({ t: 'tool', id: update.toolCallId, title, kind: update.kind ?? null, input: about })
      newline()
      print(`⏺ ${title}${about ? ` ${dim(about)}` : ''}\n`)
      lastMessage = null
      return
    }
    case 'tool_call_update': {
      if (update.status !== 'completed' && update.status !== 'failed') return
      flushText()
      const output = contentText(update.content)
      record({ t: 'tool_done', id: update.toolCallId, status: update.status, output: output.slice(0, 2000) })
      // The first line that says something: not dsh's <path> wrapper, not a bare [stderr] tag.
      const first = output.split('\n').find((l) => l.trim() && !l.startsWith('<') && !/^\[\w+\]$/.test(l.trim())) ?? (update.status === 'failed' ? 'failed' : 'done')
      newline()
      print(`  ${dim(`⎿ ${first.slice(0, width() - 8)}`)}\n`)
      return
    }
    default:
      return
  }
}

function askPermission(requestId, params) {
  flushText()
  const options = Array.isArray(params.options) ? params.options : []
  const tool = tools.get(params.toolCall?.toolCallId) ?? { title: params.toolCall?.title ?? 'tool', about: '' }
  const about = `${tool.title}${tool.about ? `: ${tool.about}` : ''}`
  record({ t: 'permission', id: params.toolCall?.toolCallId ?? null, about, options: options.map((o) => o.name) })
  newline()
  state = 'menu'
  menu = { requestId, options, cursor: 0, about, question: 'Allow this?', drawn: 0 }
  drawMenu()
  report('blocked')
}

function answerMenu(index) {
  if (!menu) return
  const { requestId, options } = menu
  const option = index === null ? null : options[index]
  const reject = options.find((o) => String(o.kind).startsWith('reject'))
  const chosen = option ?? reject ?? null
  send({ id: requestId, result: { outcome: chosen ? { outcome: 'selected', optionId: chosen.optionId } : { outcome: 'cancelled' } } })
  record({ t: 'answer', option: chosen?.name ?? 'cancelled' })
  out(`\x1b[${menu.drawn}A\r\x1b[J`)
  print(`  ${dim(`${chosen?.name ?? 'Cancelled'}`)}\n`)
  menu = null
  state = 'working'
  report('working')
}

// ---- turns ----

let sessionId = null
let cancelArmedAt = 0

async function runTurn(text) {
  state = 'working'
  eraseInput()
  print(`\n❯ ${text.replace(/\n/g, '\n  ')}\n`)
  print(`${dim('… working (esc esc to stop)')}\n`)
  lastMessage = null
  thinking = false
  record({ t: 'user', text })
  report('working')
  try {
    const result = await call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
    flushText()
    record({ t: 'end', stop: result.stopReason ?? 'end_turn' })
  } catch (error) {
    flushText()
    newline()
    print(`${dim(`✗ ${error.message}`)}\n`)
    record({ t: 'error', message: error.message })
    record({ t: 'end', stop: 'error' })
  }
  newline()
  report('idle')
  state = 'idle'
  if (queue.length > 0) return runTurn(queue.shift())
  drawInput()
}

async function newSession() {
  const mcpServers = opts.mcp.map((url, i) => ({ type: 'http', name: i === 0 ? 'magpie' : `mcp${i + 1}`, url, headers: [] }))
  const created = await call('session/new', { cwd, mcpServers })
  sessionId = created.sessionId
  openTranscript(sessionId, false)
  await applyOptions(created.configOptions)
}

async function resumeSession(id) {
  const mcpServers = opts.mcp.map((url, i) => ({ type: 'http', name: i === 0 ? 'magpie' : `mcp${i + 1}`, url, headers: [] }))
  const resumed = await call('session/resume', { sessionId: id, cwd, mcpServers })
  sessionId = id
  openTranscript(sessionId, true)
  await applyOptions(resumed.configOptions)
}

function current(options, id) {
  const option = Array.isArray(options) ? options.find((o) => o.id === id || o.category === id) : null
  if (!option) return ''
  const value = option.currentValue
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? String(parsed.at(-1)) : String(value)
  } catch {
    return String(value ?? '')
  }
}

async function applyOptions(options) {
  let latest = options
  if (opts.effort && agent.effortOption) {
    try {
      latest = (await call('session/set_config_option', { sessionId, configId: agent.effortOption, value: opts.effort })).configOptions ?? latest
    } catch (error) {
      print(`${dim(`✗ effort ${opts.effort}: ${error.message}`)}\n`)
    }
  }
  model = opts.model ?? current(latest, 'model')
  effort = current(latest, agent.effortOption ?? 'thought_level')
  record({ t: 'model', model, effort })
}

async function command(text) {
  const word = text.trim().split(/\s+/)[0]
  if (word === '/new' || word === '/clear') {
    eraseInput()
    if (sessionId) await call('session/close', { sessionId }).catch(() => undefined)
    await newSession()
    print(`\n✓ New session ${dim(sessionId)}\n`)
    drawInput()
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
  if (!text.trim()) return redrawPrompt()
  if (state !== 'idle') {
    queue.push(text)
    print(`${dim(`  queued: ${text.split('\n')[0].slice(0, 60)}`)}\n`)
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
      redrawPrompt()
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
  drawMenu()
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
        send({ method: 'session/cancel', params: { sessionId } })
        print(`${dim('  stopping…')}\n`)
      } else cancelArmedAt = now
      return
    }
    if (key === '\x03') {
      if (buffer) { buffer = ''; return redrawPrompt() }
      const now = Date.now()
      if (now - cancelArmedAt < 1000) return quit(0)
      cancelArmedAt = now
    }
    return
  }
  if (key === '\x04') return state === 'idle' && !buffer ? quit(0) : undefined
  if (key === '\r') return void submit()
  if (key === '\n') { buffer += '\n'; return redrawPrompt() }
  if (key === '\x7f' || key === '\b') { buffer = buffer.slice(0, -1); return redrawPrompt() }
  if (key === '\x15') { buffer = ''; return redrawPrompt() }
  if (key >= ' ' || key === '\t') { buffer += key; redrawPrompt() }
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
  eraseInput()
  closeTranscript()
  restoreTerminal()
  report('idle')
  child.kill()
  process.exit(code)
}

process.on('SIGTERM', () => quit(0))
process.on('SIGHUP', () => quit(0))
process.stdout.on('resize', () => { if (inputDrawn) { eraseInput(); drawInput() } })
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', onKeys)
out('\x1b[?2004h')
print(`${dim('Cookrew ·')} ${agent.name} ${dim(`(ACP) · ${cwd}`)}\n`)

try {
  await call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
  if (opts.resume) {
    try {
      await resumeSession(opts.resume)
      print(`${dim(`resumed ${opts.resume}`)}\n`)
    } catch (error) {
      // Never a silent fresh start in its place: the card would lose its
      // conversation without a word. The person decides.
      print(`✗ Session ${opts.resume} could not be resumed: ${error.message}\n  Press Enter for a new session, or Ctrl-D to quit.\n`)
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
    await newSession()
  }
} catch (error) {
  restoreTerminal()
  process.stderr.write(`cookrew-acp: ${agent.name} did not open a session: ${error.message}\n${childErr.trim().split('\n').slice(-5).join('\n')}\n`)
  state = 'closing'
  child.kill()
  process.exit(1)
}

state = 'idle'
report('idle')
if (queue.length > 0) void runTurn(queue.shift())
else drawInput()
