import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CallCredentialService } from '../src/main/call-credential'
import { callAssertionPayload } from '../src/main/call-ceremony'
import { ServedCallers } from '../src/main/served-callers'
import {
  gateCaller,
  handleServedRoute,
  paymentRailOf,
  paymentReceiptOf,
  type DoorPayment,
  type ServedEndpointDeps,
  type V2Seated
} from '../src/main/served-endpoints'
import { createV2CallTokenVerifier } from '../src/main/v2-call-token'
import { noSeatSentence } from '../src/shared/seats'
import type { ServedTemplate } from '../src/main/session-served'

/**
 * IDENTITY v2 ADMISSION AT THE DOOR — the third body form at
 * POST /api/call/assert, and the gate order the architecture note fixed:
 * 401 sign in → 403 no seat → 402 buy → open.
 *
 * The 403 is what this phase adds, and the two rules that must never soften
 * are asserted here rather than read: a paid team refuses a token with NO SEAT
 * CLAIM (absence is not a wildcard), and the owner of the door plus a free
 * team are admitted without one because neither is admitted BY a seat.
 *
 * Every legacy path — the key-based TOFU sign-in and the v1 registryToken —
 * is walked in the same file, unchanged, so a regression there fails here.
 */

const OWNER = 'drej'
const SLUG = 'cookrew-alpha'
const DOOR = `@${OWNER}/${SLUG}`
const NOW = 1_800_000_000_000

const FREE: ServedTemplate = Object.freeze({
  serviceId: 'svc-cookrew-alpha',
  templateId: 'cookrew-alpha',
  slug: SLUG,
  access: 'account' as const
})
const PAID: ServedTemplate = Object.freeze({ ...FREE, access: 'paid' as const, priceUsd: '1.00' })

const registryKeys = generateKeyPairSync('ed25519')
const strangerKeys = generateKeyPairSync('ed25519')
const jwkOf = (key: KeyObject): Record<string, unknown> =>
  key.export({ format: 'jwk' }) as Record<string, unknown>
const registryJwk = jwkOf(registryKeys.publicKey)

const b64 = (value: string | Buffer): string => Buffer.from(value).toString('base64url')

/** Byte-for-byte registry/src/v2-tokens.ts: `${base64url(claims)}.${sig}`. */
function mintV2(
  claims: Record<string, unknown>,
  key: KeyObject = registryKeys.privateKey
): string {
  const body = b64(JSON.stringify(claims))
  return `${body}.${b64(sign(null, Buffer.from(body, 'utf8'), key))}`
}

const callToken = (over: Record<string, unknown> = {}): string =>
  mintV2({
    sub: 'mira',
    dev: 'dev-phone',
    scope: 'call',
    exp: NOW + 600_000,
    jti: 'jti-1',
    aud: DOOR,
    ...over
  })

describe('v2 admission — the assert, the 403 and the legacy paths', () => {
  let base = ''
  let issuer: CallCredentialService
  let callers: ServedCallers
  let seated: V2Seated[]
  let paid: DoorPayment[]
  let revoked: string[]
  let deps: ServedEndpointDeps

  const unused = (): never => {
    throw new Error('not reached by sign-in')
  }

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'v2-admission-'))
    issuer = new CallCredentialService({ base })
    callers = new ServedCallers()
    seated = []
    paid = []
    revoked = []
    deps = {
      issuer,
      callers,
      doorName: (template) => (template.slug === SLUG ? DOOR : null),
      v2Tokens: createV2CallTokenVerifier({
        keys: { fetch: async () => ({ jwk: registryJwk, revoked: [...revoked] }) },
        now: () => NOW
      }),
      onV2Seated: (entry) => void seated.push(entry),
      onPaid: (entry) => void paid.push(entry),
      admit: async () => unused(),
      hasOpenSession: () => false,
      endSession: () => false,
      grantBudget: { allowsNewSession: () => true },
      conductorFor: () => null,
      ask: async () => unused(),
      sessionForCaller: () => null,
      turns: { history: () => [] },
      traces: {
        index: async () => [],
        boundaryMarkers: async () => [],
        page: async () => ({ blocks: [], total: 0, source: 'claude' as const })
      },
      settle: async (payment) => (payment.startsWith('bad-') ? 'refused' : 'ok'),
      paymentTerms: (t) => (t.priceUsd ? { x402Version: 1, accepts: [] } : null),
      crewFace: (t) => ({
        name: 'COOKREW Alpha',
        serviceId: t.serviceId,
        slug: t.slug,
        address: `http://127.0.0.1:8639/${t.slug}`,
        version: 1,
        access: t.access,
        door: 'Pilot',
        agents: 2
      })
    }
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  const assert = (
    template: ServedTemplate,
    body: unknown
  ): ReturnType<typeof handleServedRoute> =>
    handleServedRoute(deps, template, 'POST', '/api/call/assert', { headers: {}, body })

  // ── the identity string ────────────────────────────────────────────────

  it('seats a v2 caller under their USERNAME, in the account namespace', async () => {
    const res = await assert(FREE, { v2Token: callToken() })
    expect(res!.status).toBe(200)
    expect(res!.body).toMatchObject({ ok: true, account: 'mira', seat: null })
    const token = (res!.body as { token: string }).token
    expect(issuer.verifyToken(token)).toMatchObject({
      sub: 'acct-mira',
      workspace: FREE.serviceId
    })
  })

  it('tells main who arrived, with the seat the token named', async () => {
    await assert(PAID, { v2Token: callToken({ seat: 'seat-7' }) })
    expect(seated).toEqual([
      {
        serviceId: PAID.serviceId,
        sub: 'acct-mira',
        username: 'mira',
        dev: 'dev-phone',
        seat: 'seat-7'
      }
    ])
  })

  it('never enrols a key for a v2 caller — there is none to enrol', async () => {
    await assert(FREE, { v2Token: callToken() })
    expect(callers.keyOf(FREE.serviceId, 'acct-mira')).toBeNull()
    expect(callers.keyOf(FREE.serviceId, 'mira')).toBeNull()
  })

  // ── 403: the seat rung ─────────────────────────────────────────────────

  it('REFUSES a paid team when the token carries no seat, in the sentence', async () => {
    const res = await assert(PAID, { v2Token: callToken() })
    expect(res!.status).toBe(403)
    expect(res!.body).toEqual({
      reason: 'no_seat',
      error: 'You are @mira. No seat here yet. Buy one, or ask @drej.'
    })
    expect(noSeatSentence('mira', OWNER)).toBe((res!.body as { error: string }).error)
    expect(seated).toEqual([])
  })

  it('admits a paid team WITH a seat', async () => {
    const res = await assert(PAID, { v2Token: callToken({ seat: 'seat-7' }) })
    expect(res!.status).toBe(200)
    expect(res!.body).toMatchObject({ account: 'mira', seat: 'seat-7' })
  })

  it('admits the OWNER of the door with no seat — they do not buy into their own team', async () => {
    const res = await assert(PAID, { v2Token: callToken({ sub: OWNER }) })
    expect(res!.status).toBe(200)
    expect(issuer.verifyToken((res!.body as { token: string }).token)).toMatchObject({
      sub: `acct-${OWNER}`
    })
  })

  it('admits a FREE team with no seat — signing in is the gate there', async () => {
    expect((await assert(FREE, { v2Token: callToken() }))!.status).toBe(200)
  })

  it('a seat ENDED at the registry stops admitting: the token is revoked by device', async () => {
    revoked = ['dev-phone']
    const res = await assert(PAID, { v2Token: callToken({ seat: 'seat-7' }) })
    expect(res!.status).toBe(401)
  })

  // ── 401: everything unreadable, answered identically ───────────────────

  it('answers the same bare 401 for every unreadable credential', async () => {
    const bodies: unknown[] = [
      { v2Token: callToken({ aud: '@drej/other' }) },
      { v2Token: callToken({ exp: NOW - 1 }) },
      { v2Token: callToken({ scope: 'session' }) },
      { v2Token: mintV2({ sub: 'mira', dev: 'd', scope: 'call', exp: NOW + 1, jti: 'j', aud: DOOR }, strangerKeys.privateKey) },
      { v2Token: 'malformed' },
      { v2Token: '' },
      { v2Token: 42 },
      // A token BESIDE another claim is two stories about who is knocking.
      { v2Token: callToken(), sub: 'mira' }
    ]
    for (const body of bodies) {
      const res = await assert(FREE, body)
      expect(res!.status).toBe(401)
      expect(res!.body).toEqual({})
    }
  })

  it('refuses a door that is not on the relay, and a door with no verifier wired', async () => {
    const lan: ServedTemplate = { ...FREE, slug: 'lan-only', serviceId: 'svc-lan' }
    expect((await assert(lan, { v2Token: callToken() }))!.status).toBe(401)
    const { v2Tokens: _dropped, ...without } = deps
    const res = await handleServedRoute(without, FREE, 'POST', '/api/call/assert', {
      headers: {},
      body: { v2Token: callToken() }
    })
    expect(res!.status).toBe(401)
  })

  it('keeps the 401 realm exactly as it was — the challenge rides on it', async () => {
    const res = await handleServedRoute(deps, FREE, 'GET', '/turns', {
      headers: {},
      body: null
    })
    expect(res!.status).toBe(401)
    expect(res!.headers?.['www-authenticate']).toMatch(
      new RegExp(`^Cookrew realm="${FREE.slug}", challenge=`)
    )
  })

  // ── the legacy paths, untouched ────────────────────────────────────────

  it('the key-based TOFU sign-in still works, and still refuses the acct- namespace', async () => {
    const caller = generateKeyPairSync('ed25519')
    const signIn = async (sub: string): Promise<number> => {
      const ch = await handleServedRoute(deps, FREE, 'POST', '/api/call/challenge', {
        headers: {},
        body: null
      })
      const challenge = (ch!.body as { challenge: string }).challenge
      const signature = sign(
        null,
        Buffer.from(callAssertionPayload(FREE.serviceId, sub, challenge), 'utf8'),
        caller.privateKey
      ).toString('base64url')
      const res = await assert(FREE, {
        sub,
        challenge,
        signature,
        jwk: jwkOf(caller.publicKey)
      })
      return res!.status
    }
    expect(await signIn('ana')).toBe(200)
    expect(await signIn('acct-mira')).toBe(401)
    expect(callers.keyOf(FREE.serviceId, 'ana')).not.toBeNull()
  })

  it('a v1 registryToken body is still routed to the v1 verifier, not the v2 one', async () => {
    // No v1 verifier is wired here, so the v1 path 401s — the point is that
    // the v2 branch did not swallow the body and seat anybody.
    const res = await assert(FREE, { registryToken: callToken() })
    expect(res!.status).toBe(401)
    expect(seated).toEqual([])
  })
})

describe('the 402, and the moment it is paid', () => {
  const template = PAID
  let base = ''
  let issuer: CallCredentialService
  let paid: DoorPayment[]
  let deps: ServedEndpointDeps

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'v2-admission-pay-'))
    issuer = new CallCredentialService({ base })
    paid = []
    deps = {
      issuer,
      callers: new ServedCallers(),
      onPaid: (entry) => void paid.push(entry),
      admit: async () => ({ workspaceId: 'w', sessionId: 's', created: true }),
      hasOpenSession: () => false,
      endSession: () => false,
      grantBudget: { allowsNewSession: () => true },
      conductorFor: () => null,
      ask: async () => '',
      sessionForCaller: () => null,
      turns: { history: () => [] },
      traces: {
        index: async () => [],
        boundaryMarkers: async () => [],
        page: async () => ({ blocks: [], total: 0, source: 'claude' as const })
      },
      settle: async (payment) =>
        payment.startsWith('bad-') ? 'refused' : payment.startsWith('iffy-') ? 'unverifiable' : 'ok',
      paymentTerms: () => ({ x402Version: 1, accepts: [] }),
      crewFace: (t) => ({
        name: 'COOKREW Alpha',
        serviceId: t.serviceId,
        slug: t.slug,
        address: `http://127.0.0.1:8639/${t.slug}`,
        version: 1,
        access: t.access,
        door: 'Pilot',
        agents: 2
      })
    }
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  const bearer = (): Record<string, string> => ({
    authorization: `Bearer ${issuer.mint('acct-mira', template.serviceId)}`
  })

  const stripeHeader = (session: string): string =>
    Buffer.from(JSON.stringify({ rail: 'stripe', session })).toString('base64')

  it('reports a settled CARD payment once, naming the payer and the Checkout id', async () => {
    const gate = await gateCaller(deps, template, {
      ...bearer(),
      'x-payment': stripeHeader('cs_test_123')
    })
    expect(gate.ok).toBe(true)
    expect(paid).toEqual([
      {
        serviceId: template.serviceId,
        sub: 'acct-mira',
        by: 'stripe',
        receipt: 'cs_test_123',
        amountUsd: '1.00'
      }
    ])
  })

  it('reports a settled USDC payment as x402, with a digest and never the envelope', async () => {
    const envelope = 'x402-signed-authorization-blob'
    await gateCaller(deps, template, { ...bearer(), 'x-payment': envelope })
    expect(paid).toHaveLength(1)
    expect(paid[0].by).toBe('x402')
    expect(paid[0].receipt).toMatch(/^x402:[A-Za-z0-9_-]{32}$/)
    expect(paid[0].receipt).not.toContain(envelope)
  })

  it('reports NOTHING for a refused or unverifiable settlement — a seat is a receipt', async () => {
    await gateCaller(deps, template, { ...bearer(), 'x-payment': 'bad-one' })
    await gateCaller(deps, template, { ...bearer(), 'x-payment': 'iffy-one' })
    expect(paid).toEqual([])
  })

  it('quotes rather than reports when no payment was presented', async () => {
    const gate = await gateCaller(deps, template, bearer())
    expect(gate.ok).toBe(false)
    expect(paid).toEqual([])
  })

  it('a door with no onPaid wired behaves exactly as it did before', async () => {
    const { onPaid: _dropped, ...without } = deps
    const gate = await gateCaller(without, template, {
      ...bearer(),
      'x-payment': stripeHeader('cs_test_9')
    })
    expect(gate.ok).toBe(true)
  })
})

describe('reading a payment envelope for its label', () => {
  it('names the rail without deciding anything with it', () => {
    const stripe = Buffer.from(JSON.stringify({ rail: 'stripe', session: 'cs_a' })).toString('base64')
    expect(paymentRailOf(stripe)).toBe('stripe')
    expect(paymentRailOf('anything-else')).toBe('x402')
    expect(paymentRailOf('')).toBe('x402')
  })

  it('takes a Checkout id verbatim and everything else as a digest', () => {
    const stripe = Buffer.from(JSON.stringify({ rail: 'stripe', session: 'cs_a1' })).toString('base64')
    expect(paymentReceiptOf(stripe)).toBe('cs_a1')
    const forged = Buffer.from(JSON.stringify({ rail: 'stripe', session: '../../etc' })).toString('base64')
    expect(paymentReceiptOf(forged)).toMatch(/^x402:/)
    expect(paymentReceiptOf('blob')).toBe(paymentReceiptOf('blob'))
    expect(paymentReceiptOf('blob')).not.toBe(paymentReceiptOf('other'))
  })
})
