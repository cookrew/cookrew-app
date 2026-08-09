#!/usr/bin/env node
// cookrew — CLI bridge into the Cookrew app over its Unix socket.
// Verbs: list, ask, check, note, browser,
// connect, recruit, dismiss, preset, notify, help.
import net from 'node:net'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import process from 'node:process'

function fail(message) {
  process.stderr.write(`cookrew: ${message}\n`)
  process.exit(1)
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

const request = { id: randomUUID(), terminalId, cmd, args, flags }

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
    fail(response.error ?? 'Unknown error')
  }
})

socket.on('error', (error) => {
  fail(`Cannot reach the Cookrew app (${error.code ?? error.message}). Is it running?`)
})
