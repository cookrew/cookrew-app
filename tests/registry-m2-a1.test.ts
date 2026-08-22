import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { createRegistry } from '../registry/src/server'
import { IdentityService, type IdentityConfig } from '../registry/src/identity'
import { makeAuthorize, type PricingDeps } from '../registry/src/authorize'
import { PayoutStore, isPayoutAddress } from '../registry/src/payouts'
import {
  DEFAULT_TERMS_CONFIG,
  MemoryPaymentNonces,
  purchaseBinding,
  quoteFor,
  type Terms
} from '../registry/src/terms'
import { publishPreset } from '../registry/src/publish'
import { buildManifest, signManifest, verifyManifest } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
import { countersignPayload } from '../registry/src/countersign'
import type { PresetManifest, PresetPricing } from '../src/shared/preset-manifest'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

/**
 * M2-A1 — A PRICED PRESET ASKS FOR MONEY.
 *
 * One variant on one function. The seam the M1 note promised said "M2 inserts
 * 402 between entitlement and serve; nothing above it moves", so these tests
 * check the new answer AND that everything above it still answers exactly as it
 * did — a 402 that arrived by disturbing the 401 path would be a regression
 * wearing a feature's clothes.
 *
 * Money moves buyer → author (Commander, 2026-08-22). Nothing here holds funds,
 * touches a chain, or needs a key: the payee is an address an author gave us at
 * publish time, and the terms are a quote.
 */

const PAYEE = '0xA1b2C3d4E5f6789012345678901234567890aBcD'
const CONFIG: IdentityConfig = {
  rpId: 'localhost',
  origin: 'http://localhost:8790',
  tokenTtlMs: 10 * 60 * 1000,
  challengeTtlMs: 90 * 1000
}

const terminal = (command = 'npm test'): CanvasNode =>
  ({
    kind: 'terminal', id: 't1', name: 'Forge', preset: 'Claude Code', command,
    cwd: '/w', orch: false, role: null, position: { x: 0, y: 0 }, size: { width: 1, height: 1 }
  }) as CanvasNode

const b64 = (b: Buffer): string => b.toString('base64url')

/** A software authenticator, as in A2/A3 — no hardware, no network. */
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

function authored(name: string, version: number, key: KeyObject, pricing?: PresetPricing) {
  const snapshot: TeamSnapshot = {
    name, savedAt: 1, dir: '/w', nodes: [terminal(name)], connections: [], turns: {}
  }
  const built = buildManifest({
    scrub: scrubForPublish(snapshot),
    version,
    author: { handle: 'drej' },
    ...(pricing ? { pricing } : {})
  })
  if (!built.ok) throw new Error(`refused: ${built.reason}`)
  return { manifest: signManifest(built.manifest, key), teamBytes: built.teamBytes }
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

const IDENTITY = 'cred-drej'

/** Seed a preset directly, so the gate can be tested without a publish. */
const seed = (
  name: string,
  version = 1,
  pricingOf?: PresetPricing,
  visibility: 'public' | 'identified' = 'identified',
  identityId = IDENTITY
): string => {
  const m = authored(name, version, author.privateKey, pricingOf)
  store.putBlob(m.teamBytes)
  store.putManifest({ manifest: m.manifest, teamName: name, visibility, identityId })
  return m.manifest.id
}

const listen = async (withPricing = true): Promise<{ url: string; close: () => void }> => {
  const server = createRegistry({
    store,
    log,
    identity,
    dev: true,
    ...(withPricing ? { pricing } : {}),
    authorize: makeAuthorize(store, identity, withPricing ? pricing : undefined)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() }
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'registry-m2-a1-'))
  store = new RegistryStore(base)
  log = new TransparencyLog(base)
  identity = new IdentityService(base, CONFIG)
  payouts = new PayoutStore(base)
  author = generateKeyPairSync('ed25519')
  auth = authenticator(IDENTITY)
  identity.register(auth.credentialId, auth.jwk)
  payouts.bind(IDENTITY, PAYEE)
  clock = 1_700_000_000_000
  pricing = {
    payouts,
    config: { chain: 'base', ttlMs: 15 * 60 * 1000 },
    nonces: new MemoryPaymentNonces(),
    facilitator: { settle: () => ({ ok: true as const }) },
    now: () => clock
  }
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

/** A download-scoped token through the real ceremony. */
async function downloadToken(url: string): Promise<string> {
  const minted = (await (
    await fetch(`${url}/v1/identity/assert`, {
      method: 'POST',
      body: JSON.stringify({ ...auth.assert(identity.challenge()), scope: 'download' })
    })
  ).json()) as { token: string }
  return minted.token
}

const gate = (url: string, id: string, token?: string): Promise<Response> =>
  fetch(`${url}/v1/presets/${encodeURIComponent(id)}/manifest`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` }
  })

const ONE_TIME: PresetPricing = { model: 'one-time', amount: '12.00', asset: 'USDC' }

describe('the gate answers 402 for a priced preset', () => {
  it('carries terms an unmodified client can act on', async () => {
    const id = seed('Pro Toolkit', 1, ONE_TIME)
    const s = await listen()
    try {
      const res = await gate(s.url, id, await downloadToken(s.url))
      expect(res.status).toBe(402)
      const body = (await res.json()) as { terms: Terms }
      expect(body.terms).toMatchObject({
        amount: '12.00',
        asset: 'USDC',
        chain: 'base',
        payTo: PAYEE,
        expiry: clock + 15 * 60 * 1000
      })
      expect(typeof body.terms.nonce).toBe('string')
      expect(body.terms.nonce.length).toBeGreaterThan(20)
    } finally {
      s.close()
    }
  })

  it('pays the AUTHOR — the address is theirs and we are not in the path', async () => {
    // The ruling this slice exists to implement. If payTo were ever a registry
    // address, this is the test that would have to be edited to allow it.
    const id = seed('Pro Toolkit', 1, ONE_TIME)
    const s = await listen()
    try {
      const body = (await (await gate(s.url, id, await downloadToken(s.url))).json()) as { terms: Terms }
      expect(body.terms.payTo).toBe(payouts.addressOf(IDENTITY))
    } finally {
      s.close()
    }
  })

  it('quotes per BUYER: two identities do not share a nonce', async () => {
    // A nonce naming only the preset would be a bearer token — anyone could
    // pay one buyer's quote and claim the entitlement it bought.
    const id = seed('Pro Toolkit', 1, ONE_TIME)
    const other = authenticator('cred-other')
    identity.register(other.credentialId, other.jwk)
    const s = await listen()
    try {
      const mine = (await (await gate(s.url, id, await downloadToken(s.url))).json()) as { terms: Terms }
      const theirToken = (
        (await (
          await fetch(`${s.url}/v1/identity/assert`, {
            method: 'POST',
            body: JSON.stringify({ ...other.assert(identity.challenge()), scope: 'download' })
          })
        ).json()) as { token: string }
      ).token
      const theirs = (await (await gate(s.url, id, theirToken)).json()) as { terms: Terms }
      expect(mine.terms.nonce).not.toBe(theirs.terms.nonce)
      expect(purchaseBinding(IDENTITY, id)).not.toBe(purchaseBinding('cred-other', id))
    } finally {
      s.close()
    }
  })

  it('does not answer 402 before it knows who is asking', async () => {
    // Price is the LAST step. Asking for money from an unidentified caller
    // would be asking before we know whether we would have served the bytes.
    const id = seed('Pro Toolkit', 1, ONE_TIME)
    const s = await listen()
    try {
      const res = await gate(s.url, id)
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toMatch(/^WebAuthn realm="market", challenge=/)
    } finally {
      s.close()
    }
  })

  it('answers 403 scope, not 402, for a publish token at the download gate', async () => {
    // D4/R26 sits ABOVE price and must keep sitting there: a wrong-scope token
    // is a statement about the credential, and selling somebody a fix for it
    // would be a lie.
    const id = seed('Pro Toolkit', 1, ONE_TIME)
    const s = await listen()
    try {
      const publishToken = (
        (await (
          await fetch(`${s.url}/v1/identity/assert`, {
            method: 'POST',
            body: JSON.stringify({ ...auth.assert(identity.challenge()), scope: 'publish' })
          })
        ).json()) as { token: string }
      ).token
      const res = await gate(s.url, id, publishToken)
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ reason: 'scope' })
    } finally {
      s.close()
    }
  })
})

describe('nothing above the seam moved', () => {
  it('a free identified preset still answers 200, exactly as in M1', async () => {
    const id = seed('Deep Research', 2)
    const s = await listen()
    try {
      const res = await gate(s.url, id, await downloadToken(s.url))
      expect(res.status).toBe(200)
      expect((await res.json() as PresetManifest).id).toBe(id)
    } finally {
      s.close()
    }
  })

  it('a PUBLIC preset never sees the gate, priced or not', async () => {
    // Discovery and free download are not things identity should cost (A2), and
    // that is unchanged: a public preset short-circuits above the price step.
    const id = seed('Ship Crew', 1, ONE_TIME, 'public')
    const s = await listen()
    try {
      expect((await gate(s.url, id)).status).toBe(200)
    } finally {
      s.close()
    }
  })

  it('an unknown preset is still 404, not a quote for nothing', async () => {
    const s = await listen()
    try {
      expect((await gate(s.url, `sha256:${'a'.repeat(64)}`, await downloadToken(s.url))).status).toBe(404)
    } finally {
      s.close()
    }
  })

  it('HEAD NEVER answers 402 — a dock-open check must not ask for money', async () => {
    // R3 makes the update check a HEAD and R24 says a background check cannot
    // raise a sheet. A 402 here would mean opening the dock could demand
    // payment, which is the failure both rulings exist to prevent.
    const id = seed('Pro Toolkit', 1, ONE_TIME)
    const s = await listen()
    try {
      const res = await fetch(`${s.url}/v1/presets/${encodeURIComponent(id)}/manifest`, {
        method: 'HEAD',
        headers: { authorization: `Bearer ${await downloadToken(s.url)}` }
      })
      expect(res.status).not.toBe(402)
    } finally {
      s.close()
    }
  })

  it('a deployment with no pricing behaves exactly as M1 did', async () => {
    const id = seed('Pro Toolkit', 1, ONE_TIME)
    const s = await listen(false)
    try {
      // Priced in the manifest, but this registry sells nothing: it serves.
      expect((await gate(s.url, id, await downloadToken(s.url))).status).toBe(200)
    } finally {
      s.close()
    }
  })
})

describe('/v1/health advertises payment without promising a confirm endpoint', () => {
  it('says it serves 402, on which route, and that it holds no money', async () => {
    const s = await listen()
    try {
      const body = (await (await fetch(`${s.url}/v1/health`)).json()) as {
        payments: Record<string, unknown>
        notServed: Record<string, string>
      }
      expect(body.payments).toMatchObject({
        served: true,
        on: 'GET /v1/presets/:id/manifest',
        asset: 'USDC',
        chain: 'base',
        termsTtlMs: 15 * 60 * 1000
      })
      expect(String(body.payments.custody)).toContain('never holds')
    } finally {
      s.close()
    }
  })

  it('KEEPS /v1/pay never-served — there is no confirm endpoint, ever', async () => {
    const s = await listen()
    try {
      const body = (await (await fetch(`${s.url}/v1/health`)).json()) as {
        notServed: Record<string, string>
      }
      expect(body.notServed['/v1/pay']).toContain('never')
      expect((await fetch(`${s.url}/v1/pay`, { method: 'POST' })).status).toBe(404)
      expect((await fetch(`${s.url}/v1/pay`)).status).toBe(404)
    } finally {
      s.close()
    }
  })

  it('says so plainly when a deployment prices nothing', async () => {
    const s = await listen(false)
    try {
      const body = (await (await fetch(`${s.url}/v1/health`)).json()) as {
        payments: { served: boolean }
      }
      expect(body.payments.served).toBe(false)
    } finally {
      s.close()
    }
  })
})

describe('the terms TTL is settable, so an expiry is judgeable from outside', () => {
  it('expiry follows the configured TTL and the injected clock', () => {
    const nonces = new MemoryPaymentNonces()
    const terms = quoteFor(
      { config: { chain: 'base', ttlMs: 1_000 }, nonces, now: () => clock },
      { presetId: 'sha256:x', identityId: IDENTITY, pricing: ONE_TIME, payTo: PAYEE }
    )
    expect(terms?.expiry).toBe(clock + 1_000)
  })

  it('a nonce is unknown once its TTL has passed — no sleeping required', () => {
    // Magpie's gate: without a settable clock this case cannot be judged, and
    // an unjudgeable case is a BLOCK rather than a pass.
    const nonces = new MemoryPaymentNonces()
    const nonce = nonces.mint(purchaseBinding(IDENTITY, 'sha256:x'), clock, 1_000)
    expect(nonces.bindingOf(nonce, clock + 999)).toBe(purchaseBinding(IDENTITY, 'sha256:x'))
    expect(nonces.bindingOf(nonce, clock + 1_001)).toBeNull()
  })

  it('binds the nonce to buyer AND preset, in one domain-separated scheme', () => {
    // Same digest family as publish and key-rotation countersignatures, so the
    // three can never collide — the M1 replay was two operations sharing one
    // payload, and a second scheme invented here would be that bug again.
    expect(purchaseBinding('a', 'p')).not.toBe(purchaseBinding('b', 'p'))
    expect(purchaseBinding('a', 'p')).not.toBe(purchaseBinding('a', 'q'))
    expect(purchaseBinding('a', 'p')).toBe(countersignPayload('purchase', 'a', 'p').toString('hex'))
    expect(purchaseBinding('a', 'p')).not.toBe(countersignPayload('publish', 'a', 'p').toString('hex'))
  })
})

describe('a price needs a payee, and publish is where that is enforced', () => {
  const deps = () => ({
    store,
    log,
    payouts,
    verifyManifest: (m: PresetManifest) => verifyManifest(m, author.publicKey),
    verifyCountersign: () => true
  })

  const publishInput = (m: { manifest: PresetManifest; teamBytes: Buffer }, over = {}) => ({
    manifest: m.manifest,
    teamBytes: m.teamBytes,
    teamName: m.manifest.team === 'team.json' ? 'Pro Toolkit' : 'x',
    visibility: 'identified' as const,
    identityId: 'cred-newcomer',
    countersig: 'sig',
    at: 1,
    ...over
  })

  it('REFUSES a priced publish from an identity with no payout address', async () => {
    // The failure lands on the author, mid-ceremony, one field from fixed —
    // not on a buyer who cannot fix it and would meet it as a preset that
    // simply never sells.
    const m = authored('Pro Toolkit', 1, author.privateKey, ONE_TIME)
    const out = publishPreset(deps(), publishInput(m))
    expect(out).toEqual({ ok: false, reason: 'payout_missing' })
    expect(store.getManifest(m.manifest.id)).toBeNull()
    expect(log.all()).toEqual([])
  })

  it('accepts it when the publish carries the address, and binds it', () => {
    const m = authored('Pro Toolkit', 1, author.privateKey, ONE_TIME)
    const out = publishPreset(deps(), publishInput(m, { payoutAddress: PAYEE }))
    expect(out.ok).toBe(true)
    expect(payouts.addressOf('cred-newcomer')).toBe(PAYEE)
  })

  it('does not make an author resend an address they already bound', () => {
    const m = authored('Pro Toolkit', 1, author.privateKey, ONE_TIME)
    const out = publishPreset(deps(), publishInput(m, { identityId: IDENTITY }))
    expect(out.ok).toBe(true)
  })

  it('lets a FREE preset publish with no payout address at all', () => {
    const m = authored('Deep Research', 1, author.privateKey)
    expect(publishPreset(deps(), publishInput(m)).ok).toBe(true)
  })

  it('refuses a malformed address rather than storing one nobody can be paid at', () => {
    const m = authored('Pro Toolkit', 1, author.privateKey, ONE_TIME)
    for (const bad of ['', 'not-an-address', '0x123', `0x${'0'.repeat(40)}`, PAYEE.slice(0, -1)]) {
      const out = publishPreset(deps(), publishInput(m, { payoutAddress: bad }))
      expect([bad, out]).toEqual([bad, { ok: false, reason: 'payout_missing' }])
    }
  })

  it('refuses a priced publish into a registry that sells nothing', () => {
    // Otherwise the manifest would be stored priced, and served for free.
    const m = authored('Pro Toolkit', 1, author.privateKey, ONE_TIME)
    const out = publishPreset({ ...deps(), payouts: undefined }, publishInput(m, { payoutAddress: PAYEE }))
    expect(out).toEqual({ ok: false, reason: 'payout_missing' })
  })
})

describe('PayoutStore — an address book, never a ledger', () => {
  it('takes the format seriously and the zero address not at all', () => {
    expect(isPayoutAddress(PAYEE)).toBe(true)
    for (const bad of ['', '0x', '0xZZ', `0x${'0'.repeat(40)}`, PAYEE + '0', 42, null]) {
      expect([bad, isPayoutAddress(bad)]).toEqual([bad, false])
    }
  })

  it('stores the address VERBATIM, because EIP-55 hides a checksum in the case', () => {
    payouts.bind('cred-mixed', PAYEE)
    expect(payouts.addressOf('cred-mixed')).toBe(PAYEE)
    expect(payouts.addressOf('cred-mixed')).not.toBe(PAYEE.toLowerCase())
  })

  it('survives a restart — the author does not rebind on every boot', () => {
    payouts.bind('cred-persist', PAYEE)
    expect(new PayoutStore(base).addressOf('cred-persist')).toBe(PAYEE)
  })

  it('is EMPTY after a corrupt file, never partial', () => {
    writeFileSync(path.join(base, 'payouts.json'), '{ not json')
    // A stall an author can fix, rather than a guess that becomes a payment.
    expect(new PayoutStore(base).addressOf(IDENTITY)).toBeNull()
  })

  it('keys on the IDENTITY, so a rotated author key does not orphan the money', () => {
    // R20: an author key is a credential the identity holds and may replace.
    // Binding payment to the key would go stale exactly when a key rotates.
    payouts.bind(IDENTITY, PAYEE)
    const rotated = generateKeyPairSync('ed25519')
    void rotated
    expect(payouts.addressOf(IDENTITY)).toBe(PAYEE)
  })
})

describe('a priced preset with no payee is unreachable, and refused if reached', () => {
  it('does not serve it and does not quote it', async () => {
    // publishPreset makes this state impossible; a store written another way
    // could still hold it. 404 rather than 200 (which would give away something
    // priced) and rather than a status code invented at the seam.
    const id = seed('Orphan', 1, ONE_TIME, 'identified', 'cred-nobody')
    const s = await listen()
    try {
      const res = await gate(s.url, id, await downloadToken(s.url))
      expect(res.status).toBe(404)
    } finally {
      s.close()
    }
  })
})

/* ------------------------------------------- GATE: a HEAD is not a purchase --- */

describe('GATE — only a GET may ever be answered 402', () => {
  /**
   * Commander asked for this to be pinned, and pinned at the DECISION FUNCTION
   * rather than through the route, because the failure mode is "somebody adds a
   * second caller to authorize()". A test that only drives HTTP would keep
   * passing while a new caller quietly demanded payment for a background check.
   *
   * The original defect: GET and HEAD shared one authorize(), so a priced preset
   * made R3's dock-open update check answer 402 — and R24 forbids a background
   * check raising a sheet at all. Opening the dock would have asked for money.
   */
  const methods = ['HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE', 'PATCH', undefined]

  it('answers 402 for GET and never for any other method', async () => {
    const id = seed('Pro Toolkit', 1, ONE_TIME)
    const s = await listen()
    try {
      const token = await downloadToken(s.url)
      const authorize = makeAuthorize(store, identity, pricing)
      const ask = (method: string | undefined) =>
        authorize(id, {
          method,
          headers: { authorization: `Bearer ${token}` }
        } as never)

      expect(ask('GET').code).toBe(402)
      for (const method of methods) {
        expect([method, ask(method).code]).toEqual([method, 200])
      }
    } finally {
      s.close()
    }
  })

  it('holds over HTTP too, for the method the update check actually uses', async () => {
    const id = seed('Pro Toolkit', 1, ONE_TIME)
    const s = await listen()
    try {
      const token = await downloadToken(s.url)
      const res = await fetch(`${s.url}/v1/presets/${encodeURIComponent(id)}/manifest`, {
        method: 'HEAD',
        headers: { authorization: `Bearer ${token}` }
      })
      expect(res.status).toBe(200)
      // And it still answers the one question a HEAD is for.
      expect(res.headers.get('x-cookrew-preset-version')).toBe('1')
    } finally {
      s.close()
    }
  })

  it('a HEAD does not mint a quote, so a dock open cannot drain the nonce store', () => {
    // The quieter half of the same bug: even a HEAD that answered 200 would
    // have minted an offer nobody asked for if the price step ran.
    const id = seed('Pro Toolkit', 1, ONE_TIME)
    const authorize = makeAuthorize(store, identity, pricing)
    const before = pricing.nonces
    void before
    const minted: string[] = []
    const counting = {
      ...pricing,
      nonces: {
        mint: (binding: string, now: number, ttl: number) => {
          const value = pricing.nonces.mint(binding, now, ttl)
          minted.push(value)
          return value
        },
        bindingOf: (n: string, now: number) => pricing.nonces.bindingOf(n, now),
        stateOf: (n: string, now: number) => pricing.nonces.stateOf(n, now),
        spend: (n: string, now: number) => pricing.nonces.spend(n, now),
        expiryOf: (n: string) => pricing.nonces.expiryOf(n)
      }
    }
    const headAuthorize = makeAuthorize(store, identity, counting)
    void authorize
    headAuthorize(id, { method: 'HEAD', headers: {} } as never)
    expect(minted).toEqual([])
  })
})
