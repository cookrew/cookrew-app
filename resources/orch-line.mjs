#!/usr/bin/env node
/**
 * ORCH LINE — the imported team's interface card (caller side).
 *
 * Importing a served team places ONE card: the orch of the session workspace
 * minted for you at the author's app. This process is that card's transport —
 * the same PTY-direct mirror a local import gets from orch-mirror.mjs, behind
 * the served door's gate instead of the pairing token:
 *
 *   sign in   POST /<slug>/api/call/challenge + /api/call/assert (TOFU:
 *             the first sign-in IS the sign-up; ed25519 key kept at
 *             ~/.cookrew/caller-keys/<host>-<slug>.json, 0600)
 *   mirror    GET  /<slug>/line   (SSE: hello geometry, data = faithful ANSI)
 *   type      POST /<slug>/line/raw    — real keystrokes, byte for byte
 *   size      POST /<slug>/line/resize
 *
 * Opening the line IS session admission: a paid door answers 402 with its
 * terms once, at session start. The terms print here and a payment reference
 * can be supplied interactively; asks are never interrupted for money (R5).
 *
 *   node orch-line.mjs --origin http://host:8639 --slug research-crew
 *        [--name label] [--sub name]
 */
import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'

const arg = (name, fallback = undefined) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : fallback
}
const origin = arg('origin')
const slug = arg('slug')
if (!origin || !slug) {
  console.error('usage: orch-line --origin <http://host:port> --slug <slug> [--name label]')
  process.exit(2)
}
const label = arg('name', slug)
const sub = arg('sub', userInfo().username || 'caller')
const base = new URL(origin)
const transport = base.protocol === 'https:' ? https : http
const agent = new transport.Agent({ keepAlive: true, ...(transport === https ? { rejectUnauthorized: false } : {}) })

// The account key: one per door, created on first boot, survives restarts.
// Falls back to reading the retired crew-keys path so an account made before
// the rename keeps its name at the door (the pubkey IS the account).
const host = base.host.replace(/[^a-z0-9.-]/gi, '_')
const keyDir = path.join(homedir(), '.cookrew', 'caller-keys')
const keyFile = path.join(keyDir, `${host}-${slug}.json`)
const legacyKeyFile = path.join(homedir(), '.cookrew', 'crew-keys', `${host}-${slug}.json`)

function loadOrCreateKey() {
  for (const file of [keyFile, legacyKeyFile]) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return { priv: createPrivateKey({ key: parsed.priv, format: 'jwk' }), jwk: parsed.pub }
    } catch {
      /* try the next location, or mint */
    }
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ format: 'jwk' })
  const priv = privateKey.export({ format: 'jwk' })
  mkdirSync(keyDir, { recursive: true })
  writeFileSync(keyFile, JSON.stringify({ pub, priv }), { mode: 0o600 })
  return { priv: createPrivateKey({ key: priv, format: 'jwk' }), jwk: pub }
}

function request(method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = transport.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: `/${slug}${pathname}`,
        method,
        agent,
        headers: {
          ...headers,
          ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {})
        }
      },
      (res) => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (buf += chunk))
        res.on('end', () => {
          let parsed = null
          try {
            parsed = JSON.parse(buf)
          } catch {
            parsed = null
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed })
        })
      }
    )
    req.on('error', () => resolve({ status: 0, headers: {}, body: null }))
    if (data) req.write(data)
    req.end()
  })
}

async function signIn() {
  const { priv, jwk } = loadOrCreateKey()
  const ch = await request('POST', '/api/call/challenge')
  if (ch.status !== 200) throw new Error(`no challenge (${ch.status}) — is the team still serving?`)
  const face = await request('GET', '/crew')
  const serviceId = face.body?.serviceId ?? ''
  const payload = Buffer.from(`cookrew-call/1\n${serviceId}\n${sub}\n${ch.body.challenge}`, 'utf8')
  const signature = sign(null, payload, priv).toString('base64url')
  const res = await request('POST', '/api/call/assert', {
    body: { sub, challenge: ch.body.challenge, signature, jwk }
  })
  if (res.status !== 200) throw new Error('sign-in refused — this name may belong to another key')
  return res.body.token
}

let token = ''
let payRef = ''
let closed = false
let lineUp = false

const cols = () => process.stdout.columns || 100
const rows = () => process.stdout.rows || 30
const dim = (text) => `\x1b[2m${text}\x1b[0m\r\n`

function authHeaders() {
  return { authorization: `Bearer ${token}`, ...(payRef ? { 'x-payment': payRef } : {}) }
}

/** One line of the caller's answer while the line is down (pay flow). */
function readLine(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    const stdin = process.stdin
    if (stdin.isTTY) stdin.setRawMode(false)
    stdin.resume()
    stdin.once('data', (data) => resolve(String(data).trim()))
  })
}

function connectLine() {
  const req = transport.request(
    {
      hostname: base.hostname,
      port: base.port,
      path: `/${slug}/line`,
      method: 'GET',
      agent,
      headers: { ...authHeaders(), accept: 'text/event-stream', 'accept-encoding': 'identity' }
    },
    (res) => {
      if (res.statusCode !== 200) {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (buf += chunk))
        res.on('end', () => void handleLineRefusal(res.statusCode ?? 0, buf))
        return
      }
      lineUp = true
      // The x-payment reference is spent at session start, never resent.
      payRef = ''
      wireRawInput()
      res.setEncoding('utf8')
      let buf = ''
      res.on('data', (chunk) => {
        buf += chunk
        let sep
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          if (!block || block.startsWith(':')) continue
          let event = 'message'
          let dataLine = ''
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLine += line.slice(5).trim()
          }
          if (!dataLine) continue
          let payload
          try {
            payload = JSON.parse(dataLine)
          } catch {
            continue
          }
          if (event === 'data') process.stdout.write(payload)
          else if (event === 'hello') void post('/line/resize', { cols: cols(), rows: rows() })
          else if (event === 'exit') process.stdout.write(dim('— the orch process exited —'))
        }
      })
      res.on('end', () => scheduleReconnect())
      res.on('close', () => scheduleReconnect())
    }
  )
  req.on('error', () => scheduleReconnect())
  req.end()
}

async function handleLineRefusal(status, rawBody) {
  let body = null
  try {
    body = JSON.parse(rawBody)
  } catch {
    body = null
  }
  if (status === 401) {
    try {
      token = await signIn()
      connectLine()
      return
    } catch (error) {
      process.stdout.write(dim(`✕ ${error.message}`))
      scheduleReconnect(3000)
      return
    }
  }
  if (status === 402) {
    if (body?.terms) {
      const accepts = Array.isArray(body.terms?.accepts) ? body.terms.accepts[0] : null
      const price = accepts ? `${accepts.maxAmountRequired ?? ''} ${accepts.asset ?? ''}` : ''
      process.stdout.write(dim(`◈ this team charges per session${price ? ` — ${price}` : ''}`))
      const answer = await readLine('  paste a payment reference (or Enter to retry): ')
      if (answer) payRef = answer
      connectLine()
      return
    }
    process.stdout.write(
      body?.reason === 'invalid'
        ? dim("✕ that payment didn't verify — nothing was charged. Check the reference.")
        : dim('◔ our checker is unreachable — your payment may be fine; try again shortly.')
    )
    if (body?.reason === 'invalid') payRef = ''
    scheduleReconnect(3000)
    return
  }
  if (status === 429) {
    process.stdout.write(dim(`✕ ${body?.error ?? 'the door is over its budget'}`))
    scheduleReconnect(5000)
    return
  }
  process.stdout.write(dim(`✕ line refused (${status})${body?.error ? `: ${body.error}` : ''} — retrying`))
  scheduleReconnect(3000)
}

function scheduleReconnect(delay = 1200) {
  if (closed) return
  lineUp = false
  setTimeout(connectLine, delay)
}

function post(pathname, body) {
  return request('POST', pathname, { headers: authHeaders(), body })
}

let rawWired = false
function wireRawInput() {
  if (rawWired) return
  const stdin = process.stdin
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return
  try {
    stdin.setRawMode(true)
  } catch {
    return
  }
  rawWired = true
  stdin.resume()
  stdin.setEncoding('utf8')
  stdin.on('data', (data) => {
    // Ctrl-] detaches the line without ending the session at the door.
    if (data === '\x1d') {
      cleanup()
      process.exit(0)
    }
    if (lineUp) void post('/line/raw', { data })
  })
}

const keepAlive = setInterval(() => {}, 1 << 30)
function cleanup() {
  closed = true
  clearInterval(keepAlive)
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false)
  } catch {
    /* ignore */
  }
}
process.on('SIGINT', () => {
  cleanup()
  process.exit(0)
})
process.stdout.on('resize', () => {
  if (lineUp) void post('/line/resize', { cols: cols(), rows: rows() })
})

async function main() {
  process.stdout.write(dim(`── line → ${label} · ${origin}/${slug}`))
  token = await signIn()
  process.stdout.write(dim(`✓ signed in as ${sub} — opening the line…`))
  connectLine()
}

main().catch((err) => {
  console.error(`✕ ${err.message}`)
  process.exit(1)
})
