import { describe, expect, it, beforeEach } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { ServedCallers } from '../src/main/served-callers'
import { callAssertionPayload } from '../src/main/call-ceremony'
import { CallCredentialService } from '../src/main/call-credential'
import { devSettle, handleServedRoute, type ServedEndpointDeps } from '../src/main/served-endpoints'
import type { ServedTemplate } from '../src/main/session-served'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'

/**
 * THE SERVED GATE, walked over the wire shapes — sign-up (TOFU), sign-in, the
 * per-session 402, the two payment voices, and the ask that reuses the session.
 * Real crypto (a real keypair signs the real payload), no HTTP.
 */

const FREE: ServedTemplate = Object.freeze({
  serviceId: 'svc-research',
  templateId: 'research-crew',
  slug: 'research',
  access: 'account' as const
})
const PAID: ServedTemplate = Object.freeze({ ...FREE, access: 'paid' as const, priceUsd: '2.50' })

let base = ''
let issuer: CallCredentialService
let callers: ServedCallers
let sessions: Map<string, { sessionId: string; workspaceId: string }>
let asked: string[]
let deps: ServedEndpointDeps

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'served-'))
  issuer = new CallCredentialService({ base })
  callers = new ServedCallers()
  sessions = new Map()
  asked = []
  deps = {
    issuer,
    callers,
    admit: async (serviceId, sub) => {
      const key = `${serviceId}/${sub}`
      const open = sessions.get(key)
      if (open) return { ...open, created: false }
      const made = { sessionId: `${sub}-1`, workspaceId: `ws-${sub}` }
      sessions.set(key, made)
      return { ...made, created: true }
    },
    hasOpenSession: (serviceId, sub) => sessions.has(`${serviceId}/${sub}`),
    conductorFor: (sessionId) => `orch-${sessionId}`,
    ask: async (conductorId, prompt) => {
      asked.push(`${conductorId}:${prompt}`)
      return 'the answer'
    },
    settle: devSettle,
    crewFace: (t) => ({
      name: 'Research Crew',
      serviceId: t.serviceId,
      slug: t.slug,
      version: 1,
      access: t.access,
      ...(t.priceUsd ? { priceUsd: t.priceUsd } : {}),
      door: 'Conductor',
      agents: 4
    })
  }
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

/** Walk the sign-in: challenge → sign → assert → token. */
async function signIn(template: ServedTemplate, sub = 'ana'): Promise<string> {
  const ch = await handleServedRoute(deps, template, 'POST', '/api/call/challenge', {
    headers: {},
    body: null
  })
  const challenge = (ch!.body as { challenge: string }).challenge
  const signature = sign(
    null,
    Buffer.from(callAssertionPayload(template.serviceId, sub, challenge), 'utf8'),
    privateKey
  ).toString('base64url')
  const res = await handleServedRoute(deps, template, 'POST', '/api/call/assert', {
    headers: {},
    body: { sub, challenge, signature, jwk }
  })
  expect(res!.status).toBe(200)
  return (res!.body as { token: string }).token
}

const ask = (
  template: ServedTemplate,
  headers: Record<string, string | undefined>,
  prompt = 'what is 2+2?'
): ReturnType<typeof handleServedRoute> =>
  handleServedRoute(deps, template, 'POST', '/ask', { headers, body: { prompt } })

describe('the public face', () => {
  it('answers /crew with what the owner published, and nothing else', async () => {
    const res = await handleServedRoute(deps, PAID, 'GET', '/crew', { headers: {}, body: null })
    expect(res!.status).toBe(200)
    expect(res!.body).toMatchObject({ door: 'Conductor', priceUsd: '2.50', access: 'paid' })
  })

  it('returns null for a path this surface does not own', async () => {
    expect(await handleServedRoute(deps, FREE, 'GET', '/anything', { headers: {}, body: null })).toBeNull()
  })
})

describe('sign-up and sign-in (TOFU)', () => {
  it('first assert with a key IS the sign-up; the token then opens /ask', async () => {
    const token = await signIn(FREE)
    const res = await ask(FREE, { authorization: `Bearer ${token}` })
    expect(res!.status).toBe(200)
    expect(res!.body).toMatchObject({ reply: 'the answer', created: true })
  })

  it('a known sub cannot re-key — a different key on the same name is one 401', async () => {
    await signIn(FREE)
    const { privateKey: otherKey, publicKey: otherPub } = generateKeyPairSync('ed25519')
    const ch = await handleServedRoute(deps, FREE, 'POST', '/api/call/challenge', { headers: {}, body: null })
    const challenge = (ch!.body as { challenge: string }).challenge
    const signature = sign(
      null,
      Buffer.from(callAssertionPayload(FREE.serviceId, 'ana', challenge), 'utf8'),
      otherKey
    ).toString('base64url')
    const res = await handleServedRoute(deps, FREE, 'POST', '/api/call/assert', {
      headers: {},
      body: { sub: 'ana', challenge, signature, jwk: otherPub.export({ format: 'jwk' }) }
    })
    expect(res!.status).toBe(401)
    expect(res!.body).toEqual({}) // no reason leaks
  })

  it('a spent or invented challenge is the same 401', async () => {
    const res = await handleServedRoute(deps, FREE, 'POST', '/api/call/assert', {
      headers: {},
      body: { sub: 'ana', challenge: 'invented', signature: 'x', jwk }
    })
    expect(res!.status).toBe(401)
  })
})

describe('the ask gate', () => {
  it('401s with a ceremony header when nothing (or junk) is presented', async () => {
    const missing = await ask(FREE, {})
    const junk = await ask(FREE, { authorization: 'Bearer nonsense' })
    for (const res of [missing, junk]) {
      expect(res!.status).toBe(401)
      expect(res!.headers?.['www-authenticate']).toMatch(/challenge=/)
    }
  })

  it('403s a genuine token minted for another service — never 401', async () => {
    const token = issuer.mint('ana', 'svc-other')
    const res = await ask(FREE, { authorization: `Bearer ${token}` })
    expect(res!.status).toBe(403)
    expect(res!.body).toEqual({ reason: 'workspace' })
  })

  it('refuses a prompt carrying control bytes, without stripping', async () => {
    const token = await signIn(FREE)
    const res = await ask(FREE, { authorization: `Bearer ${token}` }, 'hi\x1b[201~sneak')
    expect(res!.status).toBe(400)
    expect(asked).toHaveLength(0)
  })

  it('reuses the open session on the second ask', async () => {
    const token = await signIn(FREE)
    const first = await ask(FREE, { authorization: `Bearer ${token}` })
    const second = await ask(FREE, { authorization: `Bearer ${token}` })
    expect((first!.body as { created: boolean }).created).toBe(true)
    expect((second!.body as { created: boolean }).created).toBe(false)
    expect((second!.body as { sessionId: string }).sessionId).toBe(
      (first!.body as { sessionId: string }).sessionId
    )
  })
})

describe('the per-session 402 (paid door)', () => {
  it('quotes terms at session START, and only then', async () => {
    const token = await signIn(PAID)
    const res = await ask(PAID, { authorization: `Bearer ${token}` })
    expect(res!.status).toBe(402)
    expect(res!.body).toMatchObject({ terms: { amount: '2.50', asset: 'USDC' } })
  })

  it('a settling payment mints; the SAME session then asks free — R5 by construction', async () => {
    const token = await signIn(PAID)
    const paid = await ask(PAID, { authorization: `Bearer ${token}`, 'x-payment': 'tx-abc' })
    expect(paid!.status).toBe(200)
    // Mid-conversation there is no 402 branch left to hit: the session is open.
    const again = await ask(PAID, { authorization: `Bearer ${token}` })
    expect(again!.status).toBe(200)
    expect((again!.body as { created: boolean }).created).toBe(false)
  })

  it('speaks the two payment voices apart: refused accuses, unverifiable apologises', async () => {
    const token = await signIn(PAID)
    const bad = await ask(PAID, { authorization: `Bearer ${token}`, 'x-payment': 'bad-tx' })
    const iffy = await ask(PAID, { authorization: `Bearer ${token}`, 'x-payment': 'iffy-tx' })
    expect(bad!.body).toMatchObject({ reason: 'invalid', retryable: false })
    expect(iffy!.body).toMatchObject({ reason: 'unverifiable', retryable: true })
  })
})
