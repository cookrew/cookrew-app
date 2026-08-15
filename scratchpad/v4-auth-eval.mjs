#!/usr/bin/env -S node_modules/.bin/vite-node

// V4 G4 LIVE AUTH GATE — the acceptance bar for wave-B gate wiring.
//
// Run:
//   node_modules/.bin/vite-node scratchpad/v4-auth-eval.mjs
//
// This is intentionally stricter than the legacy pairing gate. It goes GREEN
// only when the running app enforces the v4 order and deny-by-default policy on
// HTTP and WS. Wall writes are reported MIGRATION-PENDING while they still 401;
// the target is 403 because the credential is known but read-only.

import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isIP } from 'node:net'
import path from 'node:path'
import tls from 'node:tls'

const BASE = process.env.COOKREW_EVAL_BASE ?? 'https://127.0.0.1:8643'
const TOKEN_RE = /token=[A-Za-z0-9_-]+/g
let PAIRING = ''
let WALL = ''

function redact(value) {
  let text = String(value)
    .replace(TOKEN_RE, 'token=REDACTED')
    .replace(/Bearer\s+[A-Za-z0-9_-]+/g, 'Bearer REDACTED')
  if (PAIRING) text = text.split(PAIRING).join('REDACTED')
  if (WALL) text = text.split(WALL).join('REDACTED')
  return text
}

const say = (value = '') => console.log(redact(value))

function acquirePairingToken() {
  const output = execFileSync('node', ['cli/cookrew.mjs', 'mobile'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  const match = output.match(/token=([A-Za-z0-9_-]+)/)
  if (!match) throw new Error('could not obtain pairing token from `cookrew mobile`')
  return match[1]
}

function acquireWallToken() {
  const token = readFileSync(path.join(homedir(), '.cookrew', 'wall-token'), 'utf8').trim()
  if (!token) throw new Error('read-only token file is empty')
  return token
}

function httpRequest(method, route, token, body) {
  const marker = '\n__V4_STATUS__:'
  const args = ['-skS', '--max-time', '20', '-X', method, `${BASE}${route}`]
  if (token) args.push('-H', `Authorization: Bearer ${token}`)
  if (body !== undefined) {
    args.push('-H', 'content-type: application/json', '--data-binary', JSON.stringify(body))
  }
  args.push('-w', `${marker}%{http_code}`)
  const result = spawnSync('curl', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  const output = result.stdout ?? ''
  const split = output.lastIndexOf(marker)
  if (result.error || split < 0) {
    return { status: 0, body: null, transport: redact(result.stderr || result.error?.message || output).slice(0, 160) }
  }
  const status = Number(output.slice(split + marker.length).trim())
  const raw = output.slice(0, split)
  let parsed = null
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    parsed = raw
  }
  return { status, body: parsed, transport: '' }
}

function wsUpgrade(route, token) {
  return new Promise((resolve) => {
    const target = new URL(BASE)
    const socket = tls.connect({
      host: target.hostname,
      port: Number(target.port || 443),
      rejectUnauthorized: false,
      ...(isIP(target.hostname) ? {} : { servername: target.hostname })
    })
    let settled = false
    let raw = ''
    const finish = (status, detail) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve({ status, detail })
    }
    const timer = setTimeout(() => finish(0, 'timeout/no HTTP response'), 5_000)
    socket.once('secureConnect', () => {
      const headers = [
        `GET ${route} HTTP/1.1`,
        `Host: ${target.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13'
      ]
      if (token) headers.push(`Authorization: Bearer ${token}`)
      socket.write(`${headers.join('\r\n')}\r\n\r\n`)
    })
    socket.on('data', (chunk) => {
      raw += chunk.toString('latin1')
      if (!raw.includes('\r\n')) return
      const first = raw.slice(0, raw.indexOf('\r\n'))
      const match = first.match(/^HTTP\/1\.1\s+(\d{3})/)
      if (match) finish(Number(match[1]), first)
    })
    socket.once('error', (error) => finish(0, `socket error: ${error.message}`))
    socket.once('close', () => finish(0, 'connection closed without HTTP response'))
  })
}

const results = []
function report(id, label, actual, target, ok, mode = '') {
  const status = mode === 'migration' && !ok ? 'MIGRATION-PENDING' : ok ? 'PASS' : 'FAIL'
  results.push({ id, label, actual, target, ok, status })
  say(`  ${status.padEnd(17)} ${id}  ${label}  — actual=${actual} target=${target}`)
}

async function run() {
  say('V4 G4 LIVE AUTH GATE — ordered, deny-by-default HTTP + WS matrix')
  PAIRING = acquirePairingToken()
  WALL = acquireWallToken()
  const garbage = 'x'.repeat(Math.max(PAIRING.length, 24))
  say('  pairing token=REDACTED; wall token=REDACTED; garbage token=REDACTED')

  const workspaceView = httpRequest('GET', '/api/workspaces', PAIRING)
  const activeId = workspaceView.body?.activeId
  const active = workspaceView.body?.workspaces?.find((workspace) => workspace.id === activeId)
  if (workspaceView.status !== 200 || !activeId || !active?.serviceState) {
    throw new Error(`cannot establish safe same-state write target: status=${workspaceView.status}`)
  }
  const safeWrite = `/api/workspaces/${encodeURIComponent(activeId)}/service`
  const safeBody = { state: active.serviceState }
  const unknown = `/api/v4-unclassified-${Date.now().toString(36)}`
  const missingAgent = '00000000-0000-4000-8000-000000000000'

  const cases = [
    { id: 'A01', label: 'public auth/status, no token', method: 'GET', route: '/api/auth/status', token: '', want: 200, verify: (r) => r.body?.scope === 'none' },
    { id: 'A02', label: 'public auth/status, garbage token', method: 'GET', route: '/api/auth/status', token: garbage, want: 200, verify: (r) => r.body?.scope === 'none' },
    { id: 'A03', label: 'public auth/status, pairing token', method: 'GET', route: '/api/auth/status', token: PAIRING, want: 200, verify: (r) => r.body?.scope === 'pairing' },
    { id: 'A04', label: 'public auth/status, wall token', method: 'GET', route: '/api/auth/status', token: WALL, want: 200, verify: (r) => r.body?.scope === 'read-only' },
    { id: 'A05', label: 'observe GET, no token', method: 'GET', route: '/api/workspaces', token: '', want: 401 },
    { id: 'A06', label: 'observe GET, garbage token', method: 'GET', route: '/api/workspaces', token: garbage, want: 401 },
    { id: 'A07', label: 'observe GET, wall token', method: 'GET', route: '/api/workspaces', token: WALL, want: 200 },
    { id: 'A08', label: 'observe GET, pairing token', method: 'GET', route: '/api/workspaces', token: PAIRING, want: 200 },
    { id: 'A09', label: 'board GET, pairing token', method: 'GET', route: '/api/board', token: PAIRING, want: 200 },
    { id: 'A10', label: 'events GET, pairing token', method: 'GET', route: '/api/events/query', token: PAIRING, want: 200 },
    { id: 'A11', label: 'write, no token', method: 'POST', route: safeWrite, token: '', body: safeBody, want: 401 },
    { id: 'A12', label: 'write, garbage token', method: 'POST', route: safeWrite, token: garbage, body: safeBody, want: 401 },
    { id: 'A13', label: 'write, known wall token', method: 'POST', route: safeWrite, token: WALL, body: safeBody, want: 403, migration: true },
    { id: 'A14', label: 'write, pairing token', method: 'POST', route: safeWrite, token: PAIRING, body: safeBody, want: 200 },
    { id: 'A15', label: 'dispatch, no token before existence', method: 'POST', route: `/api/agents/${missingAgent}/dispatch`, token: '', body: { brief: 'unused' }, want: 401 },
    { id: 'A16', label: 'dispatch, garbage before existence', method: 'POST', route: `/api/agents/${missingAgent}/dispatch`, token: garbage, body: { brief: 'unused' }, want: 401 },
    { id: 'A17', label: 'dispatch, wall out-of-group', method: 'POST', route: `/api/agents/${missingAgent}/dispatch`, token: WALL, body: { brief: 'unused' }, want: 403, migration: true },
    { id: 'A18', label: 'unclassified GET, no token', method: 'GET', route: unknown, token: '', want: 401 },
    { id: 'A19', label: 'unclassified GET, garbage token', method: 'GET', route: unknown, token: garbage, want: 401 },
    { id: 'A20', label: 'unclassified GET, wall token', method: 'GET', route: unknown, token: WALL, want: 403 },
    { id: 'A21', label: 'unclassified GET, pairing token', method: 'GET', route: unknown, token: PAIRING, want: 403 },
    { id: 'A22', label: 'unclassified POST, no token', method: 'POST', route: unknown, token: '', body: {}, want: 401 },
    { id: 'A23', label: 'unclassified POST, garbage token', method: 'POST', route: unknown, token: garbage, body: {}, want: 401 },
    { id: 'A24', label: 'unclassified POST, wall token', method: 'POST', route: unknown, token: WALL, body: {}, want: 403, migration: true },
    { id: 'A25', label: 'unclassified POST, pairing token', method: 'POST', route: unknown, token: PAIRING, body: {}, want: 403 }
  ]

  for (const test of cases) {
    const response = httpRequest(test.method, test.route, test.token, test.body)
    const ok = response.status === test.want && (test.verify ? test.verify(response) : true)
    report(test.id, test.label, response.status, test.want, ok, test.migration ? 'migration' : '')
  }

  const wsRoute = `/api/browser/v4-auth-${Date.now().toString(36)}/stream`
  const wsCases = [
    { id: 'A26', label: 'WS stream, no token rejected', token: '', target: 'reject', accept: (status) => status !== 101 },
    { id: 'A27', label: 'WS stream, garbage rejected', token: garbage, target: 'reject', accept: (status) => status !== 101 },
    { id: 'A28', label: 'WS stream, wall out-of-group rejected', token: WALL, target: 'reject', accept: (status) => status !== 101 },
    { id: 'A29', label: 'WS stream, pairing admitted', token: PAIRING, target: 101, accept: (status) => status === 101 }
  ]
  for (const test of wsCases) {
    const response = await wsUpgrade(wsRoute, test.token)
    report(test.id, test.label, response.status || response.detail, test.target, test.accept(response.status))
  }

  const failed = results.filter((result) => !result.ok)
  const pending = results.filter((result) => result.status === 'MIGRATION-PENDING')
  say(`\n  ${results.length - failed.length}/${results.length} target checks passed; migration-pending=${pending.length}`)
  for (const failure of failed) say(`  failing: ${failure.id} ${failure.label} — actual=${failure.actual} target=${failure.target}`)
  say(`\nV4 G4 LIVE AUTH GATE: ${failed.length === 0 ? 'PASS' : 'FAIL'}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error(redact(`V4 G4 LIVE AUTH GATE ERROR: ${error?.message ?? error}`))
  process.exit(2)
})
