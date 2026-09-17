import {
  callerKeyCandidates,
  callerSub,
  mintCallerKey,
  readCallerKey,
  saveCallerKey,
  signChallenge,
  writeKeyFile,
  type CallerKey
} from './caller-identity'
import type { PaymentRequirements } from './x402-rail'
import { teamPath } from './door-seats'

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
  /** Nobody is signed in on this Mac, so a listed door cannot be asked yet. */
  | { kind: 'identify' }
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
 * THE DIRECT WALK's sign-in — this Mac's own key, and return the Bearer. The
 * token stays in the main process: the renderer drives the sheet, it never
 * holds the credential.
 *
 * IDENTITY v3 (G1, G3): this is offered at UNLISTED doors only — a Mac on this
 * Wi-Fi, an unpublished team. A door the directory lists is entered with the
 * account (`admitWithAccount` below), because a seat is bought and granted by
 * username and a key-holder sub can never be the person the seat names.
 * index.ts decides which by `gateDoorFor`; this function does not know and
 * must not guess.
 */
/** Where this device keeps its keys. Injectable so a test needs no homedir. */
export interface CallerKeyStore {
  sub?: string
  /** Every key this device may hold for the door, canonical first. */
  candidates?: (serviceId: string) => string[]
  /** The one file a winning key is promoted to. */
  canonical?: (serviceId: string) => string
}

export async function signInToDoor(
  target: ServeTargetRef,
  store: CallerKeyStore = {}
): Promise<string> {
  const sub = store.sub ?? callerSub()
  const face = await api(target, '/crew', { method: 'GET' })
  const serviceId = (face.body as { serviceId?: string } | null)?.serviceId ?? ''
  if (serviceId.length === 0) throw new Error('this door did not say who it is')

  /** One attempt with one key. A fresh challenge each time — they are spent. */
  const attempt = async (key: CallerKey): Promise<string | null> => {
    const challenge = await api(target, '/api/call/challenge')
    if (challenge.status !== 200) {
      throw new Error(`this door is not answering (${challenge.status})`)
    }
    const nonce = (challenge.body as { challenge?: string } | null)?.challenge ?? ''
    const asserted = await api(target, '/api/call/assert', {
      body: {
        sub,
        challenge: nonce,
        signature: signChallenge(key, serviceId, sub, nonce),
        jwk: key.jwk
      }
    })
    return asserted.status === 200 ? (asserted.body as { token: string }).token : null
  }

  // EVERY KEY THIS DEVICE HOLDS FOR THIS DOOR, newest naming scheme first.
  // The account is bound at the door to (serviceId, sub), but keys used to be
  // filed by ADDRESS — so the same account can have a key under the loopback
  // name and another under the LAN name, only one of which the door knows.
  // Trying them is the caller's own disk answering "which of my keys is this
  // account?", and the one that works is promoted to the canonical file so the
  // question is never asked twice.
  const candidates =
    store.candidates?.(serviceId) ?? callerKeyCandidates(target.origin, target.slug, serviceId)
  const canonical = store.canonical?.(serviceId) ?? candidates[0]
  const promote = (raw: { pub: unknown; priv: unknown }): void =>
    store.canonical ? writeKeyFile(canonical, raw) : saveCallerKey(serviceId, raw)
  for (const file of candidates) {
    const key = readCallerKey(file)
    if (!key) continue
    const token = await attempt(key)
    if (token === null) continue
    if (file !== canonical) {
      promote({ pub: key.jwk, priv: key.priv.export({ format: 'jwk' }) })
    }
    return token
  }

  // No key we hold is this account — so either we have never signed in here,
  // or the name belongs to someone else's key. Minting IS the sign-up; the
  // door refuses it if the name is taken, which is the honest answer.
  const minted = mintCallerKey()
  const token = await attempt(minted)
  if (token === null) {
    throw new Error(
      'sign-in refused — this name already belongs to another key at this door'
    )
  }
  promote(minted.raw)
  return token
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

/**
 * ── THE INSTALL WALK: the account at a listed door (identity v3, G1) ─────────
 *
 * What the web's line.js already does, done here for the desktop: ask
 * cookrew.dev for a CALL TOKEN with this Mac's session, present it at the door
 * as `{v2Token}`, and read the ladder — 401 (no account here) → 403 (no seat
 * at a paid team) → the door's 402 at session start → open.
 *
 * The seat follows the ACCOUNT, so the token names the person: the door seats
 * `acct-<username>`, the same sub the web seated, and a session bought on the
 * web is the session this Mac opens. That is the whole reason the caller key
 * is not offered here.
 */

/** The account, as this module needs it — the one authed call, and who. */
export interface AccountForDoors {
  /** This Mac's session on cookrew.dev, spent on one path. Mirrors Accounts. */
  authedResponse(
    pathname: string,
    init?: { method?: string; body?: string }
  ): Promise<{ ok: true; response: Response } | { ok: false; reason: string }>
  /** Who is signed in on this Mac, or null. */
  account(): { username: string } | null
}

/** What cookrew.dev said when asked for the door's word. */
export type CallTokenAnswer =
  | { kind: 'token'; token: string; account: string; seat: string | null }
  /** No account on this Mac, or its session is not live: the person must sign in first. */
  | { kind: 'identify' }
  /** The account is real and holds no seat at this paid team. */
  | { kind: 'no_seat' }
  /** cookrew.dev could not be reached. */
  | { kind: 'offline' }
  | { kind: 'refused'; status: number }

/**
 * POST /v2/teams/@owner/team/call-token — 201 with the seat that admits us, 403
 * no_seat for a paid team the account is not seated at. A refusal from the
 * session itself (no account, expired, 401) is `identify`: the next step is
 * the account sheet, not a retry.
 */
export async function mintCallToken(
  account: AccountForDoors,
  team: string
): Promise<CallTokenAnswer> {
  const sent = await account.authedResponse(`${teamPath(team)}/call-token`, {
    method: 'POST',
    body: '{}'
  })
  if (!sent.ok) {
    return sent.reason === 'offline' ? { kind: 'offline' } : { kind: 'identify' }
  }
  const { response } = sent
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  const answer = body as { token?: unknown; account?: unknown; seat?: unknown; error?: unknown } | null
  if (response.status === 201 && typeof answer?.token === 'string' && typeof answer.account === 'string') {
    return {
      kind: 'token',
      token: answer.token,
      account: answer.account,
      seat: typeof answer.seat === 'string' ? answer.seat : null
    }
  }
  if (response.status === 401) return { kind: 'identify' }
  if (response.status === 403 && answer?.error === 'no_seat') return { kind: 'no_seat' }
  return { kind: 'refused', status: response.status }
}

/** The whole install-walk answer: the phase, and the door Bearer when admitted. */
export interface AccountAdmission {
  phase: AdmissionPhase
  /** The door's Bearer, held by main; null unless the door admitted us. */
  token: string | null
  /** The username the token names, when the registry answered. */
  account: string | null
  seat: string | null
}

/**
 * Walk a listed door as the account. Every refusal is a phase the sheet can
 * paint; only a door that admitted us hands back a Bearer.
 */
export async function admitWithAccount(
  target: ServeTargetRef,
  team: string,
  account: AccountForDoors
): Promise<AccountAdmission> {
  const username = account.account()?.username ?? null
  const minted = await mintCallToken(account, team)
  switch (minted.kind) {
    case 'identify':
      return { phase: { kind: 'identify' }, token: null, account: username, seat: null }
    case 'offline':
      return { phase: { kind: 'error', status: 0 }, token: null, account: username, seat: null }
    case 'refused':
      return { phase: { kind: 'error', status: minted.status }, token: null, account: username, seat: null }
    case 'no_seat':
      return {
        phase: { kind: 'denied', reason: 'no_seat', retryable: false },
        token: null,
        account: username,
        seat: null
      }
    case 'token':
      break
  }

  // The token is the whole body — a token beside a key is two claims about
  // who is knocking, and the door refuses both (served-endpoints v2Assert).
  const asserted = await api(target, '/api/call/assert', { body: { v2Token: minted.token } })
  const said = asserted.body as { token?: unknown; reason?: unknown } | null
  if (asserted.status === 200 && typeof said?.token === 'string') {
    return {
      phase: await openAdmission(target, said.token),
      token: said.token,
      account: minted.account,
      seat: minted.seat
    }
  }
  if (asserted.status === 403) {
    // The door's own seat rung — it re-reads the token's seat claim rather
    // than trusting that we checked.
    return {
      phase: { kind: 'denied', reason: typeof said?.reason === 'string' ? said.reason : 'no_seat', retryable: false },
      token: null,
      account: minted.account,
      seat: minted.seat
    }
  }
  // 401 here is a door whose app predates accounts (no v2 verifier wired), or
  // one the registry does not know: nothing this Mac can do about either.
  return { phase: { kind: 'error', status: asserted.status }, token: null, account: minted.account, seat: minted.seat }
}
