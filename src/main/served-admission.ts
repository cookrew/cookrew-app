import { callerSub, loadOrCreateCallerKey, signChallenge } from './caller-identity'
import type { PaymentRequirements } from './x402-rail'

/**
 * THE CALLER'S SIDE OF THE GATE — what the import sheet asks a door.
 *
 * The door answers one ladder (served-endpoints.gateCaller): 401 identity →
 * 429 the owner's budget → 402 at session start → open. This module walks it
 * from the outside and reports a PHASE, so the renderer can paint the gate
 * sheet as a picture of what the door actually said instead of a guess.
 *
 * ADMISSION IS AN OPEN LINE. There is no separate "admit" verb on the wire —
 * opening the line IS session admission (that is what makes the 402 fire at
 * session start and never mid-conversation, R5). So this opens the line, reads
 * the answer, and closes it immediately: the session stays, the stream does
 * not. The card placed afterwards opens its own line into that same session,
 * which is why it never meets the money.
 */

export interface ServeTargetRef {
  origin: string
  slug: string
}

/** What the door is saying, in the gate sheet's vocabulary. */
export type AdmissionPhase =
  | { kind: 'open' }
  | { kind: 'pay'; rails: AdmissionRail[] }
  | { kind: 'denied'; reason: string; retryable: boolean }
  | { kind: 'gone' }
  | { kind: 'error'; status: number }

/** One way this door will take money, with the terms it quoted for it. */
export type AdmissionRail =
  | {
      rail: 'x402'
      /** Decimal USD, for display. */
      price: string
      asset: string
      chain: string
      payTo: string
      /** Epoch ms this quote stops being valid. */
      expiry: number
      requirements: PaymentRequirements
    }
  | { rail: 'stripe'; price: string; asset: 'USD'; chain: 'Stripe'; expiry: number }

const TIMEOUT_MS = 8000

/** Atomic USDC → decimal, the inverse of x402-rail's usdToAtomic. */
export function atomicToUsd(atomic: string, decimals = 6): string {
  if (!/^\d+$/.test(atomic)) return '0'
  const padded = atomic.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '')
  return fraction.length > 0 ? `${whole}.${fraction}` : whole
}

async function api(
  target: ServeTargetRef,
  pathname: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const res = await fetch(`${target.origin}/${target.slug}${pathname}`, {
    method: init.method ?? 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, headers: res.headers, body }
}

/**
 * Sign in and return the Bearer. The token stays in the main process: the
 * renderer drives the sheet, it never holds the credential.
 */
export async function signInToDoor(target: ServeTargetRef): Promise<string> {
  const key = loadOrCreateCallerKey(target.origin, target.slug)
  const sub = callerSub()
  const challenge = await api(target, '/api/call/challenge')
  if (challenge.status !== 200) {
    throw new Error(`this door is not answering (${challenge.status})`)
  }
  const face = await api(target, '/crew', { method: 'GET' })
  const serviceId = (face.body as { serviceId?: string } | null)?.serviceId ?? ''
  const nonce = (challenge.body as { challenge?: string } | null)?.challenge ?? ''
  const asserted = await api(target, '/api/call/assert', {
    body: { sub, challenge: nonce, signature: signChallenge(key, serviceId, sub, nonce), jwk: key.jwk }
  })
  if (asserted.status !== 200) {
    throw new Error('sign-in refused — this name may belong to another key at this door')
  }
  return (asserted.body as { token: string }).token
}

/** Read the rails out of a 402 body, newest terms first. */
function railsFromTerms(terms: unknown, priceUsdHint: string | null): AdmissionRail[] {
  const accepts = (terms as { accepts?: unknown[] } | null)?.accepts
  if (!Array.isArray(accepts)) return []
  const rails: AdmissionRail[] = []
  for (const entry of accepts) {
    const item = entry as Record<string, unknown>
    if (item.scheme === 'exact' && typeof item.maxAmountRequired === 'string') {
      const requirements = item as unknown as PaymentRequirements
      rails.push({
        rail: 'x402',
        price: atomicToUsd(requirements.maxAmountRequired),
        asset: 'USDC',
        chain: String(requirements.network),
        payTo: String(requirements.payTo),
        expiry: Date.now() + Math.max(0, Number(requirements.maxTimeoutSeconds ?? 0)) * 1000,
        requirements
      })
    } else if (item.scheme === 'stripe-checkout') {
      rails.push({
        rail: 'stripe',
        price: typeof item.amountUsd === 'string' ? item.amountUsd : (priceUsdHint ?? '0'),
        asset: 'USD',
        chain: 'Stripe',
        expiry: Date.now() + 30 * 60 * 1000
      })
    }
  }
  return rails
}

/**
 * Open the line once — with a payment when we have one — and report what the
 * door said. The stream is aborted the instant the status is known: we are
 * asking to be admitted, not to watch.
 */
export async function openAdmission(
  target: ServeTargetRef,
  token: string,
  payment?: string
): Promise<AdmissionPhase> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${target.origin}/${target.slug}/line`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
        'accept-encoding': 'identity',
        ...(payment ? { 'x-payment': payment } : {})
      }
    })
    if (res.status === 200) {
      // Admitted. The session is open; this stream is not what we came for.
      controller.abort()
      return { kind: 'open' }
    }
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    const detail = body as { terms?: unknown; reason?: string; retryable?: boolean } | null
    if (res.status === 402) {
      if (detail?.terms) return { kind: 'pay', rails: railsFromTerms(detail.terms, null) }
      // A settle that failed: 'invalid' accuses the payment, 'unverifiable'
      // apologises for our checker. Both are refusals with a voice.
      return {
        kind: 'denied',
        reason: detail?.reason === 'invalid' ? 'payment_invalid' : 'payment_unverifiable',
        retryable: detail?.retryable === true
      }
    }
    if (res.status === 429) return { kind: 'denied', reason: 'budget', retryable: false }
    if (res.status === 403) {
      return { kind: 'denied', reason: detail?.reason ?? 'workspace', retryable: false }
    }
    if (res.status === 404) return { kind: 'gone' }
    if (res.status === 503) {
      return {
        kind: 'denied',
        reason: detail?.reason === 'payment_unavailable' ? 'payment_unavailable' : 'not_answering',
        retryable: true
      }
    }
    return { kind: 'error', status: res.status }
  } catch {
    return { kind: 'error', status: 0 }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask the door for a hosted Checkout page. Returns the URL and the session id
 * inside it — the id is what a settled card payment is presented as, and the
 * URL is the only place it exists (the door hands back a URL, not an id).
 */
export async function startStripeCheckout(
  target: ServeTargetRef,
  token: string
): Promise<{ url: string; session: string }> {
  const res = await api(target, '/api/call/pay', { headers: { authorization: `Bearer ${token}` } })
  if (res.status !== 200) {
    throw new Error(
      res.status === 503
        ? 'card payment is not available at this door right now'
        : `the door refused to start a card payment (${res.status})`
    )
  }
  const url = (res.body as { url?: string } | null)?.url ?? ''
  const session = /\/(cs_[A-Za-z0-9_]+)/.exec(url)?.[1] ?? ''
  if (!url || !session) throw new Error('the door returned an unusable checkout link')
  return { url, session }
}

/** The `X-PAYMENT` a settled Checkout session is presented as. */
export function stripePaymentHeader(session: string): string {
  return Buffer.from(JSON.stringify({ rail: 'stripe', session })).toString('base64')
}
