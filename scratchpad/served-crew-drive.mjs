#!/usr/bin/env node
/**
 * SERVED-CREW DRIVER — the caller's half of the gate, scripted.
 *
 * The QA fixture for the export/import journey: it does exactly what a placed
 * crew card does (public face → challenge → ed25519 assert → /ask), so a gate
 * regression shows up here in one command instead of a twenty-click UI drive.
 *
 *   node scratchpad/served-crew-drive.mjs <slug> [--pay REF] [--sub NAME]
 *                                        [--prompt TEXT] [--origin URL] [--twice]
 *
 * Exit code is 0 only when the crew ANSWERED with non-empty text — an empty
 * 200 is the shell-echo bug (see G1 in served-crew-brief.md) and must fail.
 */
import { generateKeyPairSync, sign } from 'node:crypto'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const slug = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true)
const origin = flag('origin', 'http://127.0.0.1:8639')
const sub = flag('sub', `drive-${process.pid}`)
const prompt = flag('prompt', 'Reply with exactly: CREW LINE OK')
const payRef = flag('pay', null)
const twice = args.includes('--twice')

if (!slug) {
  console.error('usage: served-crew-drive.mjs <slug> [--pay REF] [--sub NAME] [--prompt TEXT] [--twice]')
  process.exit(2)
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const jwk = publicKey.export({ format: 'jwk' })

const api = async (path, init = {}) => {
  const res = await fetch(`${origin}/${slug}${path}`, {
    method: init.method ?? 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: init.body
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const step = (label, status, detail) =>
  console.log(`${String(status).padEnd(4)} ${label.padEnd(22)} ${detail ?? ''}`)

const face = await api('/crew', { method: 'GET' })
if (face.status !== 200) {
  step('face', face.status, JSON.stringify(face.body))
  process.exit(1)
}
step('face', 200, `${face.body.name} · door=${face.body.door} · ${face.body.access}${face.body.priceUsd ? ` ${face.body.priceUsd}` : ''}`)

const challenge = await api('/api/call/challenge')
// The signing payload is fixed by call-ceremony.ts — keep the two in step.
const payload = `cookrew-call/1\n${face.body.serviceId}\n${sub}\n${challenge.body.challenge}`
const signature = sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url')
const asserted = await api('/api/call/assert', {
  body: JSON.stringify({ sub, challenge: challenge.body.challenge, signature, jwk })
})
if (asserted.status !== 200) {
  step('sign-in', asserted.status, JSON.stringify(asserted.body))
  process.exit(1)
}
step('sign-in', 200, `as ${sub}`)

const auth = { authorization: `Bearer ${asserted.body.token}` }
const ask = (text, extra = {}) =>
  api('/ask', { headers: { ...auth, ...extra }, body: JSON.stringify({ prompt: text }) })

let answer = await ask(prompt)
if (answer.status === 402) {
  const terms = answer.body?.terms
  step('quote', 402, `${terms?.amount} ${terms?.asset} on ${terms?.chain} → ${terms?.payTo}`)
  if (!payRef) {
    console.error('\nFAIL: paid door and no --pay REF given')
    process.exit(1)
  }
  answer = await ask(prompt, { 'x-payment': payRef })
  if (answer.status !== 200) {
    step('settle', answer.status, JSON.stringify(answer.body))
    process.exit(1)
  }
  step('settle', 200, `paid with ${payRef}`)
}

const reply = (answer.body?.reply ?? '').trim()
step('ask', answer.status, `created=${answer.body?.created} reply=${JSON.stringify(reply.slice(0, 120))}`)

if (answer.status !== 200) process.exit(1)
if (reply.length === 0) {
  console.error('\nFAIL: the crew answered with NOTHING. A 200 with an empty reply is the')
  console.error('shell-echo / no-credentials bug — see G1 and G2 in served-crew-brief.md.')
  process.exit(1)
}

if (twice) {
  const second = await ask('Reply with exactly: SECOND OK')
  const text = (second.body?.reply ?? '').trim()
  step('ask-again', second.status, `created=${second.body?.created} reply=${JSON.stringify(text.slice(0, 80))}`)
  // R5: a session that is already open is never quoted again.
  if (second.status !== 200 || second.body?.created !== false) {
    console.error('\nFAIL: the second ask did not reuse the open session (R5).')
    process.exit(1)
  }
}

console.log('\nPASS — the crew answered through its door.')
