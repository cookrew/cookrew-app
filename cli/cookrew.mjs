#!/usr/bin/env node
// cookrew — CLI bridge into the Cookrew app over its Unix socket.
// Verbs: list, ask, check, note, browser,
// connect, recruit, dismiss, preset, notify, help.
import net from 'node:net'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import process from 'node:process'

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
 * The tmpdir guess is kept as a last resort for an app too old to publish.
 */
function readSocketPointer() {
  try {
    const value = readFileSync(path.join(homedir(), '.cookrew', 'socket'), 'utf8').trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

const socketPath =
  process.env.COOKREW_SOCKET ??
  readSocketPointer() ??
  path.join(tmpdir(), 'cookrew-runtime', 'cookrew.sock')

const { cmd, args, flags } = parseArgv(process.argv.slice(2))
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

// `preset list` / `note read` style subcommands stay in args; flags are --key [value].
function parseArgv(argv) {
  const args = []
  const flags = {}
  let cmd = null
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
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
const request = { id: randomUUID(), terminalId, sessionId: ancestorSessionId(), cmd, args, flags }

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
