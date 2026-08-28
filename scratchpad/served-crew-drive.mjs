#!/usr/bin/env node
/**
 * SERVED-CREW DRIVER — the caller's half of the gate, scripted.
 *
 * The QA fixture for the export/import journey: it does exactly what a placed
 * crew card does (public face → challenge → ed25519 assert → /ask), so a gate
 * regression shows up here in one command instead of a twenty-click UI drive.
 *
 *   node scratchpad/served-crew-drive.mjs <slug> [--rail x402|stripe] [--pay REF]
 *                                        [--sub NAME] [--prompt TEXT]
 *                                        [--origin URL] [--twice]
 *
 * A paid x402 door signs from ~/.cookrew/x402-caller.env unless --pay supplies
 * an already-built header. The file must be private to the owner and contain:
 *
 *   X402_CALLER_PRIVATE_KEY=0x...
 *
 * Exit code is 0 only when the crew ANSWERED with non-empty text — an empty
 * 200 is the shell-echo bug (see G1 in served-crew-brief.md) and must fail.
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { readFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

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
const rail = flag('rail', 'x402')
const twice = args.includes('--twice')

if (!slug) {
  console.error(
    'usage: served-crew-drive.mjs <slug> [--rail x402|stripe] [--pay REF] [--sub NAME] [--prompt TEXT] [--twice]'
  )
  process.exit(2)
}
if (!['x402', 'stripe'].includes(rail)) {
  console.error('FAIL: --rail must be x402 or stripe')
  process.exit(2)
}
if (rail === 'stripe' && payRef) {
  console.error('FAIL: --pay is x402-only; Stripe Checkout is driven through QA Chrome')
  process.exit(2)
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const jwk = publicKey.export({ format: 'jwk' })

const fail = (message) => {
  console.error(`\nFAIL: ${message}`)
  process.exit(1)
}

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

const signIn = async (callerSub, label = 'sign-in') => {
  const challenge = await api('/api/call/challenge')
  if (challenge.status !== 200 || typeof challenge.body?.challenge !== 'string') {
    step(label, challenge.status, 'challenge unavailable')
    fail('the caller challenge was not issued')
  }
  // The signing payload is fixed by call-ceremony.ts — keep the two in step.
  const payload = `cookrew-call/1\n${face.body.serviceId}\n${callerSub}\n${challenge.body.challenge}`
  const signature = sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url')
  const asserted = await api('/api/call/assert', {
    body: JSON.stringify({ sub: callerSub, challenge: challenge.body.challenge, signature, jwk })
  })
  if (asserted.status !== 200 || typeof asserted.body?.token !== 'string') {
    step(label, asserted.status, 'assertion refused')
    fail('the caller could not sign in')
  }
  step(label, 200, `as ${callerSub}`)
  return asserted.body.token
}

const callerKey = () => {
  const file = path.join(homedir(), '.cookrew', 'x402-caller.env')
  let mode
  try {
    mode = statSync(file).mode
  } catch {
    fail(`missing ${file}; the owner must provision and fund the caller wallet`)
  }
  if ((mode & 0o077) !== 0) fail(`${file} must be private; run chmod 600 on it`)

  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    fail(`cannot read ${file}`)
  }
  const values = new Map()
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim().replace(/^export\s+/, '')
    if (!line || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    if (equals < 1) continue
    const name = line.slice(0, equals).trim()
    let value = line.slice(equals + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    values.set(name, value)
  }
  const key = values.get('X402_CALLER_PRIVATE_KEY')
  if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    fail(`${file} has no valid X402_CALLER_PRIVATE_KEY`)
  }
  return key
}

const chainIdFor = (network) => {
  if (network === 'base-sepolia') return 84532
  if (network === 'base') return 8453
  fail(`no EIP-712 chain id is configured for x402 network '${network}'`)
}

const buildX402Payment = async (requirements) => {
  if (
    requirements?.scheme !== 'exact' ||
    typeof requirements.network !== 'string' ||
    typeof requirements.maxAmountRequired !== 'string' ||
    typeof requirements.payTo !== 'string' ||
    typeof requirements.asset !== 'string' ||
    typeof requirements.maxTimeoutSeconds !== 'number' ||
    !isAddress(requirements.payTo) ||
    !isAddress(requirements.asset) ||
    typeof requirements.extra?.name !== 'string' ||
    typeof requirements.extra?.version !== 'string'
  ) {
    fail('the x402 quote is malformed')
  }

  let value
  try {
    value = BigInt(requirements.maxAmountRequired)
  } catch {
    fail('the x402 quote has an invalid atomic amount')
  }
  if (value <= 0n || !Number.isFinite(requirements.maxTimeoutSeconds) || requirements.maxTimeoutSeconds <= 0) {
    fail('the x402 quote has invalid payment bounds')
  }

  const account = privateKeyToAccount(callerKey())
  const now = Math.floor(Date.now() / 1000)
  const authorization = {
    from: account.address,
    to: requirements.payTo,
    value,
    validAfter: BigInt(Math.max(0, now - 60)),
    validBefore: BigInt(now + Math.floor(requirements.maxTimeoutSeconds)),
    nonce: `0x${randomBytes(32).toString('hex')}`
  }
  const signature = await account.signTypedData({
    domain: {
      name: requirements.extra.name,
      version: requirements.extra.version,
      chainId: chainIdFor(requirements.network),
      verifyingContract: requirements.asset
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' }
      ]
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization
  })

  const payment = {
    x402Version: 1,
    scheme: requirements.scheme,
    network: requirements.network,
    payload: {
      signature,
      authorization: {
        ...authorization,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString()
      }
    }
  }
  return Buffer.from(JSON.stringify(payment)).toString('base64')
}

const stripeSessionFromUrl = (raw) => {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') return null
    return decodeURIComponent(url.pathname).match(/\bcs_[A-Za-z0-9_]+\b/)?.[0] ?? null
  } catch {
    return null
  }
}

const driveStripeCheckout = (checkoutUrl) => {
  const session = stripeSessionFromUrl(checkoutUrl)
  if (!session) fail('Stripe returned a Checkout URL without a valid session id')

  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-checkout-'))
  const urlFile = path.join(dir, 'url')
  const runner = fileURLToPath(new URL('../scripts/qa-stripe-checkout.mjs', import.meta.url))
  try {
    writeFileSync(urlFile, `${checkoutUrl}\n`, { mode: 0o600 })
    const result = spawnSync(process.execPath, [runner, '--url-file', urlFile], {
      stdio: 'inherit'
    })
    if (result.error) fail('the hosted Checkout driver could not start')
    if (result.status !== 0) fail('the hosted Checkout did not complete')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return session
}

const face = await api('/crew', { method: 'GET' })
if (face.status !== 200) {
  step('face', face.status, JSON.stringify(face.body))
  process.exit(1)
}
step('face', 200, `${face.body.name} · door=${face.body.door} · ${face.body.access}${face.body.priceUsd ? ` ${face.body.priceUsd}` : ''}`)

const token = await signIn(sub)
const askWith = (bearer, text, extra = {}) =>
  api('/ask', {
    headers: { authorization: `Bearer ${bearer}`, ...extra },
    body: JSON.stringify({ prompt: text })
  })
const ask = (text, extra = {}) => askWith(token, text, extra)

let answer = await ask(prompt)
if (answer.status === 402) {
  const terms = answer.body?.terms
  const accepts = Array.isArray(terms?.accepts) ? terms.accepts : []
  if (rail === 'x402') {
    const requirements = accepts.find((candidate) => candidate?.scheme === 'exact')
    if (!requirements) fail('the paid door did not offer an x402 payment option')
    const tokenName = requirements.extra?.name ?? 'token'
    step(
      'quote',
      402,
      `${requirements.maxAmountRequired} atomic ${tokenName} on ${requirements.network} → ${requirements.payTo}`
    )
    const payment = payRef ?? (await buildX402Payment(requirements))
    answer = await ask(prompt, { 'x-payment': payment })
    if (answer.status !== 200 || answer.body?.created !== true) {
      step('settle', answer.status, `reason=${answer.body?.reason ?? 'not admitted'}`)
      fail('a settled payment did not admit a new session')
    }
    step('settle', 200, 'payment accepted; new session admitted')

    // The first caller now owns an open session and would skip the gate. A
    // fresh authenticated caller reaches settlement and proves the nonce dead.
    const replaySub = `${sub}-replay`
    const replayToken = await signIn(replaySub, 'sign-in-replay')
    const replay = await askWith(replayToken, prompt, { 'x-payment': payment })
    if (
      replay.status !== 402 ||
      replay.body?.reason !== 'invalid' ||
      replay.body?.retryable !== false
    ) {
      step('replay', replay.status, `reason=${replay.body?.reason ?? 'unexpected'}`)
      fail('the same x402 authorization was not refused on replay')
    }
    step('replay', 402, 'reused authorization refused before admission')
  } else {
    const stripeTerms = accepts.find((candidate) => candidate?.scheme === 'stripe-checkout')
    if (!stripeTerms) fail('the paid door did not offer card payment')
    step('quote', 402, `${stripeTerms.amountUsd} ${stripeTerms.currency} by card`)
    const checkout = await api('/api/call/pay', { headers: { authorization: `Bearer ${token}` } })
    if (checkout.status !== 200 || typeof checkout.body?.url !== 'string') {
      step('checkout', checkout.status, 'card checkout unavailable')
      fail('the card checkout session was not created')
    }
    const session = driveStripeCheckout(checkout.body.url)
    const payment = Buffer.from(JSON.stringify({ rail: 'stripe', session })).toString('base64')
    answer = await ask(prompt, { 'x-payment': payment })
    if (answer.status !== 200 || answer.body?.created !== true) {
      step('settle', answer.status, `reason=${answer.body?.reason ?? 'not admitted'}`)
      fail('the paid card session did not admit a new crew session')
    }
    step('settle', 200, 'card payment accepted; new session admitted')
  }
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
