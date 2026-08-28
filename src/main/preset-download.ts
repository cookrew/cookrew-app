// The marketplace download gate — client side.
//
// WHY THIS EXISTS
// ---------------
// The registry answers a manifest or blob request with 200/401/402/403/404
// (registry/src/server.ts). Feature A's download bridge has to turn ONE of
// those raw HTTP answers into the next thing the app does — enrol a passkey,
// take a payment, show a refusal, or hand the bytes to the verifier. That
// decision is small, total, and security-load-bearing, so it lives here as a
// pure function with no network and no side effect. The IO wrapper below calls
// it; everything adversarial is settled and tested in `classifyGateResponse`.
//
// THE REGISTRY IS NOT TRUSTED. A hostile or broken registry chooses these
// bytes. Every missing or malformed field therefore fails CLOSED — to `error`
// or `gone`, never to a step that could be mistaken for success. A 200 is the
// one answer that carries bytes onward, and it is safe precisely because the
// caller verifies the signature itself (preset-install.ts, A5): a 200 buys the
// registry nothing it could not already do by serving a manifest.
//
// SCOPE — a decision function plus a thin fetch that defers to it. It performs
// no signature check, mounts no ceremony, and renders no sheet.

import { isForbiddenReason, type ForbiddenReason } from '../shared/preset-manifest'

/**
 * The 402 offer as it arrives on the wire (registry/src/terms.ts `Terms`). The
 * app defines its own view rather than importing the registry package: the two
 * are separate deployables and the boundary between them is the HTTP body, not
 * a shared type. Parsed defensively — see `parseTerms`.
 */
export interface PaymentTerms {
  amount: string
  asset: 'USDC'
  chain: string
  payTo: string
  nonce: string
  /** Epoch ms. Absolute, so the client owns the countdown. */
  expiry: number
}

/** One HTTP answer from the registry, normalised: status, lowercased headers, parsed body. */
export interface RawGateResponse {
  status: number
  headers: Record<string, string | undefined>
  /** JSON-parsed body (manifest, `{terms}`, `{reason}`) or null when there is none. */
  body: unknown
}

/**
 * What the app does next, given one registry answer. Exactly one per response.
 * `ready` carries the body onward to the verifier; the rest are gate outcomes
 * the UI renders. `error` is the fail-closed sink for anything unusable.
 */
export type GateStep =
  | { kind: 'ready'; body: unknown }
  | { kind: 'enrol'; challenge: string }
  | { kind: 'pay'; terms: PaymentTerms; retryable: boolean; reason?: string }
  | { kind: 'denied'; reason: ForbiddenReason | 'unknown'; retryable: boolean }
  | { kind: 'gone' }
  | { kind: 'error'; status: number }

/**
 * The challenge from a `WWW-Authenticate: WebAuthn realm="...", challenge=<c>`
 * header, or null when the header is absent or carries no non-empty challenge.
 *
 * A 401 whose challenge we cannot read is a ceremony we cannot run, so it must
 * become `error`, never a half-built enrol. That is why an empty `challenge=`
 * is null and not the empty string.
 */
export function challengeFromAuthHeader(header: string | undefined): string | null {
  if (header === undefined) return null
  // `challenge=` up to the next comma, whitespace, or end. The scheme token is
  // case-insensitive per RFC 7235; we only need the parameter value.
  const match = /challenge=([^,\s]+)/i.exec(header)
  const value = match?.[1] ?? ''
  return value.length > 0 ? value : null
}

/**
 * A 402 body's terms, validated field by field, or null if it is not a
 * complete USDC offer. Money to nowhere (no `payTo`), in an unknown asset, or
 * with a non-integer expiry is not an offer a pay sheet can honour, so it fails
 * closed rather than rendering a sheet the buyer could be misled by.
 */
export function parseTerms(value: unknown): PaymentTerms | null {
  if (value === null || typeof value !== 'object') return null
  const t = value as Record<string, unknown>
  if (typeof t.amount !== 'string' || t.amount.length === 0) return null
  if (t.asset !== 'USDC') return null
  if (typeof t.chain !== 'string' || t.chain.length === 0) return null
  if (typeof t.payTo !== 'string' || t.payTo.length === 0) return null
  if (typeof t.nonce !== 'string' || t.nonce.length === 0) return null
  if (typeof t.expiry !== 'number' || !Number.isInteger(t.expiry)) return null
  return {
    amount: t.amount,
    asset: 'USDC',
    chain: t.chain,
    payTo: t.payTo,
    nonce: t.nonce,
    expiry: t.expiry
  }
}

/** The reason field of a 403/402 body, if it is a string. */
function reasonOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const value = (body as Record<string, unknown>).reason
  return typeof value === 'string' ? value : undefined
}

/**
 * Turn one registry answer into the next step. Total over the status code:
 * anything not explicitly handled is `error`, which is the point — a client
 * that only knows five answers must not silently proceed on a sixth.
 */
export function classifyGateResponse(res: RawGateResponse): GateStep {
  switch (res.status) {
    case 200:
      return { kind: 'ready', body: res.body }

    case 401: {
      const challenge = challengeFromAuthHeader(res.headers['www-authenticate'])
      return challenge === null ? { kind: 'error', status: 401 } : { kind: 'enrol', challenge }
    }

    case 402: {
      const body = (res.body ?? {}) as Record<string, unknown>
      const terms = parseTerms(body.terms)
      if (terms === null) return { kind: 'error', status: 402 }
      const reason = reasonOf(body)
      return {
        kind: 'pay',
        terms,
        retryable: body.retryable === true,
        ...(reason !== undefined ? { reason } : {})
      }
    }

    case 403: {
      const reason = reasonOf(res.body)
      // `scope` is the one 403 with a programmatic remedy: re-run the ceremony
      // for the right scope (R26). Everything else needs a human, so it is not
      // retryable and the UI links a remedy instead of a retry.
      if (reason !== undefined && isForbiddenReason(reason)) {
        return { kind: 'denied', reason, retryable: reason === 'scope' }
      }
      return { kind: 'denied', reason: 'unknown', retryable: false }
    }

    case 404:
      return { kind: 'gone' }

    default:
      return { kind: 'error', status: res.status }
  }
}

// ── IO ──────────────────────────────────────────────────────────────────────
//
// A thin fetch that normalises a real HTTP response and defers every decision
// to `classifyGateResponse`. The transport is injectable so tests drive the
// gate with a stub and the production path owns TLS (the registry is https off
// loopback). No retries, no ceremony, no verification — those belong to the
// flow above this, which loops these calls as the gate steps require.

export interface GateHttpResult {
  status: number
  /** Response headers, keys lowercased. */
  headers: Record<string, string | undefined>
  /** Raw body bytes — the manifest is JSON, a blob is the exact team.json. */
  bytes: Buffer
}

export type GateTransport = (
  url: string,
  init: { method: 'GET' | 'HEAD'; headers: Record<string, string> }
) => Promise<GateHttpResult>

/** What the client presents: a bearer credential and/or a payment proof. */
export interface DownloadCredentials {
  /** Bearer token from a completed passkey ceremony. */
  token?: string
  /** `X-Payment` proof from a settled 402. */
  payment?: string
}

export interface DownloadOptions extends DownloadCredentials {
  transport?: GateTransport
}

/** Global-fetch transport. Reads the whole body once as bytes. */
const defaultTransport: GateTransport = async (url, init) => {
  const response = await fetch(url, { method: init.method, headers: init.headers })
  const bytes = Buffer.from(await response.arrayBuffer())
  const headers: Record<string, string | undefined> = {}
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })
  return { status: response.status, headers, bytes }
}

function authHeaders(creds: DownloadCredentials): Record<string, string> {
  const headers: Record<string, string> = {}
  if (creds.token !== undefined && creds.token.length > 0) {
    headers.authorization = `Bearer ${creds.token}`
  }
  if (creds.payment !== undefined && creds.payment.length > 0) {
    headers['x-payment'] = creds.payment
  }
  return headers
}

/** Registry base without a trailing slash, so path joins never double it. */
function base(registryBase: string): string {
  return registryBase.replace(/\/+$/, '')
}

/** Parsed JSON body, or null when the bytes are not JSON (never throws). */
function jsonBody(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Fetch a preset manifest and classify the answer. On `ready`, the body is the
 * parsed manifest object — the caller MUST verify it itself (preset-install.ts)
 * before trusting a byte of it.
 */
export async function fetchManifest(
  registryBase: string,
  presetId: string,
  options: DownloadOptions = {}
): Promise<GateStep> {
  const transport = options.transport ?? defaultTransport
  const url = `${base(registryBase)}/v1/presets/${encodeURIComponent(presetId)}/manifest`
  const result = await transport(url, { method: 'GET', headers: authHeaders(options) })
  return classifyGateResponse({
    status: result.status,
    headers: result.headers,
    body: jsonBody(result.bytes)
  })
}

/**
 * Fetch a content-addressed blob (team.json) and classify the answer. On
 * `ready`, the body is the RAW bytes — verification hashes them exactly, so
 * they must not be re-encoded through a JSON round-trip.
 */
export async function fetchBlob(
  registryBase: string,
  address: string,
  options: DownloadOptions = {}
): Promise<GateStep> {
  const transport = options.transport ?? defaultTransport
  const url = `${base(registryBase)}/v1/blobs/${encodeURIComponent(address)}`
  const result = await transport(url, { method: 'GET', headers: authHeaders(options) })
  if (result.status === 200) return { kind: 'ready', body: result.bytes }
  return classifyGateResponse({
    status: result.status,
    headers: result.headers,
    body: jsonBody(result.bytes)
  })
}
