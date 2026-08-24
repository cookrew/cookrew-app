#!/usr/bin/env node
// ORCH MIRROR — a proxy terminal to another agent, over the SAME API the
// cookrew mobile companion uses. It renders the target's transcript and
// forwards what you type, so a card in one workspace can talk to the
// orchestrator running in a served session's workspace.
//
//   node orch-mirror.mjs <terminalId> [--name <label>]
//
// Transport (mobile API, self-signed localhost cert):
//   READ  GET  <origin>/api/terminal/<id>/turns   -> TurnRecord[]
//   WRITE POST <origin>/api/terminal/<id>/input {text}
// Origin defaults to https://127.0.0.1:8643 (COOKREW_MOBILE_ORIGIN overrides).
// Auth is the persisted pairing token; TLS trust is handled by the launcher
// setting NODE_TLS_REJECT_UNAUTHORIZED=0 for this localhost hop only.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const id = process.argv[2]
const label = (() => {
  const i = process.argv.indexOf('--name')
  return i > 0 ? process.argv[i + 1] : id
})()
if (!id) {
  console.error('orch-mirror: no terminal id')
  process.exit(1)
}

const ORIGIN = (process.env.COOKREW_MOBILE_ORIGIN || 'https://127.0.0.1:8643').replace(/\/+$/, '')
const token = (() => {
  try {
    return readFileSync(path.join(homedir(), '.cookrew', 'pairing-token'), 'utf8').trim()
  } catch {
    return ''
  }
})()

const auth = token ? { Authorization: `Bearer ${token}` } : {}
const C = { dim: '\x1b[2m', reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m' }

const banner = () => {
  process.stdout.write(
    `${C.cyan}── mirror → ${label} ${C.dim}(${ORIGIN}/api/terminal/${id})${C.reset}\n` +
      `${C.dim}   type to talk to the orch · its transcript streams below${C.reset}\n\n`
  )
}

async function getTurns() {
  const res = await fetch(`${ORIGIN}/api/terminal/${encodeURIComponent(id)}/turns`, { headers: auth })
  if (!res.ok) throw new Error(`turns ${res.status}`)
  return res.json()
}

async function sendInput(text) {
  const res = await fetch(`${ORIGIN}/api/terminal/${encodeURIComponent(id)}/input`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  })
  if (res.status === 409) return { ok: false, reason: 'the orch has a dispatch in flight — try again' }
  if (!res.ok) return { ok: false, reason: `input ${res.status}` }
  return { ok: true }
}

// Render a turn once; a growing reply reprints only the delta.
const printed = new Map() // index -> reply length already shown
function render(turns) {
  for (const t of turns) {
    const seen = printed.get(t.index)
    if (seen === undefined) {
      if (t.prompt) process.stdout.write(`${C.yellow}› ${t.prompt}${C.reset}\n`)
      if (t.reply) process.stdout.write(t.reply)
      printed.set(t.index, (t.reply ?? '').length)
    } else if ((t.reply ?? '').length > seen) {
      process.stdout.write(t.reply.slice(seen))
      printed.set(t.index, t.reply.length)
    }
  }
}

let alive = true
async function poll() {
  while (alive) {
    try {
      render(await getTurns())
    } catch (err) {
      process.stdout.write(`${C.dim}[mirror: ${String(err.message ?? err)} — retrying]${C.reset}\n`)
    }
    await new Promise((r) => setTimeout(r, 1200))
  }
}

banner()
try {
  render(await getTurns())
} catch (err) {
  process.stdout.write(`${C.dim}[mirror: first read failed: ${String(err.message ?? err)}]${C.reset}\n`)
}
void poll()

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  void sendInput(text).then((r) => {
    if (!r.ok) process.stdout.write(`${C.dim}[mirror: ${r.reason}]${C.reset}\n`)
  })
})
rl.on('close', () => {
  alive = false
})
process.on('SIGINT', () => {
  alive = false
  process.exit(0)
})
