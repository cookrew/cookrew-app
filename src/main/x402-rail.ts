/**
 * The real payment rail: x402 over USDC, settled by a facilitator.
 *
 * WHY x402 AND NOT STRIPE
 * -----------------------
 * The seam was already x402-shaped before any of this existed — the header is
 * X-PAYMENT and the 402 already quoted {amount, asset, chain, payTo, nonce,
 * expiry}. Only `chain: 'dev'` and a string-prefix settle were pretend.
 *
 * The deciding property is that THIS PROCESS HOLDS NO SECRET. A facilitator
 * verifies the signature and moves the money; we send it the caller's signed
 * authorization and our own PUBLIC receiving address. There is no API key to
 * store, rotate, leak into a log, or commit — the constraint is satisfied by
 * the shape of the protocol rather than by our discipline. Stripe would need a
 * live sk_ secret at rest inside an app that already runs a LAN listener, plus
 * a client-side confirmation step and webhooks to be reliable. That is a bigger
 * surface than this milestone wants, for the same "real USD".
 *
 * WHAT IS REAL HERE
 * -----------------
 * Real USDC on a real chain, moved by a real EIP-3009 authorization the caller
 * signed. Base Sepolia by default — a TEST NETWORK, which the ruling allows —
 * but nothing about the code is testnet-specific: point BASE/ASSET/FACILITATOR
 * at mainnet and the same path moves real dollars. The rail is real; only the
 * denomination is play money.
 *
 * THE TWO VOICES, AND WHICH FAULT IS WHOSE
 * ----------------------------------------
 * 'refused' ACCUSES: the facilitator looked and said no — bad signature, wrong
 *   amount, expired authorization, replayed nonce. Retrying cannot help.
 * 'unverifiable' APOLOGISES: we could not get an answer — the facilitator was
 *   unreachable, timed out, or replied with something we cannot read. The
 *   caller may retry, and MUST NOT be charged twice for doing so.
 *
 * The distinction is load-bearing and it is decided by WHOSE fault it is, never
 * by convenience. An unreachable facilitator is our problem; calling it
 * 'refused' would accuse a caller who did nothing wrong.
 *
 * ORDERING: verify, then settle. Verify is the cheap, non-mutating question,
 * and a payload that fails it must never reach settle. Only a SUCCESSFUL settle
 * returns ok — a verified-but-unsettled payment has moved no money, and
 * admitting on it would serve the crew for free.
 */

/** Atomic units per whole USDC. The contract's own decimals, not a guess. */
const USDC_DECIMALS = 6

/** How long a caller has to pay a quote before it stops being honoured. */
export const QUOTE_TTL_MS = 5 * 60 * 1000

export type Settle = 'ok' | 'refused' | 'unverifiable'

export interface X402Config {
  /** Where the money lands. PUBLIC — an address is not a secret. */
  payTo: string
  /** Facilitator base URL; it holds the keys and touches the chain, we do not. */
  facilitator: string
  /** x402 network id, e.g. 'base-sepolia'. */
  network: string
  /** USDC contract on `network`. */
  asset: string
  /** EIP-712 domain of the asset, needed to check a signature against it. */
  assetName: string
  assetVersion: string
}

/**
 * Base Sepolia and the public x402 facilitator: free, keyless, and real.
 *
 * Defaults rather than constants so a deployment can move to mainnet by
 * configuration. Every value here is public by nature — a receiving address, a
 * token contract, a facilitator URL. Nothing in this object may ever become a
 * secret; if it does, it belongs somewhere else.
 */
export const BASE_SEPOLIA: Omit<X402Config, 'payTo'> = {
  facilitator: 'https://x402.org/facilitator',
  network: 'base-sepolia',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  assetName: 'USDC',
  assetVersion: '2'
}

/**
 * "0.50" → "500000". String in, string out: a price is decimal text and an
 * atomic amount is a 256-bit integer, and neither survives a float intact.
 * Returns null for anything that is not a plain non-negative decimal, so a
 * malformed price becomes a refusal to QUOTE rather than a quote for zero.
 */
export function usdToAtomic(usd: string): string | null {
  const trimmed = usd.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const [whole, fraction = ''] = trimmed.split('.')
  if (fraction.length > USDC_DECIMALS) return null
  const padded = fraction.padEnd(USDC_DECIMALS, '0')
  const atomic = `${whole}${padded}`.replace(/^0+(?=\d)/, '')
  return atomic
}

export interface PaymentRequirements {
  scheme: 'exact'
  network: string
  maxAmountRequired: string
  resource: string
  description: string
  mimeType: string
  payTo: string
  maxTimeoutSeconds: number
  asset: string
  extra: { name: string; version: string }
}

/**
 * The 402 body: what the caller must pay, in the shape x402 clients read.
 *
 * Returns null when the price cannot be expressed, because a quote nobody can
 * satisfy is worse than an honest failure to quote.
 */
export function paymentRequirements(
  config: X402Config,
  priceUsd: string,
  resource: string,
  description: string
): { x402Version: 1; accepts: PaymentRequirements[] } | null {
  const maxAmountRequired = usdToAtomic(priceUsd)
  if (maxAmountRequired === null || maxAmountRequired === '0') return null
  // No destination is not a cheap quote, it is an unpayable one: a caller would
  // sign an authorization to nobody, and we would then have to refuse a payment
  // they genuinely made. Refuse to QUOTE instead.
  if (config.payTo.trim().length === 0) return null
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: config.network,
        maxAmountRequired,
        resource,
        description,
        mimeType: 'application/json',
        payTo: config.payTo,
        maxTimeoutSeconds: Math.floor(QUOTE_TTL_MS / 1000),
        asset: config.asset,
        extra: { name: config.assetName, version: config.assetVersion }
      }
    ]
  }
}

export interface PaymentPayload {
  x402Version: number
  scheme: string
  network: string
  payload: {
    signature: string
    authorization: {
      from: string
      to: string
      value: string
      validAfter: string
      validBefore: string
      nonce: string
    }
  }
}

/**
 * Decode the X-PAYMENT header without trusting a byte of it.
 *
 * Returns null for anything malformed. A caller controls this string entirely,
 * so every field is checked for PRESENCE AND TYPE before it is read — an
 * undefined nonce that reached the replay guard would compare equal to the next
 * undefined nonce and refuse an innocent payment, or worse, admit a replayed
 * one.
 */
export function decodePaymentHeader(header: string): PaymentPayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as Partial<PaymentPayload>
  const inner = candidate.payload
  if (typeof inner !== 'object' || inner === null) return null
  const auth = inner.authorization
  if (typeof auth !== 'object' || auth === null) return null
  if (typeof inner.signature !== 'string' || inner.signature.length === 0) return null
  for (const field of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'] as const) {
    if (typeof auth[field] !== 'string' || auth[field].length === 0) return null
  }
  if (typeof candidate.scheme !== 'string' || typeof candidate.network !== 'string') return null
  return candidate as PaymentPayload
}

/** The facilitator's two answers, narrowed to what we actually consult. */
interface VerifyReply {
  isValid?: unknown
  invalidReason?: unknown
}
interface SettleReply {
  success?: unknown
  transaction?: unknown
  errorReason?: unknown
}

export interface X402Deps {
  config: X402Config
  /** Injected so the rail is testable without a network. */
  post: (url: string, body: unknown) => Promise<{ ok: boolean; json: unknown }>
  /** Nonces already settled. The chain refuses a replay too; this is cheaper. */
  seen: { has(nonce: string): boolean; add(nonce: string): void }
}

/**
 * Verify then settle one payment against the requirements we quoted.
 *
 * `requirements` is OURS, never the caller's: the amount, asset, network and
 * recipient are re-stated here from our own config so a caller cannot pay a
 * dollar against a quote for a hundred by echoing back terms of their own.
 */
export async function x402Settle(
  deps: X402Deps,
  header: string,
  requirements: PaymentRequirements
): Promise<Settle> {
  const payment = decodePaymentHeader(header)
  // Unreadable is the CALLER's fault and cannot be fixed by retrying: accuse.
  if (payment === null) return 'refused'

  // Cheap local refusals first, so an obviously-wrong payload never costs a
  // network round trip. Each is a fact we already hold, not an opinion.
  if (payment.scheme !== requirements.scheme) return 'refused'
  if (payment.network !== requirements.network) return 'refused'
  if (payment.payload.authorization.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
    return 'refused'
  }

  const nonce = payment.payload.authorization.nonce
  if (deps.seen.has(nonce)) return 'refused'

  const envelope = {
    x402Version: 1,
    paymentPayload: payment,
    paymentRequirements: requirements
  }

  let verify: { ok: boolean; json: unknown }
  try {
    verify = await deps.post(`${deps.config.facilitator}/verify`, envelope)
  } catch {
    // We could not ask. That is ours to apologise for, not theirs to answer for.
    return 'unverifiable'
  }
  if (!verify.ok) return 'unverifiable'
  const verdict = verify.json as VerifyReply
  if (typeof verdict?.isValid !== 'boolean') return 'unverifiable'
  // The facilitator LOOKED and said no. That is an accusation we can stand behind.
  if (!verdict.isValid) return 'refused'

  let settled: { ok: boolean; json: unknown }
  try {
    settled = await deps.post(`${deps.config.facilitator}/settle`, envelope)
  } catch {
    return 'unverifiable'
  }
  if (!settled.ok) return 'unverifiable'
  const receipt = settled.json as SettleReply
  if (typeof receipt?.success !== 'boolean') return 'unverifiable'
  // Verified but not settled: no money moved, and the caller is not at fault
  // for a transfer we failed to land. Retrying is safe — the authorization is
  // single-use on-chain, so a retry either lands once or fails as replayed.
  if (!receipt.success) return 'unverifiable'

  // Burn the nonce only on a settlement that actually happened. Burning it
  // earlier would strand a caller whose money never moved.
  deps.seen.add(nonce)
  return 'ok'
}

/** POST JSON to the facilitator. Bounded, because a hung gate is a dead door. */
export async function postJson(
  url: string,
  body: unknown,
  timeoutMs = 10_000
): Promise<{ ok: boolean; json: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  let json: unknown = null
  try {
    json = await response.json()
  } catch {
    // A non-JSON body is not a verdict; leaving it null makes the caller
    // apologise rather than accuse.
  }
  return { ok: response.ok, json }
}

/** In-memory nonce ledger. Process-lifetime: the chain is the durable guard. */
export function createNonceLedger(): { has(n: string): boolean; add(n: string): void } {
  const used = new Set<string>()
  return { has: (n) => used.has(n), add: (n) => void used.add(n) }
}
