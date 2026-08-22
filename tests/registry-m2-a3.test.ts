import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { createRegistry } from '../registry/src/server'
import { IdentityService, type IdentityConfig } from '../registry/src/identity'
import { makeAuthorize, balanceFor, type PricingDeps } from '../registry/src/authorize'
import { PayoutStore } from '../registry/src/payouts'
import { ReceiptStore, balanceOf, entitledTo, type Receipt } from '../registry/src/receipts'
import { MemoryPaymentNonces, type Terms } from '../registry/src/terms'
import { encodePaymentProof } from '../registry/src/payment'
import { buildManifest, signManifest } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
import { isCallPathAnswer, DRAWDOWN_CONTRACT, FORBIDDEN_REASONS } from '../src/shared/preset-manifest'
import type { PresetPricing } from '../src/shared/preset-manifest'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

/**
 * M2-A3 — RECEIPTS AND PREPAID BALANCE.
 *
 * The whole point is that a buyer must not sign per fetch. The entitlement step
 * reads receipts ABOVE the price step, so the second fetch is an ordinary 200
 * that never reaches payment — which is what makes a purchase mean something
 * after the moment it happened.
 *
 * And R5's rule holds throughout: a live call answers 200 or 403 and never
 * raises a wallet over a conversation. A dry meter is a 403 `balance_empty` on
 * the call path, never a 402 anywhere.
 */

const PAYEE = '0xA1b2C3d4E5f6789012345678901234567890aBcD'
const IDENTITY = 'cred-buyer'
const ONE_TIME: PresetPricing = { model: 'one-time', amount: '12.00', asset: 'USDC' }
const PER_CALL: PresetPricing = { model: 'per-call', amount: '0.10', asset: 'USDC' }
const CONFIG: IdentityConfig = {
  rpId: 'localhost', origin: 'http://localhost:8790',
  tokenTtlMs: 10 * 60 * 1000, challengeTtlMs: 90 * 1000
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
    Buffer.from([0x01]), Buffer.from([0, 0, 0, 1])
  ])
  return {
    credentialId,
    jwk: keys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
    assert(challenge: string) {
      const clientData = Buffer.from(
        JSON.stringify({ type: 'webauthn.get', origin: CONFIG.origin, challenge }), 'utf8'
      )
      return {
        credentialId,
        clientDataJSON: b64(clientData),
        authenticatorData: b64(authData),
        signature: b64(sign('sha256',
          Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), keys.privateKey))
      }
    }
  }
}

let base = ''
let store: RegistryStore
let log: TransparencyLog
let identity: IdentityService
let payouts: PayoutStore
let receipts: ReceiptStore
let author: { publicKey: KeyObject; privateKey: KeyObject }
let auth: ReturnType<typeof authenticator>
let clock = 1_700_000_000_000
let pricing: PricingDeps
let server: { url: string; close: () => void }

const seed = (name: string, version = 1, priced: PresetPricing | undefined = ONE_TIME): string => {
  const snapshot: TeamSnapshot = {
    name, savedAt: version, dir: '/w', nodes: [terminal(`${name}-${version}`)], connections: [], turns: {}
  }
  const built = buildManifest({
    scrub: scrubForPublish(snapshot), version, author: { handle: 'drej' },
    ...(priced ? { pricing: priced } : {})
  })
  if (!built.ok) throw new Error(`refused: ${built.reason}`)
  const manifest = signManifest(built.manifest, author.privateKey)
  store.putBlob(built.teamBytes)
  // Same teamName across versions → same lineage, which is the point.
  store.putManifest({ manifest, teamName: name, visibility: 'identified', identityId: IDENTITY })
  return manifest.id
}

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), 'registry-m2-a3-'))
  store = new RegistryStore(base)
  log = new TransparencyLog(base)
  identity = new IdentityService(base, CONFIG)
  payouts = new PayoutStore(base)
  receipts = new ReceiptStore(base)
  author = generateKeyPairSync('ed25519')
  auth = authenticator(IDENTITY)
  identity.register(auth.credentialId, auth.jwk)
  payouts.bind(IDENTITY, PAYEE)
  clock = 1_700_000_000_000
  pricing = {
    payouts, receipts,
    config: { chain: 'base', ttlMs: TTL },
    nonces: new MemoryPaymentNonces(),
    facilitator: { settle: () => ({ ok: true }) },
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

async function tokenFor(who = auth): Promise<string> {
  const minted = (await (
    await fetch(`${server.url}/v1/identity/assert`, {
      method: 'POST',
      body: JSON.stringify({ ...who.assert(identity.challenge()), scope: 'download' })
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

/** Run the whole handshake once and come back owning the preset. */
async function buy(id: string, token: string): Promise<Terms> {
  const asked = await gate(id, token)
  expect(asked.status).toBe(402)
  const { terms } = (await asked.json()) as { terms: Terms }
  const bought = await gate(id, token, encodePaymentProof({ nonce: terms.nonce, tx: 'tx-1' }))
  expect(bought.status).toBe(200)
  return terms
}

describe('a buyer does not sign per fetch', () => {
  it('answers the SECOND fetch 200 with no X-Payment at all', async () => {
    const id = seed('Pro Toolkit')
    const token = await tokenFor()
    await buy(id, token)
    const again = await gate(id, token)
    expect(again.status).toBe(200)
    expect(((await again.json()) as { id: string }).id).toBe(id)
  })

  it('never reaches the price step once entitled — no quote is minted', async () => {
    // A3 mostly REMOVES A1's path on the second call, which is the shape
    // Commander predicted. If the entitlement step sat below pricing, this
    // fetch would mint an offer nobody asked for.
    const id = seed('Pro Toolkit')
    const token = await tokenFor()
    const first = await buy(id, token)
    const minted: string[] = []
    const counting: PricingDeps = {
      ...pricing,
      nonces: {
        mint: (b, n, t) => {
          const v = pricing.nonces.mint(b, n, t)
          minted.push(v)
          return v
        },
        bindingOf: (n, now) => pricing.nonces.bindingOf(n, now),
        stateOf: (n, now) => pricing.nonces.stateOf(n, now),
        spend: (n, now) => pricing.nonces.spend(n, now),
        expiryOf: (n) => pricing.nonces.expiryOf(n)
      }
    }
    const authorize = makeAuthorize(store, identity, counting)
    const verdict = authorize(id, {
      method: 'GET',
      headers: { authorization: `Bearer ${await tokenFor()}` }
    } as never)
    expect(verdict.code).toBe(200)
    expect(minted).toEqual([])
    expect(first.nonce.length).toBeGreaterThan(0)
  })

  it('survives a restart — a receipt is not a session', async () => {
    const id = seed('Pro Toolkit')
    const token = await tokenFor()
    await buy(id, token)
    // A fresh store over the same directory: the buyer still owns it.
    const reopened = new ReceiptStore(base)
    expect(reopened.forLineage(IDENTITY, store.lineageFor(id) as string)).toHaveLength(1)
  })

  it('entitles ONE buyer, not everybody', async () => {
    const id = seed('Pro Toolkit')
    await buy(id, await tokenFor())
    const stranger = authenticator('cred-stranger')
    identity.register(stranger.credentialId, stranger.jwk)
    expect((await gate(id, await tokenFor(stranger))).status).toBe(402)
  })
})

describe('a purchase is keyed to the LINEAGE, so an update stays bought', () => {
  it('entitles v2 and later, exactly as mkt.pay.buys promises', async () => {
    // Keyed on the preset id this would fail the moment an author shipped v3:
    // an id is the content address of one version.
    const v2 = seed('Pro Toolkit', 2)
    const token = await tokenFor()
    await buy(v2, token)
    const v3 = seed('Pro Toolkit', 3)
    expect((await gate(v3, token)).status).toBe(200)
  })

  it('does NOT entitle a version older than the one bought', async () => {
    const v3 = seed('Pro Toolkit', 3)
    const token = await tokenFor()
    await buy(v3, token)
    const v1 = seed('Pro Toolkit', 1)
    expect((await gate(v1, token)).status).toBe(402)
  })

  it('does not leak across lineages', async () => {
    const mine = seed('Pro Toolkit')
    const other = seed('Audit Pack')
    const token = await tokenFor()
    await buy(mine, token)
    expect((await gate(other, token)).status).toBe(402)
  })
})

describe('the receipt is written before the bytes are served', () => {
  it('records exactly one receipt for one purchase', async () => {
    const id = seed('Pro Toolkit')
    const token = await tokenFor()
    const terms = await buy(id, token)
    const held = receipts.forLineage(IDENTITY, store.lineageFor(id) as string)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({
      identityId: IDENTITY, presetId: id, nonce: terms.nonce, tx: 'tx-1',
      amount: '12.00', asset: 'USDC', version: 1
    })
  })

  it('does not record one for a payment that failed', async () => {
    const id = seed('Pro Toolkit')
    const token = await tokenFor()
    const asked = await gate(id, token)
    const { terms } = (await asked.json()) as { terms: Terms }
    pricing.facilitator = { settle: () => ({ ok: false, reason: 'invalid' }) }
    await gate(id, token, encodePaymentProof({ nonce: terms.nonce, tx: 'tx-1' }))
    expect(receipts.forLineage(IDENTITY, store.lineageFor(id) as string)).toEqual([])
  })

  it('is append-only and refuses to read past a truncated tail', () => {
    // A crash mid-append leaves half a line. Reading past it would mean
    // trusting records after a gap — a purchase we are not sure we recorded.
    const file = path.join(base, 'receipts.jsonl')
    const one: Receipt = {
      identityId: IDENTITY, lineage: 'l', version: 1, presetId: 'p',
      nonce: 'n', tx: 't', amount: '1.00', asset: 'USDC', at: 1
    }
    writeFileSync(file, `${JSON.stringify(one)}\n`)
    appendFileSync(file, '{"identityId":"half')
    expect(new ReceiptStore(base).forLineage(IDENTITY, 'l')).toHaveLength(1)
  })

  it('keeps buyers out of the PUBLIC transparency log', async () => {
    // The log's guarantee is about what was served and who signed it. Buyer
    // identities in a public append-only file is a privacy leak with no
    // matching benefit.
    const id = seed('Pro Toolkit')
    await buy(id, await tokenFor())
    expect(JSON.stringify(log.all())).not.toContain(IDENTITY)
    expect(log.all().every((r) => r.kind !== ('purchase' as never))).toBe(true)
  })
})

describe('prepaid balance — both units, and never a payment demand', () => {
  it('reports money AND calls, per deck §7', () => {
    const held: Receipt[] = [{
      identityId: IDENTITY, lineage: 'l', version: 1, presetId: 'p',
      nonce: 'n', tx: 't', amount: '0.30', asset: 'USDC', at: 1
    }]
    // "$0.30 USDC · ~4 calls left" — money alone makes the buyer divide;
    // calls alone hides what a top-up costs.
    expect(balanceOf(held, { pricing: PER_CALL })).toEqual({ amount: '0.30', calls: 3 })
  })

  it('FLOORS the call count — a fraction of a call is not a call', () => {
    const held: Receipt[] = [{
      identityId: IDENTITY, lineage: 'l', version: 1, presetId: 'p',
      nonce: 'n', tx: 't', amount: '0.25', asset: 'USDC', at: 1
    }]
    // Telling a buyer they have one left when they do not is how balance_empty
    // arrives as a surprise mid-conversation.
    expect(balanceOf(held, { pricing: PER_CALL }).calls).toBe(2)
  })

  it('never goes negative, however much the meter claims was spent', () => {
    const held: Receipt[] = [{
      identityId: IDENTITY, lineage: 'l', version: 1, presetId: 'p',
      nonce: 'n', tx: 't', amount: '1.00', asset: 'USDC', at: 1
    }]
    expect(balanceOf(held, { pricing: PER_CALL, spentCents: 10_000 })).toEqual({
      amount: '0.00', calls: 0
    })
  })

  it('never uses floats: many small credits still total exactly', () => {
    const held: Receipt[] = Array.from({ length: 10 }, (_, i) => ({
      identityId: IDENTITY, lineage: 'l', version: 1, presetId: 'p',
      nonce: `n${i}`, tx: 't', amount: '0.10', asset: 'USDC' as const, at: 1
    }))
    // 0.1 * 10 !== 1 in binary floating point. Money is integer cents here.
    expect(balanceOf(held, { pricing: PER_CALL }).amount).toBe('1.00')
  })

  it('a per-call purchase entitles the DOWNLOAD, and credit is separate', async () => {
    // R5: pay-per-call is a prepaid balance bought at install. Owning credit
    // is what lets you fetch the preset; whether a given call may run is the
    // meter's question, answered elsewhere.
    const id = seed('Metered', 1, PER_CALL)
    const token = await tokenFor()
    await buy(id, token)
    expect((await gate(id, token)).status).toBe(200)
    expect(balanceFor(store, pricing, id, IDENTITY)).toEqual({ amount: '0.10', calls: 1 })
  })

  it('is NOT consulted by the gate — a dry meter never blocks a download', async () => {
    const id = seed('Metered', 1, PER_CALL)
    const token = await tokenFor()
    await buy(id, token)
    // Every credit spent, and the preset still downloads: the meter governs
    // calls, not access to the bytes you own.
    expect(balanceFor(store, pricing, id, IDENTITY, 10_000)).toEqual({ amount: '0.00', calls: 0 })
    expect((await gate(id, token)).status).toBe(200)
  })
})

describe('R5 — a live call answers 200 or 403, and never a wallet', () => {
  it('excludes 402 from the call path by construction', () => {
    // The invariant, asserted rather than described. 402 mid-conversation is
    // the wallet sheet over a terminal card that R5 forbids.
    expect(isCallPathAnswer(200)).toBe(true)
    expect(isCallPathAnswer(403)).toBe(true)
    expect(isCallPathAnswer(402)).toBe(false)
    for (const code of [401, 404, 409, 413, 500]) expect(isCallPathAnswer(code)).toBe(false)
  })

  it('names the dry meter as a 403 reason, not a payment answer', () => {
    // R11: balance_empty is a first-class 403, never a seat_limit variant and
    // never the unknown fallback — and never a 402.
    expect(FORBIDDEN_REASONS).toContain('balance_empty')
  })

  it('keeps R12s ordering, which is what makes the copy true', () => {
    // Drawdown per turn at ACCEPT, never interrupting a running turn, so
    // balance_empty can only surface BETWEEN turns — that is what makes
    // "its last answer completed" true by construction rather than by wording.
    expect(DRAWDOWN_CONTRACT).toMatchObject({
      unit: 'turn', chargedAt: 'accept',
      interruptsRunningTurn: false, surfacesBetweenTurnsOnly: true
    })
  })

  it('serves no route that could answer 402 mid-conversation', async () => {
    // The call path does not exist yet. What this pins is that nothing which
    // does exist can 402 outside the manifest gate — so when the call path
    // lands it cannot inherit one by accident.
    const health = (await (await fetch(`${server.url}/v1/health`)).json()) as {
      payments: { on: string }
    }
    expect(health.payments.on).toBe('GET /v1/presets/:id/manifest')
  })
})

describe('entitledTo — the pure rule', () => {
  const receipt = (version: number): Receipt => ({
    identityId: IDENTITY, lineage: 'l', version, presetId: 'p',
    nonce: `n${version}`, tx: 't', amount: '12.00', asset: 'USDC', at: 1
  })

  it('is false with no receipts at all', () => {
    expect(entitledTo([], { version: 1, pricing: ONE_TIME })).toBe(false)
  })

  it('covers the version bought and every later one', () => {
    expect(entitledTo([receipt(2)], { version: 2, pricing: ONE_TIME })).toBe(true)
    expect(entitledTo([receipt(2)], { version: 9, pricing: ONE_TIME })).toBe(true)
    expect(entitledTo([receipt(2)], { version: 1, pricing: ONE_TIME })).toBe(false)
  })

  it('takes the EARLIEST purchase as the floor', () => {
    expect(entitledTo([receipt(5), receipt(2)], { version: 3, pricing: ONE_TIME })).toBe(true)
  })

  it('entitles any per-call holder, because credit is the purchase', () => {
    expect(entitledTo([receipt(9)], { version: 1, pricing: PER_CALL })).toBe(true)
  })
})
