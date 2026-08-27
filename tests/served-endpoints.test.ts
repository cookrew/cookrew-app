import { describe, expect, it, beforeEach } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { ServedCallers } from '../src/main/served-callers'
import { callAssertionPayload } from '../src/main/call-ceremony'
import { CallCredentialService } from '../src/main/call-credential'
import { handleServedRoute, type ServedEndpointDeps } from '../src/main/served-endpoints'
import type { ServedTemplate } from '../src/main/session-served'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import type { TurnRecord } from '../src/shared/turn'
import type { TraceBlock } from '../src/shared/trace-blocks'
import { SERVED_TRANSCRIPT_PATHS } from '../src/shared/served-transcript'
import { MKT_GATE } from '../src/shared/marketplace-copy'

/**
 * The payment rail, stubbed at the seam.
 *
 * devSettle used to live in production and be imported here; it admitted any
 * 'tx-' string, so the paid door was decorative. The real rail is x402-rail.ts
 * and has its own suite. What THIS suite still needs is the three answers, so
 * the gate's own branches (the two voices, mint-or-not) stay covered without a
 * chain — which is exactly what the seam is for.
 */
const stubSettle = async (payment: string): Promise<'ok' | 'refused' | 'unverifiable'> => {
  if (payment.startsWith('bad-')) return 'refused'
  if (payment.startsWith('iffy-')) return 'unverifiable'
  return payment.length > 0 ? 'ok' : 'refused'
}

/** Terms are behind the seam too; their real shape is x402-rail's business. */
const stubTerms = (t: { priceUsd?: string }): unknown =>
  t.priceUsd
    ? {
        x402Version: 1,
        accepts: [{ scheme: 'exact', network: 'base-sepolia', maxAmountRequired: t.priceUsd }]
      }
    : null



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
let settled: string[]
let turnHistory: Map<string, TurnRecord[]>
let traceHistory: Map<string, TraceBlock[]>
let transcriptReads: string[]
let deps: ServedEndpointDeps

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'served-'))
  issuer = new CallCredentialService({ base })
  callers = new ServedCallers()
  sessions = new Map()
  asked = []
  settled = []
  turnHistory = new Map()
  traceHistory = new Map()
  transcriptReads = []
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
    // Lent nothing, so nothing to exceed — the default every crew served
    // before grants existed still gets.
    grantBudget: { allowsNewSession: () => true },
    conductorFor: (sessionId) => `orch-${sessionId}`,
    ask: async (conductorId, prompt) => {
      asked.push(`${conductorId}:${prompt}`)
      return 'the answer'
    },
    sessionForCaller: (serviceId, sub) => {
      const session = sessions.get(`${serviceId}/${sub}`)
      return session
        ? { conductorId: `orch-${session.sessionId}` }
        : null
    },
    turns: {
      history: (terminalId) => {
        transcriptReads.push(`turns:${terminalId}`)
        return turnHistory.get(terminalId) ?? []
      }
    },
    traces: {
      index: async (terminalId) => {
        transcriptReads.push(`index:${terminalId}`)
        return (traceHistory.get(terminalId) ?? []).map((block) => ({
          index: block.index,
          title: block.prompt
        }))
      },
      boundaryMarkers: async (terminalId) => {
        transcriptReads.push(`markers:${terminalId}`)
        return []
      },
      page: async (terminalId, request) => {
        transcriptReads.push(`trace:${terminalId}:${JSON.stringify(request)}`)
        const blocks = traceHistory.get(terminalId) ?? []
        return { blocks, total: blocks.length, source: 'claude' as const }
      }
    },
    settle: async (payment) => {
      settled.push(payment)
      return stubSettle(payment)
    },
    paymentTerms: stubTerms,
    crewFace: (t) => ({
      name: 'Research Crew',
      serviceId: t.serviceId,
      slug: t.slug,
      address: `http://127.0.0.1:8639/${t.slug}`,
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

const get = (
  template: ServedTemplate,
  pathname: string,
  headers: Record<string, string | undefined>,
  query?: Record<string, string>
): ReturnType<typeof handleServedRoute> =>
  handleServedRoute(deps, template, 'GET', pathname, { headers, body: null, query })

const record = (index: number, prompt = `prompt ${index}`): TurnRecord => ({
  index,
  uuid: `turn-${index}`,
  prompt,
  reply: `reply ${index}`,
  startedAt: index * 100,
  endedAt: index * 100 + 50,
  final: true
})

const block = (index: number, prompt = `prompt ${index}`): TraceBlock => ({
  id: `turn-${index}`,
  index,
  prompt,
  reply: `reply ${index}`,
  activity: [],
  startedAt: index * 100,
  endedAt: index * 100 + 50,
  final: true
})

describe('the public face', () => {
  it('answers /crew with what the owner published, and nothing else', async () => {
    const res = await handleServedRoute(deps, PAID, 'GET', '/crew', { headers: {}, body: null })
    expect(res!.status).toBe(200)
    expect(res!.body).toMatchObject({
      door: 'Conductor',
      priceUsd: '2.50',
      access: 'paid',
      paymentRails: ['x402']
    })
  })

  it('renders the crew address with price and every live way to pay', async () => {
    deps.paymentTerms = () => ({
      x402Version: 1,
      accepts: [
        { scheme: 'exact', network: 'base-sepolia' },
        { scheme: 'stripe-checkout', network: 'stripe' }
      ]
    })
    const res = await handleServedRoute(deps, PAID, 'GET', '/', { headers: {}, body: null })
    expect(res!.headers?.['content-type']).toContain('text/html')
    expect(res!.headers?.['content-security-policy']).toContain("default-src 'none'")
    expect(res!.body).toMatch(/^<!doctype html>/)
    expect(res!.body).toContain('2.50 USD to start')
    expect(res!.body).toContain('Pay with USDC on Base')
    expect(res!.body).toContain('Open Stripe Checkout from Cookrew')
  })

  it('shows the Stripe return note only on the payment-received URL', async () => {
    const ordinary = await handleServedRoute(deps, PAID, 'GET', '/', { headers: {}, body: null })
    const returned = await handleServedRoute(deps, PAID, 'GET', '/', {
      headers: {},
      body: null,
      query: { payment: 'received' }
    })
    expect(ordinary!.body).not.toContain('Payment received')
    expect(returned!.body).toContain('Payment received — retry your call in Cookrew.')
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

describe("the caller's own transcript surface", () => {
  const paths = Object.values(SERVED_TRANSCRIPT_PATHS)

  it('uses the same 401 and wrong-service 403 bearer scope as /ask', async () => {
    for (const pathname of paths) {
      const missing = await get(FREE, pathname, {})
      const junk = await get(FREE, pathname, { authorization: 'Bearer nonsense' })
      for (const response of [missing, junk]) {
        expect(response!.status, pathname).toBe(401)
        expect(response!.headers?.['www-authenticate'], pathname).toMatch(/challenge=/)
      }

      const wrong = issuer.mint('ana', 'svc-other')
      const scoped = await get(FREE, pathname, { authorization: `Bearer ${wrong}` })
      expect(scoped!.status, pathname).toBe(403)
      expect(scoped!.body, pathname).toEqual({ reason: 'workspace' })
    }
  })

  it('404s every transcript read until this caller has their own open session', async () => {
    const token = await signIn(FREE, 'bob')
    for (const pathname of paths) {
      const response = await get(
        FREE,
        pathname,
        { authorization: `Bearer ${token}` },
        // Supplying somebody else's known id cannot influence resolution.
        { sessionId: 'ana-1', terminalId: 'orch-ana-1' }
      )
      expect(response!.status, pathname).toBe(404)
      expect(response!.body, pathname).toEqual({})
    }
    expect(transcriptReads).toEqual([])
  })

  it('serves turns and trace blocks only from the credential subject’s orch', async () => {
    const anaToken = await signIn(FREE, 'ana')
    await ask(FREE, { authorization: `Bearer ${anaToken}` }, 'open ana')
    const bobToken = await signIn(FREE, 'bob')
    await ask(FREE, { authorization: `Bearer ${bobToken}` }, 'open bob')

    turnHistory.set('orch-ana-1', [record(1), record(2)])
    turnHistory.set('orch-bob-1', [record(1, 'bob only')])
    traceHistory.set('orch-ana-1', [block(1), block(2)])
    traceHistory.set('orch-bob-1', [block(1, 'bob only')])

    const auth = { authorization: `Bearer ${anaToken}` }
    const turns = await get(FREE, '/turns', auth)
    expect((turns!.body as TurnRecord[]).map((turn) => turn.prompt)).toEqual([
      'prompt 1',
      'prompt 2'
    ])

    const page = await get(FREE, '/turns', auth, { offset: '1', limit: '1' })
    expect(page!.body).toMatchObject({
      turns: [{ index: 2, prompt: 'prompt 2' }],
      total: 2,
      offset: 1
    })

    const older = await get(FREE, '/turns', auth, { beforeIndex: '2', limit: '1' })
    expect(older!.body).toMatchObject({
      turns: [{ index: 1, prompt: 'prompt 1' }],
      total: 2,
      offset: 0
    })

    const trace = await get(FREE, '/trace', auth, { aroundIndex: '2', limit: '5' })
    expect(trace!.body).toMatchObject({
      blocks: [{ id: 'turn-1' }, { id: 'turn-2' }],
      total: 2,
      source: 'claude'
    })
    expect((await get(FREE, '/trace/index', auth))!.body).toEqual([
      { index: 1, title: 'prompt 1' },
      { index: 2, title: 'prompt 2' }
    ])
    expect((await get(FREE, '/trace/markers', auth))!.body).toEqual([])

    expect(transcriptReads.every((read) => read.includes('orch-ana-1'))).toBe(true)
    expect(transcriptReads.some((read) => read.includes('orch-bob-1'))).toBe(false)
    expect(transcriptReads).toContain(
      'trace:orch-ana-1:{"aroundIndex":2,"limit":5}'
    )
  })
})

describe("the owner's grant budget", () => {
  it('refuses a NEW session with 429 and a reason, once the lend is spent', async () => {
    deps.grantBudget = { allowsNewSession: () => false }
    const token = await signIn(FREE)
    const res = await ask(FREE, { authorization: `Bearer ${token}` })
    // 429, not 503: nothing is broken, and "try again shortly" would be a lie
    // about a wait that never ends.
    expect(res!.status).toBe(429)
    expect(res!.body).toMatchObject({ reason: 'budget' })
    // Nothing was minted and nothing was asked of a crew.
    expect(asked).toHaveLength(0)
  })

  it('never interrupts a session that is already OPEN', async () => {
    // The grant was spent on this caller when their session minted. Cutting
    // them off mid-conversation would end a call for a limit that has nothing
    // to do with the message they just sent.
    const token = await signIn(FREE)
    expect((await ask(FREE, { authorization: `Bearer ${token}` }))!.status).toBe(200)
    deps.grantBudget = { allowsNewSession: () => false }
    const again = await ask(FREE, { authorization: `Bearer ${token}` })
    expect(again!.status).toBe(200)
    expect((again!.body as { created: boolean }).created).toBe(false)
  })

  it('is the OWNER’s limit, so paying cannot buy past it — and is NOT charged for', async () => {
    // A caller's payment and an owner's lend bound two different people's
    // spending; collapsing them would let a stranger purchase more of the
    // owner's credential than the owner lent.
    //
    // The order is the real assertion. A budget checked after the 402 reads
    // correct and takes the money for a session that was never going to exist,
    // so the settle spy — not the status — is what makes this test worth having.
    deps.grantBudget = { allowsNewSession: () => false }
    const token = await signIn(PAID)
    const res = await ask(PAID, { authorization: `Bearer ${token}`, 'x-payment': 'tx-abc' })
    expect(res!.status).toBe(429)
    expect(settled).toEqual([])
    expect(asked).toHaveLength(0)
  })

  it('does not even QUOTE a paid crew it cannot mint', async () => {
    deps.grantBudget = { allowsNewSession: () => false }
    const token = await signIn(PAID)
    const res = await ask(PAID, { authorization: `Bearer ${token}` })
    // Never 402: quoting a price for a session that cannot be created is an
    // offer we cannot keep.
    expect(res!.status).toBe(429)
  })
})

describe('the per-session 402 (paid door)', () => {
  it('names an unquotable door without claiming a payment was checked', async () => {
    deps.paymentTerms = () => null
    const token = await signIn(PAID)
    const res = await ask(PAID, { authorization: `Bearer ${token}` })
    expect(res!.status).toBe(503)
    expect(res!.body).toEqual({
      reason: 'payment_unavailable',
      error: MKT_GATE['mkt.gate.payment.unavailable']
    })
    expect(settled).toEqual([])
  })

  it('quotes terms at session START, and only then', async () => {
    const token = await signIn(PAID)
    const res = await ask(PAID, { authorization: `Bearer ${token}` })
    expect(res!.status).toBe(402)
    // The gate hands back whatever the RAIL quoted and inspects none of it.
    // This used to assert {amount, asset:'USDC', chain:'dev'} — terms the gate
    // built itself, which is the coupling that made the rail unswappable.
    expect(res!.body).toMatchObject({ terms: stubTerms(PAID) as object })
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

  it('a payment that does not settle MINTS NOTHING and never wakes the crew', async () => {
    // Gate A5's safety half, and the property the old 'tx-' stub could not
    // have: refusal must happen BEFORE admit(), or a caller who paid nothing
    // still costs a session boot — and, once minted, hasOpenSession would let
    // their next ask through for free.
    const token = await signIn(PAID)
    for (const payment of ['bad-tx', 'iffy-tx', '']) {
      const res = await ask(PAID, { authorization: `Bearer ${token}`, 'x-payment': payment })
      expect(res!.status).toBe(402)
    }
    expect(sessions.size).toBe(0)
    expect(asked).toEqual([])

    // And the door is not poisoned: a settling payment still works afterwards.
    const good = await ask(PAID, { authorization: `Bearer ${token}`, 'x-payment': 'tx-abc' })
    expect(good!.status).toBe(200)
    expect(sessions.size).toBe(1)
  })

  it('speaks the two payment voices apart: refused accuses, unverifiable apologises', async () => {
    const token = await signIn(PAID)
    const bad = await ask(PAID, { authorization: `Bearer ${token}`, 'x-payment': 'bad-tx' })
    const iffy = await ask(PAID, { authorization: `Bearer ${token}`, 'x-payment': 'iffy-tx' })
    expect(bad!.body).toMatchObject({ reason: 'invalid', retryable: false })
    expect(iffy!.body).toMatchObject({ reason: 'unverifiable', retryable: true })
  })
})
