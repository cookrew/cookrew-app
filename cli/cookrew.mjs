#!/usr/bin/env node
// cookrew — CLI bridge into the Cookrew app over its Unix socket.
// Verbs: list, ask, check, note, browser,
// connect, recruit, dismiss, preset, notify, login, logout, whoami, remote, help.
import net from 'node:net'
import path from 'node:path'
import { lstatSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import process from 'node:process'

// The shim ran this on the app's own Electron (src/main/cli-shim.ts). That is
// for this process alone: a command `secret exec` starts must not inherit it,
// or any Electron app it opens comes up as a bare node.
delete process.env.ELECTRON_RUN_AS_NODE

function fail(message, exitCode = 1) {
  process.stderr.write(`cookrew: ${message}\n`)
  // Per-outcome exit codes for delivery failures (shared/ask-outcome.ts): a
  // caller's remedy differs per outcome and two of them are destructive if
  // swapped, so `ask` never collapses them all to 1.
  process.exit(exitCode)
}

/**
 * The app's socket.
 *
 * Inside a pane COOKREW_SOCKET is injected. Outside one — a plain shell, once
 * this CLI is on the system PATH — the app publishes it at ~/.cookrew/socket.
 *
 * That pointer exists because the path is NOT safely derivable: the runtime dir
 * sits under the OS temp dir, and on macOS TMPDIR is per-user, so a shell
 * without TMPDIR computes '/tmp/...' and reaches a socket that is not there.
 * The tmpdir guess is kept as a last resort for an app too old to publish, or a
 * first launch that has not published yet.
 */
function readSocketPointer() {
  try {
    const value = readFileSync(path.join(homedir(), '.cookrew', 'socket'), 'utf8').trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

/**
 * The app's dir for this user (src/main/runtime-dir.ts): the per-user name on Linux,
 * the shared one where that is theirs. Never a dir somebody else holds: what this
 * sends is for this user's app. With neither, the call fails as "not running".
 */
function guessedSocket() {
  const shared = path.join(tmpdir(), 'cookrew-runtime')
  const uid = process.getuid?.()
  if (uid === undefined) return path.join(shared, 'cookrew.sock')
  const own = `${shared}-${uid}`
  const mine = (dir) => {
    try {
      return lstatSync(dir).uid === uid
    } catch {
      return false
    }
  }
  return path.join(!mine(own) && mine(shared) ? shared : own, 'cookrew.sock')
}

const socketPath =
  process.env.COOKREW_SOCKET ??
  readSocketPointer() ??
  guessedSocket()

// Everything after `--` is the exec command and never a flag or an arg.
const argvAll = process.argv.slice(2)
const dashDash = argvAll.indexOf('--')
const tail = dashDash === -1 ? [] : argvAll.slice(dashDash + 1)
const { cmd, args, flags } = parseArgv(dashDash === -1 ? argvAll : argvAll.slice(0, dashDash))
if (!cmd) fail("No command given. Run 'cookrew help'.")

/**
 * Who is calling.
 *
 * Every identity-scoped command (list, ask, note, connect …) resolves "self"
 * from a terminal id, because the caller is normally an agent inside its own
 * pane. From a plain shell there is no pane, so `--as "Agent Name"` names the
 * terminal to speak as and the app resolves it.
 *
 * This grants nothing new: the socket is a user-owned Unix socket, and inside a
 * pane COOKREW_TERMINAL_ID is just an environment variable. Anything running as
 * this user could already claim any identity — `--as` only makes it sayable.
 *
 * Deliberately NOT validated here: which commands need an identity is the app's
 * business (`list --all` needs none), so an empty id is forwarded and the app
 * answers. Rejecting it in the CLI would duplicate that rule in two places and
 * get it wrong the first time a command changes.
 */
const terminalId = process.env.COOKREW_TERMINAL_ID ?? ''

/**
 * The claude session this process is running inside, read from its own process
 * ancestry, or null.
 *
 * WHY THIS EXISTS. The env var above is exported into a pane's shell once at
 * boot, which is right for the pane's own agent and wrong for an agent the
 * harness spawns in the BACKGROUND: it runs under the process tree of whichever
 * pane hosts the daemon and inherits that pane's environment, so its CLI calls
 * act as another card in another workspace and succeed. The session id is the
 * one fact that travels with the AGENT rather than with the pane, and it is in
 * its argv.
 *
 * Best effort by design. A failure here (no ps, an exotic harness, a shell with
 * no claude ancestor) yields null, and the app keeps using the env value — the
 * behaviour every non-claude caller already has. Bounded to a few hops so a
 * deep tree cannot make the CLI slow.
 */
function ancestorSessionId() {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  const flag = new RegExp(`--(?:session-id|resume)[= ](${uuid})\\b`, 'i')
  try {
    let pid = process.pid
    for (let hop = 0; hop < 6 && pid > 1; hop += 1) {
      const out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 1000
      }).trim()
      if (!out) return null
      const match = flag.exec(out)
      if (match) return match[1].toLowerCase()
      const next = Number.parseInt(out.trimStart().split(/\s+/)[0] ?? '', 10)
      if (!Number.isFinite(next) || next === pid) return null
      pid = next
    }
  } catch {
    // Identity repair is a nicety; never let it break a command.
  }
  return null
}

// `preset list` / `note read` style subcommands stay in args; flags are
// --key [value], except the boolean flags below, which are always bare.
function parseArgv(argv) {
  // Flags that never take a value, in any position. Without the list every
  // `--key` took the token after it, so `note create --new "x"` sent "x" as the
  // flag's value and made an EMPTY note, and `ask "A" --no-wait -` never read
  // stdin. Kept in step with src/main/cli-flags.ts (this script is copied alone
  // next to the socket and imports nothing from the app);
  // tests/cli-bool-flags.test.ts runs this client against every name there.
  // Declared inside the function: it runs before module-level consts below it
  // are initialised, and a test lifts this function out by its source.
  const BOOLEAN_FLAGS = new Set(['all', 'canvas', 'disabled', 'github', 'help', 'new', 'no-wait', 'rotate'])
  const args = []
  const flags = {}
  let cmd = null
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i += 1
      } else {
        flags[key] = true
      }
    } else if (cmd === null) {
      cmd = token
    } else {
      args.push(token)
    }
  }
  return { cmd, args, flags }
}

// sessionId is a CLAIM the app verifies against its own bindings, not a
// replacement for terminalId: when the two disagree the binding wins, and when
// the session is unknown the env value stands.
// `cookrew secret exec <name> -- <command…>`: everything after `--` is the
// command, run HERE with the value in its env as COOKREW_SECRET_<NAME>. The
// app answers the value once over the socket; it is never written to this
// pane, so it never reaches the scrollback, the transcript or the wall.
const execTail = cmd === 'secret' && args[0] === 'exec' ? tail : null
if (execTail !== null && execTail.length === 0) {
  fail('usage: cookrew secret exec <name> -- <command…>', 1)
}
/**
 * `cookrew ask "Agent" -`, `cookrew recruit --prompt -` and `cookrew role save
 * "Agent" "Role" --prompt -`: a lone dash reads the brief from stdin.
 *
 * WHY. A brief passed as an argument goes through the caller's shell, which
 * runs backticks and $(...), expands $VAR and history-expands ! before this
 * process ever sees the text. The brief still delivered, a word short, with no
 * error — agents briefing each other hit it constantly. A quoted heredoc
 * (<<'EOF') is the one shell form that passes text through untouched, and it
 * arrives on stdin.
 *
 * Only the heredoc's own closing newline is dropped; every other byte is the
 * brief. Empty stdin (or a terminal, which would block waiting for typing) is
 * a usage error, and nothing is sent.
 */
const STDIN_USAGE = {
  ask: `usage: cookrew ask "Agent" - <<'EOF'\n  your brief, any characters\nEOF\n(a lone - reads the brief from stdin, and stdin was empty)`,
  recruit: `usage: cookrew recruit ["Name"] --prompt - <<'EOF'\n  its first prompt, any characters\nEOF\n(--prompt - reads the prompt from stdin, and stdin was empty)`,
  role: `usage: cookrew role save "Agent" "RoleName" --prompt - <<'EOF'\n  the role text, any characters\nEOF\n(--prompt - reads the role text from stdin, and stdin was empty)`
}
function stdinSlotFor() {
  if (cmd === 'ask' && args[1] === '-' && flags.raw === undefined) return 'ask'
  if (flags.prompt !== '-') return null
  if (cmd === 'recruit') return 'recruit'
  if (cmd === 'role' && args[0] === 'save') return 'role'
  return null
}
const stdinSlot = stdinSlotFor()

async function readStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const brief = stdinSlot === null ? null : (await readStdin()).replace(/\r?\n$/, '')
if (brief !== null && brief.trim() === '') fail(STDIN_USAGE[stdinSlot], 1)
const requestArgs = stdinSlot === 'ask' ? [args[0], brief, ...args.slice(2)] : args
const promptFromStdin = stdinSlot === 'recruit' || stdinSlot === 'role'
const requestFlags = promptFromStdin ? { ...flags, prompt: brief } : flags

/**
 * `cookrew login` and `cookrew logout`: A CONVERSATION, NOT A REQUEST.
 *
 * Everything that decides anything is in the app (src/main/login-cli.ts). This
 * side is a printer and a keyboard: it prints `say`, reads what `ask`
 * describes, and sends the answer back, for as long as the app keeps asking.
 *
 * WHAT IS TYPED NEVER TOUCHES ARGV OR THE ENVIRONMENT. It is read from the
 * terminal here and leaves in the request's own `secret` field, which the app
 * takes off before anything else sees the request.
 *
 * THE TERMINAL STAYS RAW FOR THE WHOLE CONVERSATION. Not just while a prompt is
 * open: a key pressed in the gap between two prompts would otherwise be echoed
 * by the terminal itself, and a person retyping a password does not wait for
 * the prompt. Keys with no prompt open are dropped, so they cannot answer the
 * next question either. Ctrl-C therefore arrives as a byte, and is handled.
 *
 * ONE CONNECTION, because the conversation belongs to it: when this process
 * dies, however it dies, the app stops waiting and forgets the ladder.
 */
const CONVERSATIONS = new Set(['login', 'logout'])
const CTRL_C = '\x03'
const CTRL_D = '\x04'
const CTRL_U = '\x15'
const BACKSPACES = new Set(['\x7f', '\b'])
/** Arrow keys and paste markers: a terminal's own words, not part of an answer. */
const ESCAPES = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/g

let keyReader = null

function restoreTerminal() {
  if (!process.stdin.isTTY) return
  try {
    process.stdin.setRawMode(false)
  } catch {
    // The terminal has already gone.
  }
}

function leave() {
  process.stdout.write('\n')
  process.exit(130)
}

function startKeyboard() {
  process.on('exit', restoreTerminal)
  for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129]]) process.on(signal, () => process.exit(code))
  process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    if (chunk.includes(CTRL_C) || chunk.includes(CTRL_D)) leave()
    keyReader?.(chunk)
  })
  process.stdin.on('end', leave)
  process.stdin.resume()
}

/** One line from the keyboard. Hidden means not one character goes back to the screen. */
function readLine(prompt, hidden) {
  process.stdout.write(prompt)
  return new Promise((resolve) => {
    let typed = []
    keyReader = (chunk) => {
      for (const key of Array.from(chunk.replace(ESCAPES, ''))) {
        if (key === '\r' || key === '\n') {
          keyReader = null
          process.stdout.write('\n')
          resolve(typed.join(''))
          return
        }
        if (BACKSPACES.has(key)) {
          if (!hidden && typed.length > 0) process.stdout.write('\b \b')
          typed = typed.slice(0, -1)
        } else if (key === CTRL_U) {
          if (!hidden) process.stdout.write('\b \b'.repeat(typed.length))
          typed = []
        } else if (key >= ' ') {
          typed = [...typed, key]
          if (!hidden) process.stdout.write(key)
        }
      }
    }
  })
}

function readAsked(ask) {
  for (const option of ask.options ?? []) process.stdout.write(`  ${option.key}. ${option.label}\n`)
  return readLine(ask.prompt, ask.kind === 'hidden')
}

function openConversation(session) {
  const socket = net.createConnection(socketPath)
  const waiting = new Map()
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      let answer
      try {
        answer = JSON.parse(line)
      } catch {
        fail('Bad response from app')
      }
      waiting.get(answer.id)?.(answer)
      waiting.delete(answer.id)
    }
  })
  socket.on('error', (error) => fail(`Cannot reach the Cookrew app (${error.code ?? error.message}). Is it running?`))
  // Whatever was open: the conversation belongs to this connection, so nothing
  // typed after this could reach anyone.
  socket.on('close', () => fail('This sign-in ended: the Cookrew app went away, or nobody answered for ten minutes. Nothing more was sent. Run this again.'))
  const send = (verb, extra = {}) =>
    new Promise((resolve) => {
      const id = randomUUID()
      waiting.set(id, resolve)
      socket.write(
        JSON.stringify({
          id,
          terminalId,
          sessionId: session,
          cmd,
          args: [verb, ...(extra.args ?? [])],
          flags: extra.flags ?? {},
          ...(extra.secret === undefined ? {} : { secret: extra.secret })
        }) + '\n'
      )
    })
  return { send }
}

function turnOf(response) {
  if (!response.ok) fail(response.error ?? 'Unknown error', response.exitCode ?? 1)
  return JSON.parse(response.output)
}

/** The long wait for the other device, with c to go back for another rung. */
function waitOut(line, wait) {
  keyReader = (chunk) => {
    if (wait.other && /c/i.test(chunk)) {
      keyReader = null
      void line.send('stop')
    }
  }
  return line.send('wait').finally(() => {
    keyReader = null
  })
}

async function converse() {
  // Refused here, before a socket exists: the app must not be sent what was
  // just typed on a command line, and the value is not repeated either.
  // A bare `--password` on login asks for the password conversation in place of
  // the browser. With anything after it, that may be a password typed on a
  // command line, so it is refused as every other `--password…` is.
  const oldWay = cmd === 'login' && flags.password === true
  const passwordFlag = Object.keys(flags).some((key) => key.startsWith('password') && !(oldWay && key === 'password'))
  if (passwordFlag || args.length > (cmd === 'login' ? 1 : 0)) {
    fail(`usage: cookrew ${cmd === 'login' ? 'login [username] [--password]' : 'logout'} (the password is typed at a hidden prompt, never on the command line)`)
  }
  // GitHub says who this is, so a name beside the flag could only disagree.
  if (flags.github !== undefined && (cmd !== 'login' || args.length > 0 || oldWay)) {
    fail('usage: cookrew login --github (GitHub says who you are, so it takes no username and no password)')
  }
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true
  if (tty) startKeyboard()
  const line = openConversation(ancestorSessionId())
  let response = await line.send('open', {
    args,
    flags: {
      tty,
      ...(typeof flags.as === 'string' ? { as: flags.as } : {}),
      ...(flags.github === true ? { github: true } : {}),
      ...(oldWay ? { password: true } : {})
    }
  })
  for (;;) {
    const turn = turnOf(response)
    for (const sentence of turn.say) process.stdout.write(`${sentence}\n`)
    if (turn.exit !== undefined) process.exit(turn.exit)
    if (!turn.wait && !turn.ask) fail('Bad response from app')
    response = turn.wait
      ? await waitOut(line, turn.wait)
      : await line.send('answer', { secret: await readAsked(turn.ask) })
  }
}

if (CONVERSATIONS.has(cmd)) await converse()

/**
 * `cookrew remote on`: ASKED AT THE TERMINAL, AND NOTHING ELSE SAYS YES.
 *
 * The machine switch lets paired devices drive this screen, so it is turned on
 * by a person at a shell here, never by a Cookrew terminal (a paired device can
 * type into one) and never by a script with no terminal. The app checks the
 * same and refuses without `confirmed` (src/main/remote-cli.ts); this is where
 * a person gives it. A `--confirmed` typed on the command line is dropped:
 * only the answer at the prompt counts.
 */
async function remoteFlags() {
  if (args[0] !== 'on') return {}
  if (terminalId !== '') {
    fail('Turn remote control on from a shell on this machine, not from a Cookrew terminal: a paired device can type into a Cookrew terminal.')
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    fail('cookrew remote on asks before it turns anything on: run it in a terminal on this machine and confirm it there.')
  }
  process.stdout.write('Turn on remote control of this machine? Your paired devices can take control of a card for 15 minutes,\nand agents can click and type here, until you run cookrew remote off.\n')
  const { createInterface } = await import('node:readline/promises')
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  let answer = ''
  try {
    answer = await prompt.question('Type on to turn it on: ')
  } finally {
    prompt.close()
  }
  if (answer.trim().toLowerCase() !== 'on') fail('Remote control stays off.')
  return { confirmed: true }
}

const request = {
  id: randomUUID(),
  terminalId,
  sessionId: ancestorSessionId(),
  cmd,
  args: requestArgs,
  flags: cmd === 'remote' ? await remoteFlags() : requestFlags
}

// `cookrew mobile` also renders a QR code locally for the returned URL.
const wantQr = cmd === 'mobile'

const socket = net.createConnection(socketPath)
let buffer = ''

socket.on('connect', () => {
  socket.write(JSON.stringify(request) + '\n')
})

socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  const newline = buffer.indexOf('\n')
  if (newline === -1) return
  const line = buffer.slice(0, newline)
  let response
  try {
    response = JSON.parse(line)
  } catch {
    fail('Bad response from app')
    return
  }
  if (response.ok) {
    if (execTail !== null) {
      socket.end()
      const envName = `COOKREW_SECRET_${String(args[1] ?? '').toUpperCase().replace(/-/g, '_')}`
      const child = spawn(execTail[0], execTail.slice(1), {
        stdio: 'inherit',
        env: { ...process.env, [envName]: response.output ?? '' }
      })
      child.on('error', (error) => fail(`${execTail[0]}: ${error.message}`, 127))
      child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
      return
    }
    if (response.output) process.stdout.write(response.output + '\n')
    socket.end()
    if (wantQr && response.output) {
      const url = (response.output.match(/https?:\/\/\S+/) ?? [])[0]
      if (url) {
        import('qrcode-terminal')
          .then(({ default: qrcode }) => {
            qrcode.generate(url, { small: true }, (qr) => {
              process.stdout.write('\n' + qr + '\n')
              process.exit(0)
            })
          })
          .catch(() => process.exit(0))
        return
      }
    }
    process.exit(0)
  } else {
    socket.end()
    fail(response.error ?? 'Unknown error', response.exitCode ?? 1)
  }
})

socket.on('error', (error) => {
  fail(`Cannot reach the Cookrew app (${error.code ?? error.message}). Is it running?`)
})
