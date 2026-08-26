import { describe, expect, it } from 'vitest'
import {
  challengeFromAuthHeader,
  parseTerms,
  classifyGateResponse,
  fetchManifest,
  fetchBlob,
  type RawGateResponse,
  type GateTransport
} from '../src/main/preset-download'

/**
 * Slice 1 — the pure gate state machine a marketplace download runs against.
 *
 * The registry answers a manifest/blob request with 200/401/402/403/404 (see
 * registry/src/server.ts). This module turns ONE of those raw HTTP answers into
 * the next step the app takes, with no network and no side effect, so the
 * adversarial edges (a 401 with no challenge, a 402 with no terms, a 403 with a
 * reason nobody defined) are settled here where they are cheap to test.
 *
 * It is written adversarially: the registry is not trusted, so every missing or
 * malformed field FAILS CLOSED to a step the app cannot be tricked by.
 */

const res = (over: Partial<RawGateResponse>): RawGateResponse => ({
  status: 200,
  headers: {},
  body: null,
  ...over
})

const validTerms = {
  amount: '2.50',
  asset: 'USDC',
  chain: 'base',
  payTo: '0xabc0000000000000000000000000000000000abc',
  nonce: 'n-123',
  expiry: 1_900_000_000_000
}

describe('challengeFromAuthHeader — the 401 ceremony challenge', () => {
  it('reads the challenge from the WebAuthn header the registry sends', () => {
    expect(
      challengeFromAuthHeader('WebAuthn realm="market", challenge=abc123')
    ).toBe('abc123')
  })

  it('is case-insensitive on the scheme and tolerant of spacing', () => {
    expect(challengeFromAuthHeader('webauthn realm="market",challenge=xyz')).toBe('xyz')
  })

  it('returns null when the header is absent — a 401 with no ceremony is unusable', () => {
    expect(challengeFromAuthHeader(undefined)).toBeNull()
  })

  it('returns null when there is no challenge parameter', () => {
    expect(challengeFromAuthHeader('WebAuthn realm="market"')).toBeNull()
  })

  it('returns null for an empty challenge rather than an empty ceremony', () => {
    expect(challengeFromAuthHeader('WebAuthn challenge=')).toBeNull()
  })
})

describe('parseTerms — the 402 offer, from a registry we do not trust', () => {
  it('accepts a well-formed USDC terms object', () => {
    expect(parseTerms(validTerms)).toEqual(validTerms)
  })

  it('rejects a non-object', () => {
    expect(parseTerms(null)).toBeNull()
    expect(parseTerms('2.50 USDC')).toBeNull()
  })

  it('rejects an asset other than USDC — the only asset the wire allows', () => {
    expect(parseTerms({ ...validTerms, asset: 'ETH' })).toBeNull()
  })

  it('rejects a missing payTo — money to nowhere is not an offer', () => {
    const { payTo, ...rest } = validTerms
    expect(parseTerms(rest)).toBeNull()
  })

  it('rejects a non-integer expiry', () => {
    expect(parseTerms({ ...validTerms, expiry: 'soon' })).toBeNull()
  })

  it('rejects an empty chain — a transfer needs to know its chain', () => {
    expect(parseTerms({ ...validTerms, chain: '' })).toBeNull()
  })
})

describe('classifyGateResponse — one HTTP answer → one next step', () => {
  it('200 → ready, carrying the body for the caller to verify itself', () => {
    const manifest = { schema: 'cookrew.preset/1' }
    expect(classifyGateResponse(res({ status: 200, body: manifest }))).toEqual({
      kind: 'ready',
      body: manifest
    })
  })

  it('401 with a challenge → enrol', () => {
    expect(
      classifyGateResponse(
        res({
          status: 401,
          headers: { 'www-authenticate': 'WebAuthn realm="market", challenge=c1' }
        })
      )
    ).toEqual({ kind: 'enrol', challenge: 'c1' })
  })

  it('401 with no usable challenge → error, never a ceremony we cannot run', () => {
    expect(classifyGateResponse(res({ status: 401, headers: {} }))).toEqual({
      kind: 'error',
      status: 401
    })
  })

  it('402 with terms → pay (retryable defaults false, no reason on the opening offer)', () => {
    expect(classifyGateResponse(res({ status: 402, body: { terms: validTerms } }))).toEqual({
      kind: 'pay',
      terms: validTerms,
      retryable: false
    })
  })

  it('402 after a failed settlement carries reason and retryable', () => {
    expect(
      classifyGateResponse(
        res({ status: 402, body: { terms: validTerms, reason: 'expired', retryable: true } })
      )
    ).toEqual({ kind: 'pay', terms: validTerms, retryable: true, reason: 'expired' })
  })

  it('402 with no parseable terms → error, never a pay sheet with nothing to pay', () => {
    expect(classifyGateResponse(res({ status: 402, body: {} }))).toEqual({
      kind: 'error',
      status: 402
    })
  })

  it('403 with a known reason → denied; scope is the one that is retryable', () => {
    expect(classifyGateResponse(res({ status: 403, body: { reason: 'revoked' } }))).toEqual({
      kind: 'denied',
      reason: 'revoked',
      retryable: false
    })
    expect(classifyGateResponse(res({ status: 403, body: { reason: 'scope' } }))).toEqual({
      kind: 'denied',
      reason: 'scope',
      retryable: true
    })
  })

  it('403 with an unknown reason → denied/unknown rather than a crash', () => {
    expect(classifyGateResponse(res({ status: 403, body: { reason: 'teapot' } }))).toEqual({
      kind: 'denied',
      reason: 'unknown',
      retryable: false
    })
  })

  it('404 → gone', () => {
    expect(classifyGateResponse(res({ status: 404 }))).toEqual({ kind: 'gone' })
  })

  it('any other status → error, fail closed', () => {
    expect(classifyGateResponse(res({ status: 500 }))).toEqual({ kind: 'error', status: 500 })
    expect(classifyGateResponse(res({ status: 302 }))).toEqual({ kind: 'error', status: 302 })
  })
})

describe('fetchManifest / fetchBlob — IO over an injectable transport', () => {
  const capture = (
    result: { status: number; headers?: Record<string, string>; bytes: Buffer }
  ): { transport: GateTransport; calls: { url: string; headers: Record<string, string> }[] } => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const transport: GateTransport = async (url, init) => {
      calls.push({ url, headers: init.headers })
      return { status: result.status, headers: result.headers ?? {}, bytes: result.bytes }
    }
    return { transport, calls }
  }

  it('builds the manifest URL and parses a 200 body into the manifest object', async () => {
    const manifest = { schema: 'cookrew.preset/1', version: 3 }
    const { transport, calls } = capture({ status: 200, bytes: Buffer.from(JSON.stringify(manifest)) })
    const step = await fetchManifest('https://mkt.example/', 'sha256:aa', { transport })
    expect(step).toEqual({ kind: 'ready', body: manifest })
    expect(calls[0].url).toBe('https://mkt.example/v1/presets/sha256%3Aaa/manifest')
  })

  it('sends the bearer token and payment proof as the headers the registry reads', async () => {
    const { transport, calls } = capture({ status: 200, bytes: Buffer.from('{}') })
    await fetchManifest('https://mkt.example', 'sha256:aa', {
      transport,
      token: 'tok-1',
      payment: 'proof-1'
    })
    expect(calls[0].headers.authorization).toBe('Bearer tok-1')
    expect(calls[0].headers['x-payment']).toBe('proof-1')
  })

  it('sends no auth header when no credential is present', async () => {
    const { transport, calls } = capture({ status: 200, bytes: Buffer.from('{}') })
    await fetchManifest('https://mkt.example', 'sha256:aa', { transport })
    expect(calls[0].headers.authorization).toBeUndefined()
    expect(calls[0].headers['x-payment']).toBeUndefined()
  })

  it('classifies a 402 manifest answer straight through the state machine', async () => {
    const { transport } = capture({
      status: 402,
      bytes: Buffer.from(JSON.stringify({ terms: validTerms }))
    })
    const step = await fetchManifest('https://mkt.example', 'sha256:aa', { transport })
    expect(step).toEqual({ kind: 'pay', terms: validTerms, retryable: false })
  })

  it('fetchBlob returns the RAW bytes on 200, not a JSON round-trip', async () => {
    const raw = Buffer.from('{"name":"Team",  "nodes":[]}') // odd spacing must survive
    const { transport, calls } = capture({ status: 200, bytes: raw })
    const step = await fetchBlob('https://mkt.example', 'sha256:bb', { transport })
    expect(step).toEqual({ kind: 'ready', body: raw })
    expect((step as { body: Buffer }).body.equals(raw)).toBe(true)
    expect(calls[0].url).toBe('https://mkt.example/v1/blobs/sha256%3Abb')
  })

  it('fetchBlob classifies a gated (401) blob answer', async () => {
    const { transport } = capture({
      status: 401,
      headers: { 'www-authenticate': 'WebAuthn challenge=c9' },
      bytes: Buffer.alloc(0)
    })
    const step = await fetchBlob('https://mkt.example', 'sha256:bb', { transport })
    expect(step).toEqual({ kind: 'enrol', challenge: 'c9' })
  })
})
