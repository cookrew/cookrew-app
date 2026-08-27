import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Settle } from './x402-rail'

const STRIPE_API = 'https://api.stripe.com/v1'
/**
 * PINNED API version. Without it every call rides the account's default,
 * which Stripe moves — so an upgrade could change response shapes under a
 * shipped desktop app that nobody redeploys. Raise this deliberately.
 */
const STRIPE_VERSION = '2025-08-27.basil'
/**
 * Product tax code: AI-as-a-Service, cloud-delivered, business use. A served
 * crew session IS this. The generic electronically-supplied-services code is
 * explicitly discouraged for US sales, where taxability turns on exactly the
 * delivery/customer distinction this code carries (Stripe Tax for AI).
 */
const AI_SERVICE_TAX_CODE = 'txcd_10105002'
/**
 * What a caller sees on their card statement, after the account's shortened
 * prefix and `* `. A $2.50 agent session and a five-figure website invoice
 * land on the same statement months apart; a single brand string leaves the
 * reader unable to tell which is which, and not recognising a line is the
 * first cause of chargebacks. Card payments only — non-card charges use the
 * account's static descriptor.
 *
 * Budget: prefix + '* ' + suffix must be <= 22. With the recommended
 * 7-character prefix (COOKREW) that leaves 13; this is 10.
 */
const STATEMENT_SUFFIX = 'AI SESSION'
const CHECKOUT_TTL_SECONDS = 30 * 60
const HTTP_TIMEOUT_MS = 10_000

export interface StripeConfig {
  /** Injected at boot from the owner's 0600 file. Never log this value. */
  secretKey: string
  /** App origin used to build `/<slug>?payment=received` return URLs. */
  successBaseUrl?: string
}

export interface StripePaymentTerms {
  scheme: 'stripe-checkout'
  network: 'stripe'
  amountUsd: string
  currency: 'usd'
  payUrl: string
}

/** Stripe charges USD in cents. Reject, rather than round, excess precision. */
export function usdToCents(usd: string): number | null {
  const trimmed = usd.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
  const [whole, fraction = ''] = trimmed.split('.')
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
  if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(cents)
}

/** The Stripe menu entry. No configured secret means no entry, never a 503. */
export function stripePaymentTerms(
  config: StripeConfig | null | undefined,
  amountUsd: string,
  payUrl: string
): StripePaymentTerms | null {
  if (!config?.secretKey.trim() || !payUrl.trim() || usdToCents(amountUsd) === null) return null
  return {
    scheme: 'stripe-checkout',
    network: 'stripe',
    amountUsd,
    currency: 'usd',
    payUrl
  }
}

export interface StripeHttpResponse {
  ok: boolean
  status: number
  json: unknown
}

export interface StripePostRequest {
  headers: Readonly<Record<string, string>>
  body: string
}

export interface StripeGetRequest {
  headers: Readonly<Record<string, string>>
}

export type StripePost = (url: string, request: StripePostRequest) => Promise<StripeHttpResponse>
export type StripeGet = (url: string, request: StripeGetRequest) => Promise<StripeHttpResponse>

/** Raw fetch adapters for production. Tests inject post/get and never touch the network. */
export async function stripePost(
  url: string,
  request: StripePostRequest,
  timeoutMs = HTTP_TIMEOUT_MS
): Promise<StripeHttpResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(timeoutMs)
  })
  return readStripeResponse(response)
}

export async function stripeGet(
  url: string,
  request: StripeGetRequest,
  timeoutMs = HTTP_TIMEOUT_MS
): Promise<StripeHttpResponse> {
  const response = await fetch(url, {
    method: 'GET',
    headers: request.headers,
    signal: AbortSignal.timeout(timeoutMs)
  })
  return readStripeResponse(response)
}

async function readStripeResponse(response: Response): Promise<StripeHttpResponse> {
  let json: unknown = null
  try {
    json = await response.json()
  } catch {
    // Non-JSON is not a Stripe verdict. The caller gets the retryable voice.
  }
  return { ok: response.ok, status: response.status, json }
}

export interface StripeCheckoutInput {
  priceUsd: string
  serviceId: string
  sub: string
  slug: string
  /** A full override for callers that already resolved the served crew face. */
  successUrl?: string
}

export interface StripeCreateDeps {
  config: StripeConfig
  post: StripePost
  now?: () => number
}

export type StripeCheckoutResult =
  | { ok: true; session: string; url: string }
  | { ok: false; reason: 'invalid' | 'unverifiable' }

/** Create one 30-minute card Checkout Session with our own terms and metadata. */
export async function stripeCreateCheckout(
  deps: StripeCreateDeps,
  input: StripeCheckoutInput
): Promise<StripeCheckoutResult> {
  const amount = usdToCents(input.priceUsd)
  const successUrl = resolveSuccessUrl(deps.config, input)
  if (
    !deps.config.secretKey.trim() ||
    amount === null ||
    !input.serviceId.trim() ||
    !input.sub.trim() ||
    !input.slug.trim() ||
    successUrl === null
  ) {
    return { ok: false, reason: 'invalid' }
  }

  const form = new URLSearchParams()
  form.set('mode', 'payment')
  form.set('line_items[0][price_data][currency]', 'usd')
  form.set('line_items[0][price_data][unit_amount]', String(amount))
  form.set('line_items[0][price_data][product_data][name]', `One session with the ${input.slug} crew`)
  form.set('line_items[0][quantity]', '1')
  form.set('expires_at', String(Math.floor((deps.now?.() ?? Date.now()) / 1000) + CHECKOUT_TTL_SECONDS))
  form.set('metadata[serviceId]', input.serviceId)
  form.set('metadata[sub]', input.sub)
  form.set('metadata[slug]', input.slug)
  form.set('success_url', successUrl)
  // Tax, not guesswork. Hong Kong levies no VAT/GST, so a domestic sale is
  // simply untaxed — but a cross-border sale can create an obligation in the
  // CUSTOMER's country, and only Stripe Tax tracks which. It needs three
  // things: the product's tax code, an address to locate the buyer, and (for
  // B2B) a tax ID, without which cross-border reverse charge cannot apply.
  form.set('line_items[0][price_data][product_data][tax_code]', AI_SERVICE_TAX_CODE)
  form.set('automatic_tax[enabled]', 'true')
  form.set('billing_address_collection', 'required')
  form.set('tax_id_collection[enabled]', 'true')
  // A Customer makes the sale attributable — it is what tax reports, receipts
  // and any later invoice for the same buyer hang off.
  form.set('customer_creation', 'always')
  form.set('payment_intent_data[statement_descriptor_suffix]', STATEMENT_SUFFIX)

  let response: StripeHttpResponse
  try {
    response = await deps.post(`${STRIPE_API}/checkout/sessions`, {
      // Keyed by the CALLER'S INTENT, not by the attempt: the same buyer
      // asking the same crew for the same price is one purchase however many
      // times the request is retried.
      headers: stripeHeaders(
        deps.config,
        true,
        `checkout:${input.serviceId}:${input.sub}:${amount}`
      ),
      body: form.toString()
    })
  } catch {
    return { ok: false, reason: 'unverifiable' }
  }
  if (!response.ok || !isRecord(response.json)) return { ok: false, reason: 'unverifiable' }

  const session = response.json.id
  const url = response.json.url
  if (!validSessionId(session) || typeof url !== 'string' || !validCheckoutUrl(url)) {
    return { ok: false, reason: 'unverifiable' }
  }
  return { ok: true, session, url }
}

function resolveSuccessUrl(config: StripeConfig, input: StripeCheckoutInput): string | null {
  const candidate = input.successUrl?.trim()
  if (candidate) return validHttpUrl(candidate) ? withPaymentReceived(candidate) : null
  const base = config.successBaseUrl?.trim()
  if (!base) return null
  try {
    const url = new URL(base)
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(input.slug)}`
    return withPaymentReceived(url.toString())
  } catch {
    return null
  }
}

function withPaymentReceived(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.searchParams.set('payment', 'received')
    return url.toString()
  } catch {
    return null
  }
}

function validHttpUrl(raw: string): boolean {
  return withPaymentReceived(raw) !== null
}

function validCheckoutUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && url.hostname === 'checkout.stripe.com'
  } catch {
    return false
  }
}

export interface StripePaymentEnvelope {
  rail: 'stripe'
  session: string
}

/** Decode the caller-controlled X-Payment value before it can reach a URL. */
export function decodeStripePaymentHeader(header: string): StripePaymentEnvelope | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.rail !== 'stripe' || !validSessionId(parsed.session)) return null
  return { rail: 'stripe', session: parsed.session }
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && /^cs_[A-Za-z0-9_]+$/.test(value)
}

export interface StripeExpectedPayment {
  amountUsd: string
  serviceId: string
  sub: string
}

export interface StripeRedemptionStore {
  has(session: string): boolean
  /** Atomically records a new id. False means another request already did. */
  redeem(session: string): boolean
}

/**
 * A durable one-use ledger. Every operation re-reads disk so a new rail instance
 * and a concurrent settlement both see the burn before admitting a replay.
 */
export function createStripeRedemptionStore(file: string): StripeRedemptionStore {
  const load = (): Set<string> => {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
      throw error
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.some((item) => !validSessionId(item))) {
      throw new Error('invalid Stripe redemption ledger')
    }
    return new Set(parsed)
  }

  return {
    has: (session) => load().has(session),
    redeem(session) {
      if (!validSessionId(session)) return false
      const used = load()
      if (used.has(session)) return false
      used.add(session)
      mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify([...used].sort(), null, 2), { mode: 0o600 })
      renameSync(tmp, file)
      return true
    }
  }
}

export interface StripeSettleDeps {
  config: StripeConfig
  get: StripeGet
  redemptions: StripeRedemptionStore
}

/** Retrieve, validate against our quote, then durably burn one Checkout id. */
export async function stripeSettle(
  deps: StripeSettleDeps,
  header: string,
  expected: StripeExpectedPayment
): Promise<Settle> {
  const payment = decodeStripePaymentHeader(header)
  if (payment === null) return 'refused'
  const amount = usdToCents(expected.amountUsd)
  if (amount === null || !deps.config.secretKey.trim()) return 'unverifiable'

  try {
    if (deps.redemptions.has(payment.session)) return 'refused'
  } catch {
    return 'unverifiable'
  }

  let response: StripeHttpResponse
  try {
    response = await deps.get(`${STRIPE_API}/checkout/sessions/${payment.session}`, {
      headers: stripeHeaders(deps.config, false)
    })
  } catch {
    return 'unverifiable'
  }

  // A real Stripe 404 is a verdict that this caller's cs_ id does not exist.
  if (!response.ok) {
    return response.status === 404 && isRecord(response.json) ? 'refused' : 'unverifiable'
  }
  if (!isRecord(response.json)) return 'unverifiable'

  const session = response.json
  const metadata = session.metadata
  if (
    session.id !== payment.session ||
    session.payment_status !== 'paid' ||
    session.amount_total !== amount ||
    session.currency !== 'usd' ||
    !isRecord(metadata) ||
    metadata.serviceId !== expected.serviceId ||
    metadata.sub !== expected.sub
  ) {
    return 'refused'
  }

  try {
    return deps.redemptions.redeem(payment.session) ? 'ok' : 'refused'
  } catch {
    return 'unverifiable'
  }
}

function stripeHeaders(
  config: StripeConfig,
  form: boolean,
  idempotencyKey?: string
): Record<string, string> {
  return {
    authorization: `Bearer ${config.secretKey}`,
    'stripe-version': STRIPE_VERSION,
    ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    // Stripe replays the FIRST response for a repeated key, so a retry after a
    // timeout returns the session we already made instead of minting a second
    // one and charging the caller twice.
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
