#!/usr/bin/env -S node_modules/.bin/vite-node

// V4 STEP 3 GATE — HTTP reach without attach or focus theft.
//
// Run:
//   node_modules/.bin/vite-node scratchpad/v4-step3-eval.mjs
//
// The dispatch is submitted exactly once. Completion is learned from the
// dispatch resource, never from a blocking CLI wait, and F2 is proved from the
// pane: the combined nonce is absent from the brief and must appear once only.

import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const BASE = process.env.COOKREW_EVAL_BASE ?? 'https://127.0.0.1:8643'
const GOAT_WORKSPACE = '74d86b39-a73e-4e34-b184-ecc7e12c12eb'
const CONDUCTOR_AGENT = 'd8bc2359-f8be-4abc-b685-696f084bb6c9'
const CONDUCTOR_PANE = 'w1:pV'
const DEADLINE_MS = 180_000
const POLL_MS = 2_000

const TOKEN_RE = /token=[A-Za-z0-9_-]+/g
let TOKEN = ''

function redact(value) {
  let text = String(value).replace(TOKEN_RE, 'token=REDACTED')
  if (TOKEN) text = text.split(TOKEN).join('REDACTED')
  return text.replace(/Bearer\s+[A-Za-z0-9_-]+/g, 'Bearer REDACTED')
}

const say = (value = '') => console.log(redact(value))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function acquireToken() {
  const output = execFileSync('node', ['cli/cookrew.mjs', 'mobile'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  const match = output.match(/token=([A-Za-z0-9_-]+)/)
  if (!match) throw new Error('could not obtain pairing token from `cookrew mobile`')
  return match[1]
}

function request(method, path, body) {
  const marker = '\n__V4_STATUS__:'
  const args = [
    '-skS', '--max-time', '25', '-X', method,
    `${BASE}${path}`,
    '-H', `Authorization: Bearer ${TOKEN}`,
    '-H', 'content-type: application/json'
  ]
  if (body !== undefined) args.push('--data-binary', JSON.stringify(body))
  args.push('-w', `${marker}%{http_code}`)
  const result = spawnSync('curl', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  const output = result.stdout ?? ''
  const split = output.lastIndexOf(marker)
  if (result.error || split < 0) {
    throw new Error(`HTTP ${method} ${path} failed: ${redact(result.stderr || result.error?.message || output).slice(0, 240)}`)
  }
  const status = Number(output.slice(split + marker.length).trim())
  const raw = output.slice(0, split)
  let json = null
  try {
    json = raw ? JSON.parse(raw) : null
  } catch {
    json = raw
  }
  return { status, body: json }
}

function paneText() {
  const result = spawnSync('herdr', ['pane', 'read', CONDUCTOR_PANE], {
    encoding: 'utf8',
    env: { ...process.env, HERDR_SESSION: 'cookrew' },
    maxBuffer: 32 * 1024 * 1024
  })
  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`
  try {
    const parsed = JSON.parse(raw)
    return parsed?.result?.text ?? parsed?.text ?? raw
  } catch {
    return raw
  }
}

function count(text, needle) {
  if (!needle) return 0
  return text.split(needle).length - 1
}

const results = []
function check(id, label, ok, detail = '') {
  results.push({ id, label, ok, detail })
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${label}${detail ? `  — ${detail}` : ''}`)
}

async function run() {
  say('V4 STEP 3 GATE — HTTP reach, correlated completion, no double-prompt')
  TOKEN = acquireToken()
  say('  token=REDACTED')

  const seed = `${Date.now().toString(36).toUpperCase()}${randomBytes(4).toString('hex').toUpperCase()}`
  const nonce = `V4G3${seed}`
  const splitAt = Math.floor(nonce.length / 2)
  const nonceA = nonce.slice(0, splitAt)
  const nonceB = nonce.slice(splitAt)
  const brief = [
    'Join the two quoted fragments and reply with only the joined text, with no spaces or punctuation.',
    `First fragment: "${nonceA}". Second fragment: "${nonceB}".`,
    'Do not run tools and do not add any other text.'
  ].join(' ')
  const idempotencyKey = `v4-step3-${nonce}`
  const T0 = Date.now()
  let restoreAttempted = false

  try {
    const before = request('GET', '/api/workspaces').body
    const workspaces = Array.isArray(before?.workspaces) ? before.workspaces : []
    const goat = workspaces.find((workspace) => workspace.id === GOAT_WORKSPACE)
    say(`  T0=${T0} nonce=${nonce}`)
    say(`  activeId at start: ${before?.activeId ?? 'missing'}`)
    check('C1a', 'GOAT workspace exists', !!goat, goat?.serviceState ?? 'missing')
    check('C1b', 'GOAT is not the focused workspace', before?.activeId !== GOAT_WORKSPACE, before?.activeId ?? 'missing')

    const hot = request('POST', `/api/workspaces/${GOAT_WORKSPACE}/service`, { state: 'hot' })
    check('C2', 'GOAT marked HOT over HTTP', hot.status === 200 && hot.body?.serviceState === 'hot', `status=${hot.status} state=${hot.body?.serviceState ?? 'missing'}`)

    const submitted = request('POST', `/api/agents/${CONDUCTOR_AGENT}/dispatch`, {
      brief,
      idempotencyKey
    })
    const dispatchId = typeof submitted.body?.dispatchId === 'string' ? submitted.body.dispatchId : ''
    check('C3a', 'dispatch accepted once', submitted.status === 202, `status=${submitted.status}`)
    check('C3b', '202 carries dispatchId', dispatchId.length > 0, dispatchId || 'missing')

    let record = null
    if (dispatchId) {
      const end = Date.now() + DEADLINE_MS
      while (Date.now() < end) {
        const observed = request('GET', `/api/dispatches/${encodeURIComponent(dispatchId)}`)
        if (observed.status === 200) record = observed.body
        if (record?.state === 'done' || record?.state === 'failed' || record?.state === 'interrupted') break
        await sleep(POLL_MS)
      }
    }
    check('C4a', 'dispatch reaches done', record?.state === 'done', `state=${record?.state ?? 'unseen'}`)
    check('C4b', 'done carries turnIndex', Number.isInteger(record?.turnIndex) && record.turnIndex >= 0, `turnIndex=${record?.turnIndex ?? 'missing'}`)
    check('C4c', 'done reports a reply exists', record?.hasReply === true, `hasReply=${record?.hasReply ?? 'missing'}`)
    const turnsResponse = request('GET', `/api/terminal/${CONDUCTOR_AGENT}/turns`)
    const ledgerTurns = Array.isArray(turnsResponse.body) ? turnsResponse.body : []
    const correlatedTurn = ledgerTurns.find((turn) => turn?.index === record?.turnIndex)
    const ledgerNonceCount = count(String(correlatedTurn?.reply ?? ''), nonce)
    check(
      'C4d',
      'correlated turn ledger reply carries nonce',
      turnsResponse.status === 200 && correlatedTurn !== undefined && ledgerNonceCount === 1,
      `status=${turnsResponse.status} turnIndex=${record?.turnIndex ?? 'missing'} replyNonceCount=${ledgerNonceCount}`
    )

    const transcript = paneText()
    const paneCount = count(transcript, nonce)
    check('C5', 'F2 pane nonce appears exactly once', paneCount === 1, `pane=${CONDUCTOR_PANE} count=${paneCount}`)

    const after = request('GET', '/api/workspaces').body
    check('C6', 'activeId stayed pinned', after?.activeId === before?.activeId, `${before?.activeId ?? 'missing'} -> ${after?.activeId ?? 'missing'}`)
    const switchedResponse = request('GET', `/api/events/query?type=workspace.switched&since=${T0}`)
    const switched = Array.isArray(switchedResponse.body)
      ? switchedResponse.body
      : Array.isArray(switchedResponse.body?.events) ? switchedResponse.body.events : []
    check('C7', 'zero workspace.switched events', switched.length === 0, `count=${switched.length}`)
  } finally {
    restoreAttempted = true
    try {
      const dormant = request('POST', `/api/workspaces/${GOAT_WORKSPACE}/service`, { state: 'dormant' })
      check('C8', 'GOAT restored DORMANT', dormant.status === 200 && dormant.body?.serviceState === 'dormant', `status=${dormant.status} state=${dormant.body?.serviceState ?? 'missing'}`)
    } catch (error) {
      check('C8', 'GOAT restored DORMANT', false, error?.message ?? String(error))
    }
  }

  if (!restoreAttempted) check('C8', 'GOAT restored DORMANT', false, 'restore not attempted')
  const failed = results.filter((result) => !result.ok)
  say(`\n  ${results.length - failed.length}/${results.length} checks passed`)
  for (const failure of failed) say(`  failing: ${failure.id} ${failure.label} — ${failure.detail}`)
  say(`\nV4 STEP 3 GATE: ${failed.length === 0 ? 'PASS' : 'FAIL'}`)
  process.exit(failed.length === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error(redact(`V4 STEP 3 GATE ERROR: ${error?.message ?? error}`))
  process.exit(2)
})
