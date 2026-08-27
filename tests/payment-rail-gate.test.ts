import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServedCallers } from '../src/main/served-callers'
import { handleServedRoute, type ServedEndpointDeps } from '../src/main/served-endpoints'
import type { ServedTemplate } from '../src/main/session-served'
import {
  createStripeRedemptionStore,
  stripeSettle,
  type StripeGet
} from '../src/main/stripe-rail'
import {
  BASE_SEPOLIA,
  createNonceLedger,
  paymentRequirements,
  x402Settle,
  type X402Config
} from '../src/main/x402-rail'

const PAID: ServedTemplate = Object.freeze({
  serviceId: 'svc-payments',
  templateId: 'payments-crew',
  slug: 'payments',
  access: 'paid' as const,
  priceUsd: '2.50'
})
const SUB = 'qa-caller'
const STRIPE_CONFIG = { secretKey: 'injected-test-value' }
const STRIPE_SESSION = 'cs_QA_REDACTED'
const stripeEnvelope = Buffer.from(
  JSON.stringify({ rail: 'stripe', session: STRIPE_SESSION })
).toString('base64')

const dirs: string[] = []
const ledgerPath = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'payment-gate-'))
  dirs.push(dir)
  return path.join(dir, 'stripe-redemptions.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function gate(settle: ServedEndpointDeps['settle']): {
  deps: ServedEndpointDeps
  admissions: string[]
} {
  const admissions: string[] = []
  return {
    admissions,
    deps: {
      issuer: {
        challenge: () => 'challenge',
        consumeChallenge: () => true,
        mint: () => 'token',
        verifyToken: (token) =>
          token === 'valid' ? { sub: SUB, workspace: PAID.serviceId } : null
      },
      callers: new ServedCallers(),
      admit: async (_serviceId, sub) => {
        admissions.push(sub)
        return { workspaceId: 'ws-1', sessionId: 'session-1', created: true }
      },
      hasOpenSession: () => false,
      conductorFor: () => 'orch-1',
      ask: async () => 'crew answer',
      grantBudget: { allowsNewSession: () => true },
      settle,
      paymentTerms: () => ({ accepts: [] }),
      crewFace: () => ({
        name: 'Payments Crew',
        serviceId: PAID.serviceId,
        slug: PAID.slug,
        address: `http://127.0.0.1:8639/${PAID.slug}`,
        version: 1,
        access: 'paid',
        priceUsd: PAID.priceUsd,
        door: 'Conductor',
        agents: 2
      })
    }
  }
}

const ask = (deps: ServedEndpointDeps, payment: string) =>
  handleServedRoute(deps, PAID, 'POST', '/ask', {
    headers: { authorization: 'Bearer valid', 'x-payment': payment },
    body: { prompt: 'answer safely' }
  })

const stripeReply = (paymentStatus: 'paid' | 'unpaid') => ({
  ok: true,
  status: 200,
  json: {
    id: STRIPE_SESSION,
    payment_status: paymentStatus,
    amount_total: 250,
    currency: 'usd',
    metadata: { serviceId: PAID.serviceId, sub: SUB, slug: PAID.slug }
  }
})

describe('payment rails at the admission boundary', () => {
  it('refuses an unpaid Stripe session before admission', async () => {
    const file = ledgerPath()
    const get: StripeGet = async () => stripeReply('unpaid')
    const { deps, admissions } = gate((header, amountUsd) =>
      stripeSettle(
        { config: STRIPE_CONFIG, get, redemptions: createStripeRedemptionStore(file) },
        header,
        { amountUsd, serviceId: PAID.serviceId, sub: SUB }
      )
    )

    const response = await ask(deps, stripeEnvelope)

    expect(response?.status).toBe(402)
    expect(response?.body).toEqual({ reason: 'invalid', retryable: false })
    expect(admissions).toEqual([])
  })

  it('makes Stripe unreachability retryable and admits nothing', async () => {
    const file = ledgerPath()
    const get: StripeGet = async () => Promise.reject(new Error('offline'))
    const { deps, admissions } = gate((header, amountUsd) =>
      stripeSettle(
        { config: STRIPE_CONFIG, get, redemptions: createStripeRedemptionStore(file) },
        header,
        { amountUsd, serviceId: PAID.serviceId, sub: SUB }
      )
    )

    const response = await ask(deps, stripeEnvelope)

    expect(response?.status).toBe(402)
    expect(response?.body).toEqual({ reason: 'unverifiable', retryable: true })
    expect(admissions).toEqual([])
  })

  it('refuses a redeemed Stripe session through a new store instance after restart', async () => {
    const file = ledgerPath()
    const get = vi.fn<StripeGet>().mockResolvedValue(stripeReply('paid'))
    const settle = (header: string, amountUsd: string) =>
      stripeSettle(
        { config: STRIPE_CONFIG, get, redemptions: createStripeRedemptionStore(file) },
        header,
        { amountUsd, serviceId: PAID.serviceId, sub: SUB }
      )

    const firstApp = gate(settle)
    const accepted = await ask(firstApp.deps, stripeEnvelope)
    expect(accepted?.status).toBe(200)
    expect(firstApp.admissions).toEqual([SUB])

    // A new dependency graph and a new store object model an app restart. The
    // durable file must stop the replay before Stripe or admit is touched.
    const restartedApp = gate(settle)
    const replay = await ask(restartedApp.deps, stripeEnvelope)
    expect(replay?.status).toBe(402)
    expect(replay?.body).toEqual({ reason: 'invalid', retryable: false })
    expect(restartedApp.admissions).toEqual([])
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('refuses a bogus x402 value before facilitator traffic or admission', async () => {
    const config: X402Config = {
      ...BASE_SEPOLIA,
      payTo: '0x1111111111111111111111111111111111111111'
    }
    const requirements = paymentRequirements(config, PAID.priceUsd!, '/payments/ask', 'QA')!
      .accepts[0]
    const post = vi.fn().mockRejectedValue(new Error('must not be reached'))
    const { deps, admissions } = gate((header) =>
      x402Settle({ config, post, seen: createNonceLedger() }, header, requirements)
    )

    const response = await ask(deps, 'bogus-x402-reference')

    expect(response?.status).toBe(402)
    expect(response?.body).toEqual({ reason: 'invalid', retryable: false })
    expect(post).not.toHaveBeenCalled()
    expect(admissions).toEqual([])
  })
})
