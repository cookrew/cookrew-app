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

// THE ACCOUNT KEY IS FILED BY THE DOOR'S IDENTITY, not by its address.
//
// The account is bound at the door to (serviceId, sub). Filing the key by
// address — as this did — mints a DIFFERENT key for the same account name the
// moment the same team is reached by loopback instead of its LAN address, or
// later by a domain; TOFU then refuses that second key forever, and the card
// can never sign in again. The serviceId is the part that does not move.
// The address-named files are still tried (see signIn) so an account enrolled
// under the old scheme keeps working, and is promoted on first success.
// MUST match src/main/caller-identity.ts — the app and this card sign in as
// the same account, or the session paid for is not the session opened.
const host = base.host.replace(/[^a-z0-9.-]/gi, '_')
const keyDir = path.join(homedir(), '.cookrew', 'caller-keys')
const keyFileFor = (serviceId) =>
  path.join(keyDir, `${(serviceId.replace(/[^a-z0-9._-]/gi, '_').slice(0, 96) || 'unknown-service')}.json`)
const legacyKeyFiles = [
  path.join(keyDir, `${host}-${slug}.json`),
  path.join(homedir(), '.cookrew', 'crew-keys', `${host}-${slug}.json`)
]

function readKey(file) {
  try {
    // A key another user can read is not this account's key. Refuse it out
    // loud rather than signing with it (the same rule the app's own
    // credential store keeps).
    if ((statSync(file).mode & 0o077) !== 0) {
      throw new Error(`${file} is readable by others — fix its permissions (chmod 600)`)
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return { priv: createPrivateKey({ key: parsed.priv, format: 'jwk' }), jwk: parsed.pub }
  } catch {
    return null
  }
}

function saveKey(serviceId, raw) {
  mkdirSync(keyDir, { recursive: true, mode: 0o700 })
  const file = keyFileFor(serviceId)
  writeFileSync(file, JSON.stringify(raw), { mode: 0o600 })
  // `mode` on writeFileSync applies at CREATION only — an existing file keeps
  // whatever it had, so the private half is chmod'd unconditionally.
  chmodSync(file, 0o600)
}

function mintKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ format: 'jwk' })
  const priv = privateKey.export({ format: 'jwk' })
  return { priv: createPrivateKey({ key: priv, format: 'jwk' }), jwk: pub, raw: { pub, priv } }
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
  const face = await request('GET', '/crew')
  const serviceId = face.body?.serviceId ?? ''
  if (!serviceId) throw new Error('this door did not say who it is')

  // One attempt with one key. A fresh challenge each time — they are spent.
  const attempt = async ({ priv, jwk }) => {
    const ch = await request('POST', '/api/call/challenge')
    if (ch.status !== 200) throw new Error(`no challenge (${ch.status}) — is the team still serving?`)
    const payload = Buffer.from(`cookrew-call/1\n${serviceId}\n${sub}\n${ch.body.challenge}`, 'utf8')
    const signature = sign(null, payload, priv).toString('base64url')
    const res = await request('POST', '/api/call/assert', {
      body: { sub, challenge: ch.body.challenge, signature, jwk }
    })
    return res.status === 200 ? res.body.token : null
  }

  const canonical = keyFileFor(serviceId)
  for (const file of [canonical, ...legacyKeyFiles]) {
    const key = readKey(file)
    if (!key) continue
    const token = await attempt(key)
    if (token === null) continue
    // Promote whichever key this account actually is, so the address-named
    // file is never consulted again.
    if (file !== canonical) saveKey(serviceId, { pub: key.jwk, priv: key.priv.export({ format: 'jwk' }) })
    return token
  }

  const minted = mintKey()
  const token = await attempt(minted)
  if (token === null) {
    throw new Error('sign-in refused — this name already belongs to another key at this door')
  }
  saveKey(serviceId, minted.raw)
  return token
}

let token = ''
let closed = false
let lineUp = false
/** Were we EVER admitted? Decides which refusal a later 402 actually is. */
let everUp = false
let signInAttempts = 0

const cols = () => process.stdout.columns || 100
const rows = () => process.stdout.rows || 30
const dim = (text) => `\x1b[2m${text}\x1b[0m\r\n`

/**
 * THIS CARD CARRIES NO MONEY. There is no x-payment here and no way to put one
 * here: a session is paid for in the gate sheet before the card is placed, so
 * everything this process needs is the account credential.
 */
function authHeaders() {
  return { authorization: `Bearer ${token}` }
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
      // Sticky: it is what lets a later refusal tell "your session ended"
      // from "this door charges and you never had one".
      everUp = true
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
    // MONEY IS NEVER ASKED FOR HERE. A terminal prompt for a pasted payment
    // reference is not the product: paying is one surface, the gate sheet,
    // where the terms, the rails and the wallet are laid out before anything
    // is approved (docs/design/gate-sheet-unified.html).
    //
    // WHICH 402 THIS IS depends on whether we were ever admitted. Having been
    // up and now being asked to pay means the session ENDED at the author's
    // app — and that is a different sentence from "this door charges", said
    // in two tenses so the person knows what survived.
    if (everUp) {
      process.stdout.write(dim(`— the session ended at @${slug}'s app`))
      process.stdout.write(dim('  Nothing you typed was lost — the reply before it completed.'))
      process.stdout.write(dim('  Import it again in Cookrew to start a new one.'))
      stopRetrying()
      return
    }
    process.stdout.write(dim('◈ this team charges per session — import it again in Cookrew to pay'))
    scheduleReconnect(15000)
    return
  }
  if (status === 404) {
    // The door is not there. Not an error and not the caller's fault, so it
    // is said plainly and the line stops knocking — an address that starts
    // serving again is something a person re-imports, not something this
    // process should poll for forever.
    process.stdout.write(dim(`— @${slug} is not serving this team`))
    process.stdout.write(dim('  Nothing was charged. The address works again if they start it.'))
    stopRetrying()
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

/**
 * Stop reconnecting, and stay on screen.
 *
 * A card that vanished — or one that silently retried forever — would leave
 * someone who paid unable to tell "ended" from "flaky network". The process
 * stays alive so the last words remain readable in the card.
 */
function stopRetrying() {
  closed = true
  lineUp = false
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
