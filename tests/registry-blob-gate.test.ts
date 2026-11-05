import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeAuthorize, type PricingDeps } from '../registry/src/authorize'
import type { Facilitator } from '../registry/src/facilitator'
import { IdentityService, type IdentityConfig } from '../registry/src/identity'
import { TransparencyLog } from '../registry/src/log'
import { encodePaymentProof } from '../registry/src/payment'
import { PayoutStore } from '../registry/src/payouts'
import { publishPreset } from '../registry/src/publish'
import { ReceiptStore } from '../registry/src/receipts'
import { createRegistry } from '../registry/src/server'
import { RegistryStore, addressOf } from '../registry/src/store'
import { MemoryPaymentNonces, type Terms } from '../registry/src/terms'
import { verifyManifest } from '../src/main/preset-publish'
import type { PresetManifest } from '../src/shared/preset-manifest'
import { ONE_TIME, PAYEE, authenticator, authored, loopbackOnly } from './support/pay-gate-fixture'

/**
 * A PRESET'S FILES ANSWER TO THE SAME GATE AS ITS MANIFEST.
 *
 * /v1/presets hands every preset's address to anyone, and a blob's address IS
 * the preset's id, so an open /v1/blobs made every price and every sign-in
 * limit decorative.
 */

const IDENTITY = 'cred-drej'
const CONFIG: IdentityConfig = {
  rpId: 'localhost',
  origin: 'http://localhost:8790',
  tokenTtlMs: 10 * 60 * 1000,
  challengeTtlMs: 90 * 1000
}

let base = ''
let store: RegistryStore
let log: TransparencyLog
let identity: IdentityService
let receipts: ReceiptStore
let payouts: PayoutStore
let author: { publicKey: KeyObject; privateKey: KeyObject }
let auth: ReturnType<typeof authenticator>

const seed = (name: string, priced: boolean, visibility: 'public' | 'identified' = 'identified'): { id: string; bytes: Buffer } => {
  const m = authored(name, 1, author.privateKey, priced ? ONE_TIME : undefined)
  store.putBlob(m.teamBytes)
  store.putManifest({ manifest: m.manifest, teamName: name, visibility, identityId: IDENTITY })
  return { id: m.manifest.id, bytes: m.teamBytes }
}

async function listen(facilitator: Facilitator | null): Promise<{ url: string; close: () => void }> {
  const pricing: PricingDeps = {
    payouts,
    config: { chain: 'base', ttlMs: 15 * 60 * 1000 },
    nonces: new MemoryPaymentNonces(),
    facilitator,
    receipts,
    now: () => 1_700_000_000_000
  }
  const server = createRegistry({ store, log, identity, pricing, authorize: makeAuthorize(store, identity, pricing) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: loopbackOnly(`http://127.0.0.1:${port}`), close: () => server.close() }
}

async function bearer(url: string, scope = 'download'): Promise<string> {
  const minted = await fetch(`${url}/v1/identity/assert`, {
    method: 'POST',
    body: JSON.stringify({ ...auth.assert(identity.challenge()), scope })
  })
  return `Bearer ${((await minted.json()) as { token: string }).token}`
}

const blob = (url: string, id: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${url}/v1/blobs/${encodeURIComponent(id)}`, { headers })

const SETTLES: Facilitator = { settle: () => ({ ok: true }) }

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'registry-blob-gate-'))
  store = new RegistryStore(base)
  log = new TransparencyLog(base)
  identity = new IdentityService(base, CONFIG)
  receipts = new ReceiptStore(base)
  payouts = new PayoutStore(base)
  author = generateKeyPairSync('ed25519')
  auth = authenticator(IDENTITY, CONFIG.origin)
  identity.register(auth.credentialId, auth.jwk)
  payouts.bind(IDENTITY, PAYEE)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('reading a preset file', () => {
  it('leaves a free public preset open and cacheable by anyone', async () => {
    const { id, bytes } = seed('Deep Research', false, 'public')
    const s = await listen(null)
    try {
      const res = await blob(s.url, id)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toContain('public')
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true)
    } finally {
      s.close()
    }
  })

  it('asks a stranger who they are for a sign-in preset, with the same challenge', async () => {
    const { id } = seed('Ship Crew', false)
    const s = await listen(null)
    try {
      const res = await blob(s.url, id)
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toContain('WebAuthn')
      expect(Buffer.from(await res.arrayBuffer()).length).toBeLessThan(50)
    } finally {
      s.close()
    }
  })

  it('serves a sign-in preset to a download token, and no shared cache may keep it', async () => {
    const { id, bytes } = seed('Ship Crew', false)
    const s = await listen(null)
    try {
      const res = await blob(s.url, id, { authorization: await bearer(s.url) })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true)
    } finally {
      s.close()
    }
  })

  it('refuses a token of the wrong scope, as the manifest does', async () => {
    const { id } = seed('Ship Crew', false)
    const s = await listen(null)
    try {
      const res = await blob(s.url, id, { authorization: await bearer(s.url, 'publish') })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ reason: 'scope' })
    } finally {
      s.close()
    }
  })

  it('asks for payment on a priced preset, and a signed-in caller who has not paid gets terms, not bytes', async () => {
    const { id } = seed('Pro Toolkit', true)
    const s = await listen(SETTLES)
    try {
      const res = await blob(s.url, id, { authorization: await bearer(s.url) })
      expect(res.status).toBe(402)
      expect(((await res.json()) as { terms: Terms }).terms.amount).toBe('12.00')
    } finally {
      s.close()
    }
  })

  it('serves the file to the buyer once the manifest gate has been paid', async () => {
    const { id, bytes } = seed('Pro Toolkit', true)
    const s = await listen(SETTLES)
    try {
      const authorization = await bearer(s.url)
      const manifest = `${s.url}/v1/presets/${encodeURIComponent(id)}/manifest`
      const asked = await fetch(manifest, { headers: { authorization } })
      const { terms } = (await asked.json()) as { terms: Terms }
      const paid = await fetch(manifest, {
        headers: { authorization, 'x-payment': encodePaymentProof({ nonce: terms.nonce, tx: '0xpaid' }) }
      })
      expect(paid.status).toBe(200)
      const res = await blob(s.url, id, { authorization })
      expect(res.status).toBe(200)
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true)
    } finally {
      s.close()
    }
  })

  it('refuses a priced file outright while nothing can verify a payment', async () => {
    const { id } = seed('Pro Toolkit', true)
    const s = await listen(null)
    try {
      const res = await blob(s.url, id, { authorization: await bearer(s.url) })
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ reason: 'payment_unavailable' })
    } finally {
      s.close()
    }
  })

  it('never serves a priced file stored as public to a stranger', async () => {
    const { id } = seed('Pro Toolkit', true, 'public')
    const s = await listen(SETTLES)
    try {
      expect((await blob(s.url, id)).status).toBe(401)
    } finally {
      s.close()
    }
  })

  it('answers 404 for bytes no manifest stands behind, rather than assuming they are free', async () => {
    const orphan = store.putBlob(Buffer.from('{"left":"behind"}'))
    const s = await listen(null)
    try {
      expect((await blob(s.url, orphan)).status).toBe(404)
    } finally {
      s.close()
    }
  })

  it('answers 404 for a malformed address', async () => {
    const s = await listen(null)
    try {
      expect((await blob(s.url, 'sha256:not-a-digest')).status).toBe(404)
    } finally {
      s.close()
    }
  })
})

describe('a free manifest cannot open someone else\'s priced file', () => {
  const deps = () => ({
    store,
    log,
    payouts,
    sells: true,
    verifyManifest: (m: PresetManifest) => verifyManifest(m, author.publicKey),
    verifyCountersign: () => true
  })

  it('refuses a second identity publishing the same bytes, and the first listing stands', () => {
    const priced = authored('Pro Toolkit', 1, author.privateKey, ONE_TIME)
    const first = publishPreset(deps(), {
      manifest: priced.manifest, teamBytes: priced.teamBytes, teamName: 'Pro Toolkit', visibility: 'identified',
      identityId: IDENTITY, countersig: 'sig', at: 1
    })
    expect(first.ok).toBe(true)

    // A buyer who holds the bytes re-signs them as a free public preset.
    const free = authored('Pro Toolkit', 1, author.privateKey)
    expect(free.manifest.id).toBe(priced.manifest.id)
    const second = publishPreset(deps(), {
      manifest: free.manifest, teamBytes: free.teamBytes, teamName: 'Pro Toolkit', visibility: 'public',
      identityId: 'cred-buyer', countersig: 'sig', at: 2
    })
    expect(second).toEqual({ ok: false, reason: 'id_taken' })
    expect(store.getManifest(priced.manifest.id)?.pricing).toEqual(ONE_TIME)
    expect(store.identityOf(priced.manifest.id)).toBe(IDENTITY)
  })

  it('ignores a manifest that merely lists another preset\'s address as a file of its own', async () => {
    const { id } = seed('Pro Toolkit', true)
    const decoy = authored('Deep Research', 1, author.privateKey)
    const listing: PresetManifest = { ...decoy.manifest, blobs: { ...decoy.manifest.blobs, 'extra.json': id } }
    store.putBlob(decoy.teamBytes)
    store.putManifest({ manifest: listing, teamName: 'Deep Research', visibility: 'public', identityId: 'cred-other' })
    const s = await listen(SETTLES)
    try {
      expect((await blob(s.url, id)).status).toBe(401)
      expect((await blob(s.url, addressOf(decoy.teamBytes))).status).toBe(200)
    } finally {
      s.close()
    }
  })
})
