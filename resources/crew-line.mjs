#!/usr/bin/env node
/**
 * CREW LINE — the placed orch card's process (import side, M1).
 *
 * One remote crew, one line: this REPL signs in to a served crew (TOFU — the
 * first sign-in IS the sign-up), then turns every line you type into
 * POST /ask and prints the reply. The whole team runs at the author's app;
 * this terminal is the door.
 *
 *   node crew-line.mjs --origin http://host:8639 --slug research-crew \
 *        [--sub name]
 *
 * The sign-in keypair lives at ~/.cookrew/crew-keys/<host>-<slug>.json (0600),
 * created on first boot — your account at that crew survives restarts. On a
 * 402 the terms print and `/pay <tx-ref>` applies X-Payment to the next ask.
 */
import { createInterface } from 'node:readline'
import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'

const arg = (name, fallback = undefined) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : fallback
}
const origin = arg('origin')
const slug = arg('slug')
if (!origin || !slug) {
  console.error('usage: crew-line --origin <http://host:port> --slug <slug>')
  process.exit(2)
}
const sub = arg('sub', userInfo().username || 'caller')
let payRef = ''
const paymentUnavailableCopy = arg(
  'payment-unavailable-copy',
  "this crew can't take payment right now — nothing was charged; try later"
)
const paymentUnverifiableCopy = arg(
  'payment-unverifiable-copy',
  'our checker is unreachable — your payment may be fine; try again shortly.'
)

const keyDir = path.join(homedir(), '.cookrew', 'crew-keys')
const keyFile = path.join(keyDir, `${new URL(origin).host.replace(/[^a-z0-9.-]/gi, '_')}-${slug}.json`)

function loadOrCreateKey() {
  try {
    const parsed = JSON.parse(readFileSync(keyFile, 'utf8'))
    return { priv: createPrivateKey({ key: parsed.priv, format: 'jwk' }), jwk: parsed.pub }
  } catch {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pub = publicKey.export({ format: 'jwk' })
    const priv = privateKey.export({ format: 'jwk' })
    mkdirSync(keyDir, { recursive: true })
    writeFileSync(keyFile, JSON.stringify({ pub, priv }), { mode: 0o600 })
    return { priv: createPrivateKey({ key: priv, format: 'jwk' }), jwk: pub }
  }
}

const api = async (pathname, options = {}) => {
  const res = await fetch(`${origin}/${slug}${pathname}`, {
    method: options.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, headers: res.headers, body }
}

async function signIn() {
  const { priv, jwk } = loadOrCreateKey()
  const ch = await api('/api/call/challenge')
  if (ch.status !== 200) throw new Error(`no challenge (${ch.status}) — is the crew still serving?`)
  const challenge = ch.body.challenge
  const face = await api('/crew', { method: 'GET' })
  const serviceId = face.body?.serviceId ?? ''
  const payload = Buffer.from(`cookrew-call/1\n${serviceId}\n${sub}\n${challenge}`, 'utf8')
  const signature = sign(null, payload, priv).toString('base64url')
  const res = await api('/api/call/assert', { body: { sub, challenge, signature, jwk } })
  if (res.status !== 200) throw new Error('sign-in refused — this name may belong to another key')
  return res.body.token
}

async function main() {
  process.stdout.write(`◫ ${slug} @ ${origin} — signing in as ${sub}…\n`)
  let token = await signIn()
  process.stdout.write(`✓ signed in. Type to talk to the crew. First reply can take a moment while the line warms.\n> `)

  const rl = createInterface({ input: process.stdin })
  for await (const line of rl) {
    const prompt = line.trim()
    if (prompt.length === 0) {
      process.stdout.write('> ')
      continue
    }
    if (prompt.startsWith('/pay ')) {
      payRef = prompt.slice(5).trim()
      process.stdout.write(`payment reference set — asking again applies it\n> `)
      continue
    }
    const headers = { authorization: `Bearer ${token}` }
    if (payRef) headers['x-payment'] = payRef
    let res = await api('/ask', { headers, body: { prompt } })
    if (res.status === 401) {
      token = await signIn()
      res = await api('/ask', { headers: { ...headers, authorization: `Bearer ${token}` }, body: { prompt } })
    }
    if (res.status === 402) {
      const terms = res.body?.terms
      if (terms) {
        process.stdout.write(
          `◈ this crew costs ${terms.amount} ${terms.asset} per session — type "/pay <tx-ref>" (dev) then ask again\n> `
        )
      } else if (res.body?.reason === 'invalid') {
        process.stdout.write(`✕ that payment didn't verify — nothing was charged. Check the reference.\n> `)
        payRef = ''
      } else {
        process.stdout.write(`◔ ${paymentUnverifiableCopy}\n> `)
      }
      continue
    }
    if (res.status === 503 && res.body?.reason === 'payment_unavailable') {
      // No quote existed, so no payment was sent and no checker was involved.
      process.stdout.write(`✕ ${paymentUnavailableCopy}\n> `)
      payRef = ''
      continue
    }
    if (res.status !== 200) {
      process.stdout.write(`✕ ${res.status}: ${JSON.stringify(res.body)}\n> `)
      continue
    }
    if (payRef) payRef = '' // spent at session start; never resent mid-conversation
    process.stdout.write(`${res.body.reply}\n> `)
  }
}

main().catch((err) => {
  console.error(`✕ ${err.message}`)
  process.exit(1)
})
