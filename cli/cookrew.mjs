#!/usr/bin/env node
// cookrew — CLI bridge into the Cookrew app over its Unix socket.
// Verbs: list, ask, check, note, browser,
// connect, recruit, dismiss, preset, notify, help.
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import process from 'node:process'

const socketPath = process.env.COOKREW_SOCKET
const terminalId = process.env.COOKREW_TERMINAL_ID

function fail(message) {
  process.stderr.write(`cookrew: ${message}\n`)
  process.exit(1)
}

if (!socketPath) fail('COOKREW_SOCKET is not set — run this inside a Cookrew terminal')
if (!terminalId) fail('COOKREW_TERMINAL_ID is not set — run this inside a Cookrew terminal')

const { cmd, args, flags } = parseArgv(process.argv.slice(2))
if (!cmd) fail("No command given. Run 'cookrew help'.")

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
