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
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
// TLS IS VERIFIED. This lane carries a stranger's Bearer token, their typed
// prompts and their payment reference to another person's machine over the
// public internet — an unverified certificate hands all three to anyone on
// the path. (orch-mirror.mjs may skip verification: it is a loopback mirror
// of the owner's OWN app behind a self-signed pairing cert. Not this.) A LAN
// door with a self-signed cert must opt in, loudly and per-run.
const insecureTls = process.env.COOKREW_LINE_INSECURE_TLS === '1'
const agent = new transport.Agent({
  keepAlive: true,
  ...(transport === https && insecureTls ? { rejectUnauthorized: false } : {})
})

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
      // A key another user can read is not this account's key. Refuse it out
      // loud rather than signing with it (the same rule the app's own
      // credential store keeps).
      const mode = statSync(file).mode & 0o077
      if (mode !== 0) {
        throw new Error(`${file} is readable by others — fix its permissions (chmod 600)`)
      }
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return { priv: createPrivateKey({ key: parsed.priv, format: 'jwk' }), jwk: parsed.pub }
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      /* absent or corrupt: try the next location, or mint */
    }
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ format: 'jwk' })
  const priv = privateKey.export({ format: 'jwk' })
  mkdirSync(keyDir, { recursive: true, mode: 0o700 })
  writeFileSync(keyFile, JSON.stringify({ pub, priv }), { mode: 0o600 })
  // `mode` on writeFileSync applies at CREATION only — an existing file keeps
  // whatever it had, so the private half is chmod'd unconditionally.
  chmodSync(keyFile, 0o600)
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
        ...(transport === https && insecureTls ? { rejectUnauthorized: false } : {}),
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
let signInAttempts = 0

const cols = () => process.stdout.columns || 100
const rows = () => process.stdout.rows || 30
const dim = (text) => `\x1b[2m${text}\x1b[0m\r\n`

function authHeaders() {
  return { authorization: `Bearer ${token}`, ...(payRef ? { 'x-payment': payRef } : {}) }
}

/**
 * One line of the caller's answer while the line is DOWN (the pay flow).
 * Drops to cooked mode to read it and restores whatever mode was in force —
 * leaving the terminal line-buffered would cost the agent TUI every arrow
 * key, Ctrl-C and Ctrl-] for the rest of the card's life.
 */
function readLine(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    const stdin = process.stdin
    const wasRaw = stdin.isTTY ? stdin.isRaw : false
    if (stdin.isTTY) stdin.setRawMode(false)
    stdin.resume()
    stdin.once('data', (data) => {
      if (stdin.isTTY && wasRaw) {
        try {
          stdin.setRawMode(true)
        } catch {
          /* ignore */
        }
      }
      resolve(String(data).trim())
    })
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
          // A door controls this stream. A non-string data frame would throw
          // inside the socket handler and kill the card — a one-line remote
          // DoS on the caller. Render only what a terminal can render.
          if (event === 'data') {
            if (typeof payload === 'string') process.stdout.write(payload)
          } else if (event === 'hello') void post('/line/resize', { cols: cols(), rows: rows() })
          else if (event === 'exit') process.stdout.write(dim('— the orch process exited —'))
        }
      })
      // end AND close both fire on a finished response. scheduleReconnect
      // latches, so one drop yields ONE reconnect — without the latch each
      // drop doubled the open lines and the caller saw every byte twice.
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
    // A door that keeps answering 401 while sign-in keeps answering 200 (clock
    // skew, a rotated issuer key) would otherwise loop at network speed —
    // three requests per turn, forever, against someone else's app. Two tries,
    // then fall back to the ordinary backoff.
    if (signInAttempts >= 2) {
      process.stdout.write(dim('✕ the door keeps refusing this sign-in — retrying slowly'))
      signInAttempts = 0
      scheduleReconnect(15000)
      return
    }
    signInAttempts += 1
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
  // Any other outcome means the credential was accepted; a later 401 is a
  // fresh problem, not a continuation of this one.
  signInAttempts = 0
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
  // Anything below is not a payment outcome, so a reference held from an
  // earlier quote is stale. Resending it on every reconnect would put a
  // payment identifier on the wire over and over for no possible benefit.
  payRef = ''
  if (status === 429) {
    process.stdout.write(dim(`✕ ${body?.error ?? 'the door is over its budget'}`))
    scheduleReconnect(5000)
    return
  }
  process.stdout.write(dim(`✕ line refused (${status})${body?.error ? `: ${body.error}` : ''} — retrying`))
  scheduleReconnect(3000)
}

let reconnectPending = false
function scheduleReconnect(delay = 1200) {
  if (closed || reconnectPending) return
  reconnectPending = true
  lineUp = false
  setTimeout(() => {
    reconnectPending = false
    connectLine()
  }, delay)
}

/**
 * A POST on the input path, with ONE re-signin retry.
 *
 * The Bearer expires (an hour, call-credential.ts) while the already-open SSE
 * stream keeps flowing — so without this, output kept arriving and every
 * keystroke silently vanished into a 401 nobody read. Discarding the status
 * was the whole bug: a write that fails must either be retried or said out
 * loud, never dropped.
 */
async function post(pathname, body) {
  let res = await request('POST', pathname, { headers: authHeaders(), body })
  if (res.status === 401 || res.status === 403) {
    try {
      token = await signIn()
    } catch (error) {
      process.stdout.write(dim(`✕ ${error.message}`))
      return res
    }
    res = await request('POST', pathname, { headers: authHeaders(), body })
  }
  if (res.status === 404) {
    // The session behind this line is gone (ended, or expired at the door).
    // Reconnecting re-admits through the ladder rather than typing into air.
    process.stdout.write(dim('— the session at the door ended; reopening the line —'))
    scheduleReconnect(500)
  } else if (res.status !== 200 && res.status !== 0) {
    process.stdout.write(dim(`✕ keystrokes refused (${res.status})`))
  }
  return res
}

let rawWired = false
function wireRawInput() {
  const stdin = process.stdin
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return
  // Raw mode is (re)asserted every time the line comes up — the listener is
  // attached once. A pay prompt between two connections drops to cooked mode,
  // and a one-shot latch over BOTH would never restore it.
  try {
    stdin.setRawMode(true)
  } catch {
    return
  }
  if (rawWired) return
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
