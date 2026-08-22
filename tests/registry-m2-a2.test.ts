import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { createRegistry } from '../registry/src/server'
import { IdentityService, type IdentityConfig } from '../registry/src/identity'
import { makeAuthorize, type PricingDeps } from '../registry/src/authorize'
import { PayoutStore } from '../registry/src/payouts'
import { ReceiptStore } from '../registry/src/receipts'
import { MemoryPaymentNonces, purchaseBinding, type Terms } from '../registry/src/terms'
import {
  PAYMENT_FAILURES,
  encodePaymentProof,
  isPaymentFailure,
  isRetryable,
  needsFreshQuote,
  type PaymentFailure
} from '../registry/src/payment'
import {
  devFacilitator,
  DEV_REFUSE_PREFIX,
  DEV_UNREACHABLE_PREFIX
} from '../registry/src/facilitator-dev'
import type { Facilitator, SettlementRequest } from '../registry/src/facilitator'
import { FORBIDDEN_REASONS } from '../src/shared/preset-manifest'
import { buildManifest, signManifest } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
import type { PresetPricing } from '../src/shared/preset-manifest'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

/**
 * M2-A2 — VERIFYING AN X-PAYMENT.
 *
 * No chain, no network, no keys: the facilitator is injected and the cases that
 * matter — expired, replayed, refused — are produced from a clock and a store.
 * That is the point of the seam rather than a convenience.
 *
 * Magpie's C16 is the load-bearing gate here: the three reasons must be
 * DISTINCT and CONSTRUCTIBLE. Distinct because each names a different thing
 * that happened to a buyer; constructible because a reason nobody can produce
 * is a reason nobody has seen the server actually answer.
 */

const PAYEE = '0xA1b2C3d4E5f6789012345678901234567890aBcD'
const IDENTITY = 'cred-buyer'
const ONE_TIME: PresetPricing = { model: 'one-time', amount: '12.00', asset: 'USDC' }
const CONFIG: IdentityConfig = {
  rpId: 'localhost',
  origin: 'http://localhost:8790',
  tokenTtlMs: 10 * 60 * 1000,
  challengeTtlMs: 90 * 1000
}
const TTL = 15 * 60 * 1000

const terminal = (name: string): CanvasNode =>
  ({
    kind: 'terminal', id: 't1', name, preset: 'Claude Code', command: 'npm test',
    cwd: '/w', orch: false, role: null, position: { x: 0, y: 0 }, size: { width: 1, height: 1 }
  }) as CanvasNode

const b64 = (b: Buffer): string => b.toString('base64url')

function authenticator(credentialId: string) {
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const authData = Buffer.concat([
    createHash('sha256').update(CONFIG.rpId).digest(),
    Buffer.from([0x01]),
    Buffer.from([0, 0, 0, 1])
  ])
  return {
    credentialId,
    jwk: keys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
    assert(challenge: string) {
      const clientData = Buffer.from(
        JSON.stringify({ type: 'webauthn.get', origin: CONFIG.origin, challenge }),
        'utf8'
      )
      return {
        credentialId,
        clientDataJSON: b64(clientData),
        authenticatorData: b64(authData),
        signature: b64(
          sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), keys.privateKey)
        )
      }
    }
  }
}

let base = ''
let store: RegistryStore
let log: TransparencyLog
let identity: IdentityService
let payouts: PayoutStore
let author: { publicKey: KeyObject; privateKey: KeyObject }
let auth: ReturnType<typeof authenticator>
let clock = 1_700_000_000_000
let pricing: PricingDeps
let settled: SettlementRequest[] = []
/** Swappable per test, so a refusal is one assignment rather than a rewire. */
let facilitatorVerdict: () => { ok: true } | { ok: false; reason: PaymentFailure }

const seed = (name: string, priced = true, identityId = IDENTITY): string => {
  const snapshot: TeamSnapshot = {
    name, savedAt: 1, dir: '/w', nodes: [terminal(name)], connections: [], turns: {}
  }
  const built = buildManifest({
    scrub: scrubForPublish(snapshot),
    version: 1,
    author: { handle: 'drej' },
    ...(priced ? { pricing: ONE_TIME } : {})
  })
  if (!built.ok) throw new Error(`refused: ${built.reason}`)
  const manifest = signManifest(built.manifest, author.privateKey)
  store.putBlob(built.teamBytes)
  store.putManifest({ manifest, teamName: name, visibility: 'identified', identityId })
  return manifest.id
}

let server: { url: string; close: () => void }

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), 'registry-m2-a2-'))
  store = new RegistryStore(base)
  log = new TransparencyLog(base)
  identity = new IdentityService(base, CONFIG)
  payouts = new PayoutStore(base)
  author = generateKeyPairSync('ed25519')
  auth = authenticator(IDENTITY)
  identity.register(auth.credentialId, auth.jwk)
  payouts.bind(IDENTITY, PAYEE)
  clock = 1_700_000_000_000
  settled = []
  facilitatorVerdict = () => ({ ok: true })
  const recording: Facilitator = {
    settle(request) {
      settled = [...settled, request]
      return facilitatorVerdict()
    }
  }
  pricing = {
    payouts,
    config: { chain: 'base', ttlMs: TTL },
    nonces: new MemoryPaymentNonces(),
    facilitator: recording,
    receipts: new ReceiptStore(base),
    now: () => clock
  }
  const s = createRegistry({
    store, log, identity, pricing, dev: true,
    authorize: makeAuthorize(store, identity, pricing)
  })
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address() as AddressInfo
  server = { url: `http://127.0.0.1:${port}`, close: () => s.close() }
})
afterEach(() => {
  server.close()
  rmSync(base, { recursive: true, force: true })
})

async function downloadToken(): Promise<string> {
  const minted = (await (
    await fetch(`${server.url}/v1/identity/assert`, {
      method: 'POST',
      body: JSON.stringify({ ...auth.assert(identity.challenge()), scope: 'download' })
    })
  ).json()) as { token: string }
  return minted.token
}

const gate = (id: string, token: string, proof?: string): Promise<Response> =>
  fetch(`${server.url}/v1/presets/${encodeURIComponent(id)}/manifest`, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(proof === undefined ? {} : { 'x-payment': proof })
    }
  })

/** Ask once, get the terms, and answer them with a proof. */
async function quote(id: string, token: string): Promise<Terms> {
  const res = await gate(id, token)
  expect(res.status).toBe(402)
  return ((await res.json()) as { terms: Terms }).terms
}

/** A second, fully enrolled identity — someone the proof does not belong to. */
async function strangerToken(): Promise<string> {
  const stranger = authenticator(`cred-stranger-${settled.length}-${Math.abs(clock % 97)}`)
  identity.register(stranger.credentialId, stranger.jwk)
  const minted = (await (
    await fetch(`${server.url}/v1/identity/assert`, {
      method: 'POST',
      body: JSON.stringify({ ...stranger.assert(identity.challenge()), scope: 'download' })
    })
  ).json()) as { token: string }
  return minted.token
}

const proofFor = (terms: Terms, tx = 'tx-0xabc'): string =>
  encodePaymentProof({ nonce: terms.nonce, tx })

const reasonOf = async (res: Response): Promise<string | undefined> =>
  ((await res.json()) as { reason?: string }).reason

describe('a settled payment serves the preset', () => {
  it('answers 200 with the manifest on the retried GET', async () => {
    const id = seed('Pro Toolkit')
    const token = await downloadToken()
    const terms = await quote(id, token)
    const res = await gate(id, token, proofFor(terms))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { id: string }).id).toBe(id)
  })

  it('hands the facilitator the WHOLE bound request, chain included', async () => {
    // A transfer to the right address on the wrong chain is money gone with a
    // successful receipt, so chain is checked, not merely quoted.
    const id = seed('Pro Toolkit')
    const token = await downloadToken()
    const terms = await quote(id, token)
    await gate(id, token, proofFor(terms))
    expect(settled).toHaveLength(1)
    expect(settled[0]).toEqual({
      tx: 'tx-0xabc',
      payTo: PAYEE,
      amount: '12.00',
      asset: 'USDC',
      chain: 'base',
      identityId: IDENTITY,
      presetId: id,
      nonce: terms.nonce
    })
  })

  it('never reaches a chain: every settlement went through the injected seam', async () => {
    const id = seed('Pro Toolkit')
    const token = await downloadToken()
    await gate(id, token, proofFor(await quote(id, token)))
    // The double is the only thing that saw a settlement, which is the property
    // that keeps this suite runnable with no network and no keys.
    expect(settled).toHaveLength(1)
  })
})

describe('C16 — the three reasons are DISTINCT and each CONSTRUCTIBLE', () => {
  /** Build each failure over HTTP and return the reason the gate answered. */
  const construct = {
    async invalid(): Promise<string | undefined> {
      // A preset each: once a construction BUYS one, its buyer is entitled and
      // a later quote on the same preset is correctly served rather than
      // priced. Sharing one preset between them made the later steps see 200.
      const id = seed('Constructing Invalid')
      const token = await downloadToken()
      await quote(id, token)
      return reasonOf(await gate(id, token, 'not-a-proof'))
    },
    async expired(): Promise<string | undefined> {
      const id = seed('Constructing Expired')
      const token = await downloadToken()
      const terms = await quote(id, token)
      // The settable TTL earning its keep: no sleeping, and the case is
      // judgeable from outside the process.
      clock += TTL + 1
      return reasonOf(await gate(id, token, proofFor(terms)))
    },
    async replayed(): Promise<string | undefined> {
      // A3 changed who meets this, and for the better. The RIGHTFUL buyer now
      // holds a receipt, so their retry is simply served — a replay is no
      // longer how somebody re-opens what they bought. What remains is the case
      // that always mattered: a proof presented by somebody it does not belong
      // to, which is resale and theft rather than a retry.
      const id = seed('Constructing Replayed')
      const token = await downloadToken()
      const terms = await quote(id, token)
      const proof = proofFor(terms)
      expect((await gate(id, token, proof)).status).toBe(200)
      return reasonOf(await gate(id, await strangerToken(), proof))
    },
    async unverifiable(): Promise<string | undefined> {
      const id = seed('Constructing Unverifiable')
      const token = await downloadToken()
      const terms = await quote(id, token)
      facilitatorVerdict = () => ({ ok: false as const, reason: 'unverifiable' as const })
      const reason = await reasonOf(await gate(id, token, proofFor(terms)))
      facilitatorVerdict = () => ({ ok: true })
      return reason
    }
  }

  it('constructs `invalid` from a proof that is not one', async () => {
    expect(await construct.invalid()).toBe('invalid')
  })

  it('constructs `expired` by letting the quote stand too long', async () => {
    expect(await construct.expired()).toBe('expired')
  })

  it('constructs `replayed` by paying once and presenting the same proof again', async () => {
    expect(await construct.replayed()).toBe('replayed')
  })

  it('constructs `unverifiable` from a facilitator that will not answer', async () => {
    expect(await construct.unverifiable()).toBe('unverifiable')
  })

  it('DOES NOT COLLAPSE: four constructions, four different reasons', async () => {
    // The gate itself. If any pair ever became indistinguishable this is the
    // assertion that fails, and it fails loudly rather than by omission —
    // which is what caught expired collapsing into invalid.
    const reasons = [
      await construct.invalid(),
      await construct.expired(),
      await construct.replayed(),
      await construct.unverifiable()
    ]
    expect(new Set(reasons).size).toBe(4)
    expect(reasons.sort()).toEqual([...PAYMENT_FAILURES].sort())
  })

  it('keeps a replay distinct from a nonce we never issued', async () => {
    // The specific collapse this design guards against: deleting a nonce on
    // spend would make a replay read as `invalid`, and both would be "unknown".
    const id = seed('Pro Toolkit')
    const token = await downloadToken()
    const terms = await quote(id, token)
    const proof = proofFor(terms)
    await gate(id, token, proof)
    const stranger = await strangerToken()
    const replay = await reasonOf(await gate(id, stranger, proof))
    const invented = await reasonOf(
      await gate(id, stranger, encodePaymentProof({ nonce: 'never-issued', tx: 'tx-1' }))
    )
    expect(replay).toBe('replayed')
    expect(invented).toBe('invalid')
    expect(replay).not.toBe(invented)
  })

  it('still says `replayed` for a proof that bought something and then expired', async () => {
    // A spent nonce that also lapsed is still a replay, not a stale quote:
    // "re-price this" would be the wrong instruction for a proof that already
    // bought something.
    const id = seed('Pro Toolkit')
    const token = await downloadToken()
    const terms = await quote(id, token)
    const proof = proofFor(terms)
    expect((await gate(id, token, proof)).status).toBe(200)
    clock += TTL + 1
    expect(await reasonOf(await gate(id, await strangerToken(), proof))).toBe('replayed')
  })

  it('A3: the RIGHTFUL buyer retrying is simply SERVED, not accused', async () => {
    // The kinder half of the same change. Re-presenting your own proof used to
    // earn a refusal; now the receipt answers first and you get what you paid
    // for. A buyer must not be told off for retrying.
    const id = seed('Pro Toolkit')
    const token = await downloadToken()
    const terms = await quote(id, token)
    const proof = proofFor(terms)
    expect((await gate(id, token, proof)).status).toBe(200)
    expect((await gate(id, token, proof)).status).toBe(200)
    expect((await gate(id, token)).status).toBe(200)
  })

  it('is a vocabulary DISJOINT from the 403 reasons', async () => {
    // Both ride in `reason` on the same gate. The status disambiguates them,
    // and disjointness means even a client that ignored the status could not
    // mistake a payment failure for an entitlement refusal.
    for (const payment of PAYMENT_FAILURES) {
      expect([payment, (FORBIDDEN_REASONS as readonly string[]).includes(payment)]).toEqual([
        payment,
        false
      ])
    }
    for (const forbidden of FORBIDDEN_REASONS) expect(isPaymentFailure(forbidden)).toBe(false)
  })
})

describe('every payment failure is a 402, and never a 403', () => {
  it('holds for a malformed proof, an unknown nonce, an expiry and a replay', async () => {
    // D4/R9: 403 is the answer a client must never loop on. Every failure here
    // is "the payment did not happen", which is exactly what 402 describes.
    //
    // The unpaid preset carries the first three: once a buyer is ENTITLED, no
    // payment failure can reach them at all, because the receipt answers above
    // the price step. That is A3 working, not a gap in this test.
    const unpaid = seed('Never Bought')
    const token = await downloadToken()
    const stale = await quote(unpaid, token)
    clock += TTL + 1

    for (const proof of [
      'not-a-proof',
      encodePaymentProof({ nonce: 'never-issued', tx: 'tx-1' }),
      proofFor(stale)
    ]) {
      const res = await gate(unpaid, token, proof)
      expect([proof.slice(0, 12), res.status]).toEqual([proof.slice(0, 12), 402])
    }

    // And the replay, which now only a stranger can produce.
    const owned = seed('Pro Toolkit')
    const terms = await quote(owned, token)
    const paid = proofFor(terms)
    expect((await gate(owned, token, paid)).status).toBe(200)
    expect((await gate(owned, await strangerToken(), paid)).status).toBe(402)
  })

  it('answers 402 when the FACILITATOR refuses, not 403', async () => {
    const id = seed('Pro Toolkit')
    const token = await downloadToken()
    const terms = await quote(id, token)
    facilitatorVerdict = () => ({ ok: false, reason: 'invalid' })
    const res = await gate(id, token, proofFor(terms))
    expect(res.status).toBe(402)
    expect(await reasonOf(res)).toBe('invalid')
  })

  it('leaves the nonce ALIVE when settlement was refused, so a retry can pay', async () => {
    // The payment did not happen, so there is nothing to protect against.
    // Burning the quote would make a buyer re-price for a failure that was not
    // theirs — and would make `replayed` mean "we have seen this string".
    const id = seed('Pro Toolkit')
    const token = await downloadToken()
    const terms = await quote(id, token)
    facilitatorVerdict = () => ({ ok: false, reason: 'invalid' })
    expect((await gate(id, token, proofFor(terms))).status).toBe(402)
    facilitatorVerdict = () => ({ ok: true })
    expect((await gate(id, token, proofFor(terms))).status).toBe(200)
  })

  it('still carries the terms with every refusal, so a client can act', async () => {
    const id = seed('Pro Toolkit')
    const token = await downloadToken()
    await quote(id, token)
    const body = (await (await gate(id, token, 'not-a-proof')).json()) as {
      terms?: Terms
      reason?: string
    }
    expect(body.reason).toBe('invalid')
    expect(body.terms?.payTo).toBe(PAYEE)
    expect(body.terms?.chain).toBe('base')
  })
})

describe('a quote belongs to one buyer and one preset', () => {
  it('refuses a proof whose nonce was issued for a DIFFERENT preset', async () => {
    const mine = seed('Pro Toolkit')
    const other = seed('Audit Pack')
    const token = await downloadToken()
    const terms = await quote(other, token)
    // Same buyer, same price, wrong preset.
    expect(await reasonOf(await gate(mine, token, proofFor(terms)))).toBe('invalid')
  })

  it('refuses a proof whose nonce was issued to a DIFFERENT buyer', async () => {
    // Otherwise a quote is a bearer token: pay somebody else's terms, claim the
    // entitlement it bought.
    const id = seed('Pro Toolkit')
    const mineToken = await downloadToken()
    const terms = await quote(id, mineToken)

    const other = authenticator('cred-other')
    identity.register(other.credentialId, other.jwk)
    const theirToken = (
      (await (
        await fetch(`${server.url}/v1/identity/assert`, {
          method: 'POST',
          body: JSON.stringify({ ...other.assert(identity.challenge()), scope: 'download' })
        })
      ).json()) as { token: string }
    ).token

    expect(await reasonOf(await gate(id, theirToken, proofFor(terms)))).toBe('invalid')
    expect(purchaseBinding(IDENTITY, id)).not.toBe(purchaseBinding('cred-other', id))
  })
})

describe('the first ask is not a failure', () => {
  it('carries terms and NO reason when no proof was sent', async () => {
    const id = seed('Pro Toolkit')
    const token = await downloadToken()
    const res = await gate(id, token)
    expect(res.status).toBe(402)
    const body = (await res.json()) as { terms: Terms; reason?: string }
    expect(body.terms.amount).toBe('12.00')
    expect(body.reason).toBeUndefined()
    // And nothing was asked of the facilitator: there was nothing to settle.
    expect(settled).toEqual([])
  })

  it('leaves a FREE preset untouched by any of this', async () => {
    const id = seed('Deep Research', false)
    const token = await downloadToken()
    expect((await gate(id, token)).status).toBe(200)
    expect(settled).toEqual([])
  })
})

describe('the dev facilitator makes each case constructible against the real binary', () => {
  it('settles an ordinary proof and refuses a marked one', () => {
    // Magpie drives the real server, not this double. Without a documented way
    // to make a facilitator refuse, `invalid`-from-the-facilitator would be
    // reachable only by mocking — which is a case nobody has seen it answer.
    const dev = devFacilitator()
    const request: SettlementRequest = {
      tx: 'tx-1', payTo: PAYEE, amount: '12.00', asset: 'USDC', chain: 'base',
      identityId: IDENTITY, presetId: `sha256:${'a'.repeat(64)}`, nonce: 'n'
    }
    expect(dev.settle(request)).toEqual({ ok: true })
    expect(dev.settle({ ...request, tx: `${DEV_REFUSE_PREFIX}please` })).toEqual({
      ok: false,
      reason: 'invalid'
    })
  })

  it('refuses a request the gate filled in incompletely', () => {
    const dev = devFacilitator()
    const request: SettlementRequest = {
      tx: 'tx-1', payTo: '', amount: '12.00', asset: 'USDC', chain: 'base',
      identityId: IDENTITY, presetId: 'p', nonce: 'n'
    }
    expect(dev.settle(request)).toEqual({ ok: false, reason: 'invalid' })
  })
})

/* ------------------------ the fourth reason: our outage is not their fault --- */

describe('unverifiable — a fact about US, never about the buyer\'s payment', () => {
  const unreachable = () => {
    facilitatorVerdict = () => ({ ok: false as const, reason: 'unverifiable' as const })
  }

  it('answers a DISTINCT reason when the facilitator cannot be reached', async () => {
    // Ruled by Commander, 2026-08-22. Reporting our verifier being down as
    // "your payment is invalid" tells someone who may have already parted with
    // money that their money is bad — and teaches them to distrust a receipt
    // they are holding.
    const id = seed('Pro Toolkit')
    const token = await downloadToken()
    const terms = await quote(id, token)
    unreachable()
    const res = await gate(id, token, proofFor(terms))
    expect(res.status).toBe(402)
    expect(await reasonOf(res)).toBe('unverifiable')
  })

  it('is distinguishable ON THE WIRE from invalid, because the next action differs', async () => {
    // invalid: stop and check your wallet. unverifiable: try again, yours may
    // be fine. Two different instructions, so two different answers.
    const id = seed('Pro Toolkit')
    const token = await downloadToken()

    const a = await quote(id, token)
    facilitatorVerdict = () => ({ ok: false as const, reason: 'invalid' as const })
    const refused = (await (await gate(id, token, proofFor(a))).json()) as {
      reason: string
      retryable: boolean
    }

    const b = await quote(id, token)
    unreachable()
    const outage = (await (await gate(id, token, proofFor(b))).json()) as {
      reason: string
      retryable: boolean
    }

    expect(refused.reason).not.toBe(outage.reason)
    expect(refused.retryable).toBe(false)
    expect(outage.retryable).toBe(true)
  })

  it('carries retryable as a BOOLEAN, so a client that never heard of it still retries', async () => {
    // The M1 forward-compat rule renders an unknown reason as a sentence — but
    // retryability cannot be guessed from a token, and guessing wrong is
    // exactly the lie this reason exists to prevent.
    const id = seed('Pro Toolkit')
    const token = await downloadToken()
    const terms = await quote(id, token)
    unreachable()
    const body = (await (await gate(id, token, proofFor(terms))).json()) as {
      retryable: boolean
    }
    expect(body.retryable).toBe(true)
  })

  it('does NOT hand back a fresh quote — that would invite paying twice', async () => {
    // The money may already have moved. A new nonce would read as "pay again".
    const id = seed('Pro Toolkit')
    const token = await downloadToken()
    const terms = await quote(id, token)
    unreachable()
    const body = (await (await gate(id, token, proofFor(terms))).json()) as { terms: Terms }
    expect(body.terms.nonce).toBe(terms.nonce)
    expect(body.terms.expiry).toBe(terms.expiry)
  })

  it('leaves the nonce spendable, so the SAME proof succeeds once we recover', async () => {
    const id = seed('Pro Toolkit')
    const token = await downloadToken()
    const terms = await quote(id, token)
    const proof = proofFor(terms)
    unreachable()
    expect((await gate(id, token, proof)).status).toBe(402)
    facilitatorVerdict = () => ({ ok: true })
    expect((await gate(id, token, proof)).status).toBe(200)
  })

  it('never mistakes an outage for a refusal: it is a 402, never a 403', async () => {
    const id = seed('Pro Toolkit')
    const token = await downloadToken()
    const terms = await quote(id, token)
    unreachable()
    expect((await gate(id, token, proofFor(terms))).status).toBe(402)
  })

  it('a REPLAY also refuses a fresh quote, for the same reason', async () => {
    // It certainly bought something already. Handing over a new nonce would be
    // an invitation to buy it twice.
    const id = seed('Pro Toolkit')
    const token = await downloadToken()
    const terms = await quote(id, token)
    const proof = proofFor(terms)
    expect((await gate(id, token, proof)).status).toBe(200)
    const body = (await (await gate(id, await strangerToken(), proof)).json()) as {
      reason: string
      terms: Terms
      retryable: boolean
    }
    expect(body.reason).toBe('replayed')
    expect(body.terms.nonce).toBe(terms.nonce)
    expect(body.retryable).toBe(false)
  })

  it('DOES hand back a fresh quote when paying again IS the next step', async () => {
    const id = seed('Pro Toolkit')
    const token = await downloadToken()
    const terms = await quote(id, token)
    clock += TTL + 1
    const body = (await (await gate(id, token, proofFor(terms))).json()) as {
      reason: string
      terms: Terms
    }
    expect(body.reason).toBe('expired')
    expect(body.terms.nonce).not.toBe(terms.nonce)
  })

  it('four reasons now, still all distinct and none shared with the 403 vocabulary', () => {
    expect(new Set(PAYMENT_FAILURES).size).toBe(4)
    for (const reason of PAYMENT_FAILURES) {
      expect([reason, (FORBIDDEN_REASONS as readonly string[]).includes(reason)]).toEqual([
        reason,
        false
      ])
    }
    // Exactly one is retryable, and exactly the two that do not need a new
    // quote are the two where paying again is not the next step.
    expect(PAYMENT_FAILURES.filter(isRetryable)).toEqual(['unverifiable'])
    expect(PAYMENT_FAILURES.filter((r) => !needsFreshQuote(r)).sort()).toEqual(
      ['replayed', 'unverifiable'].sort()
    )
  })

  it('is constructible against the REAL binary, like the other three', () => {
    const dev = devFacilitator()
    const request: SettlementRequest = {
      tx: `${DEV_UNREACHABLE_PREFIX}down`, payTo: PAYEE, amount: '12.00', asset: 'USDC',
      chain: 'base', identityId: IDENTITY, presetId: `sha256:${'a'.repeat(64)}`, nonce: 'n'
    }
    expect(dev.settle(request)).toEqual({ ok: false, reason: 'unverifiable' })
    expect(dev.settle({ ...request, tx: `${DEV_REFUSE_PREFIX}no` })).toEqual({
      ok: false,
      reason: 'invalid'
    })
  })
})
