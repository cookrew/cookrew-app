import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { makeAuthorize, type PricingDeps } from '../registry/src/authorize'
import { facilitatorFor } from '../registry/src/facilitator-boot'
import { IdentityService, type IdentityConfig } from '../registry/src/identity'
import { TransparencyLog } from '../registry/src/log'
import { encodePaymentProof } from '../registry/src/payment'
import { PayoutStore } from '../registry/src/payouts'
import { publishPreset } from '../registry/src/publish'
import { ReceiptStore } from '../registry/src/receipts'
import { createRegistry } from '../registry/src/server'
import { RegistryStore, lineageOf } from '../registry/src/store'
import { MemoryPaymentNonces, type PaymentNonces, type Terms } from '../registry/src/terms'
import { verifyManifest } from '../src/main/preset-publish'
import type { PresetManifest } from '../src/shared/preset-manifest'
import { ONE_TIME, PAYEE, authenticator, authored, loopbackOnly } from './support/pay-gate-fixture'

/**
 * A REGISTRY THAT CANNOT VERIFY A PAYMENT MUST NOT TAKE ONE.
 *
 * The money path is buyer to author, so a 402 from a registry that can never
 * settle is worse than a refusal: it invites a real transfer nobody can credit.
 * These hold the production shape, first in process and then against the bundle
 * `registry:build` produces, because the original fault was a line in main.ts
 * that no in-process test could ever see.
 */

const IDENTITY = 'cred-drej'
const MADE_UP = encodePaymentProof({ nonce: 'made-up-nonce', tx: '0xmadeup' })
const CONFIG: IdentityConfig = {
  rpId: 'localhost',
  origin: 'http://localhost:8790',
  tokenTtlMs: 10 * 60 * 1000,
  challengeTtlMs: 90 * 1000
}

let base = ''
let store: RegistryStore
let identity: IdentityService
let payouts: PayoutStore
let receipts: ReceiptStore
let log: TransparencyLog
let author: { publicKey: KeyObject; privateKey: KeyObject }
let auth: ReturnType<typeof authenticator>
let quotes = 0

const countingNonces = (): PaymentNonces => {
  const inner = new MemoryPaymentNonces()
  return new Proxy(inner, {
    get(target, key, receiver) {
      if (key === 'mint') quotes += 1
      const value = Reflect.get(target, key, receiver) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    }
  })
}

const productionPricing = (): PricingDeps => ({
  payouts,
  config: { chain: 'base', ttlMs: 15 * 60 * 1000 },
  nonces: countingNonces(),
  facilitator: null,
  receipts,
  now: () => 1_700_000_000_000
})

const seed = (name: string, priced: boolean, visibility: 'public' | 'identified' = 'identified'): string => {
  const m = authored(name, 1, author.privateKey, priced ? ONE_TIME : undefined)
  store.putBlob(m.teamBytes)
  store.putManifest({ manifest: m.manifest, teamName: name, visibility, identityId: IDENTITY })
  return m.manifest.id
}

async function listen(pricing: PricingDeps | undefined): Promise<{ url: string; close: () => void }> {
  const server = createRegistry({
    store,
    log,
    identity,
    ...(pricing === undefined ? {} : { pricing }),
    authorize: makeAuthorize(store, identity, pricing)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: loopbackOnly(`http://127.0.0.1:${port}`), close: () => server.close() }
}

async function downloadToken(url: string): Promise<string> {
  const minted = await fetch(`${url}/v1/identity/assert`, {
    method: 'POST',
    body: JSON.stringify({ ...auth.assert(identity.challenge()), scope: 'download' })
  })
  return ((await minted.json()) as { token: string }).token
}

const gate = (url: string, id: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Response> =>
  fetch(`${url}/v1/presets/${encodeURIComponent(id)}/manifest`, { method, headers })

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'registry-pay-gate-'))
  store = new RegistryStore(base)
  log = new TransparencyLog(base)
  identity = new IdentityService(base, CONFIG)
  payouts = new PayoutStore(base)
  receipts = new ReceiptStore(base)
  author = generateKeyPairSync('ed25519')
  auth = authenticator(IDENTITY, CONFIG.origin)
  identity.register(auth.credentialId, auth.jwk)
  payouts.bind(IDENTITY, PAYEE)
  quotes = 0
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('a registry with no facilitator', () => {
  it('refuses a priced preset before quoting, so nobody is invited to pay', async () => {
    const id = seed('Pro Toolkit', true)
    const s = await listen(productionPricing())
    try {
      const token = await downloadToken(s.url)
      const res = await gate(s.url, id, { authorization: `Bearer ${token}` })
      expect(res.status).toBe(503)
      const body = (await res.json()) as Record<string, unknown>
      expect(body).toEqual({ reason: 'payment_unavailable' })
      expect(quotes).toBe(0)
    } finally {
      s.close()
    }
  })

  it('never settles a made-up proof, and writes no receipt for one', async () => {
    const id = seed('Pro Toolkit', true)
    const s = await listen(productionPricing())
    try {
      const token = await downloadToken(s.url)
      const res = await gate(s.url, id, { authorization: `Bearer ${token}`, 'x-payment': MADE_UP })
      expect(res.status).toBe(503)
      expect(receipts.forLineage(IDENTITY, lineageOf(IDENTITY, 'Pro Toolkit'))).toEqual([])
    } finally {
      s.close()
    }
  })

  it('still asks who you are first, because the gate order does not move', async () => {
    const id = seed('Pro Toolkit', true)
    const s = await listen(productionPricing())
    try {
      expect((await gate(s.url, id)).status).toBe(401)
    } finally {
      s.close()
    }
  })

  it('keeps what a buyer already owns, which needs no new payment', async () => {
    const id = seed('Pro Toolkit', true)
    receipts.record({
      identityId: IDENTITY, lineage: lineageOf(IDENTITY, 'Pro Toolkit'), version: 1, presetId: id,
      nonce: 'held', tx: '0xheld', amount: '12.00', asset: 'USDC', at: 1
    })
    const s = await listen(productionPricing())
    try {
      const token = await downloadToken(s.url)
      expect((await gate(s.url, id, { authorization: `Bearer ${token}` })).status).toBe(200)
    } finally {
      s.close()
    }
  })

  it('leaves a free preset alone, public or sign-in only', async () => {
    const open = seed('Deep Research', false, 'public')
    const signedIn = seed('Ship Crew', false)
    const s = await listen(productionPricing())
    try {
      expect((await gate(s.url, open)).status).toBe(200)
      const token = await downloadToken(s.url)
      expect((await gate(s.url, signedIn, { authorization: `Bearer ${token}` })).status).toBe(200)
    } finally {
      s.close()
    }
  })

  it('still answers the update check, which is not a purchase', async () => {
    const id = seed('Pro Toolkit', true)
    const s = await listen(productionPricing())
    try {
      const token = await downloadToken(s.url)
      expect((await gate(s.url, id, { authorization: `Bearer ${token}` }, 'HEAD')).status).toBe(200)
    } finally {
      s.close()
    }
  })

  it('says so in its self-description', async () => {
    const s = await listen(productionPricing())
    try {
      const health = (await (await fetch(`${s.url}/v1/health`)).json()) as { payments: { served: boolean } }
      expect(health.payments.served).toBe(false)
    } finally {
      s.close()
    }
  })
})

describe('a price is never free by accident', () => {
  it('gates a priced preset even when it was stored as public', async () => {
    const id = seed('Pro Toolkit', true, 'public')
    const s = await listen(productionPricing())
    try {
      expect((await gate(s.url, id)).status).toBe(401)
      const token = await downloadToken(s.url)
      expect((await gate(s.url, id, { authorization: `Bearer ${token}` })).status).toBe(503)
    } finally {
      s.close()
    }
  })

  it('refuses a priced preset when this deployment has no pricing at all', async () => {
    const id = seed('Pro Toolkit', true)
    const s = await listen(undefined)
    try {
      const token = await downloadToken(s.url)
      expect((await gate(s.url, id, { authorization: `Bearer ${token}` })).status).toBe(503)
    } finally {
      s.close()
    }
  })
})

describe('publishing into a registry that cannot sell', () => {
  const deps = (sells: boolean) => ({
    store,
    log,
    payouts,
    sells,
    verifyManifest: (m: PresetManifest) => verifyManifest(m, author.publicKey),
    verifyCountersign: () => true
  })
  const input = (m: { manifest: PresetManifest; teamBytes: Buffer }, over = {}) => ({
    manifest: m.manifest, teamBytes: m.teamBytes, teamName: 'Pro Toolkit', visibility: 'identified' as const,
    identityId: 'cred-newcomer', countersig: 'sig', at: 1, ...over
  })

  it('refuses a priced publish and keeps nothing of it, payout included', () => {
    const m = authored('Pro Toolkit', 1, author.privateKey, ONE_TIME)
    const out = publishPreset(deps(false), input(m, { payoutAddress: PAYEE }))
    expect(out).toEqual({ ok: false, reason: 'payment_unavailable' })
    expect(store.getManifest(m.manifest.id)).toBeNull()
    expect(payouts.addressOf('cred-newcomer')).toBeNull()
    expect(log.all()).toEqual([])
  })

  it('still takes a free one', () => {
    const m = authored('Deep Research', 1, author.privateKey)
    expect(publishPreset(deps(false), input(m)).ok).toBe(true)
  })
})

describe('which facilitator a boot gets', () => {
  it('outside --dev there is none, on any origin', () => {
    for (const origin of ['https://cookrew.dev', 'http://localhost:8790']) {
      expect(facilitatorFor({ dev: false, origin })).toEqual({ ok: true, facilitator: null })
    }
  })

  it('--dev gets the handshake stand-in on a loopback origin', () => {
    const boot = facilitatorFor({ dev: true, origin: 'http://localhost:8790' })
    expect(boot.ok && boot.facilitator !== null).toBe(true)
  })

  it('--dev on a public origin refuses to boot, so a stray flag cannot take fake money', () => {
    const boot = facilitatorFor({ dev: true, origin: 'https://cookrew.dev' })
    expect(boot.ok).toBe(false)
  })
})

/** The built bundle, booted as the cluster boots it. */
describe('the registry binary', () => {
  const ROOT = fileURLToPath(new URL('..', import.meta.url))
  let dir = ''
  let bundle = ''
  const running: ChildProcess[] = []

  function buildCommand(): string {
    const scripts = (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    const build = scripts['registry:build'].split(' && ').at(-1) ?? ''
    const esbuild = path.join(path.dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), 'bin', 'esbuild')
    return build
      .replace(/^esbuild /, `"${esbuild}" `)
      .replace('$(git rev-parse HEAD)', 'pay-gate-test')
      .replace('--outfile=/tmp/registry.mjs', `--outfile="${bundle}"`)
  }

  const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const probe = createServer()
      probe.on('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo
        probe.close(() => resolve(port))
      })
    })

  function launch(data: string, port: number, extra: string[]): { child: ChildProcess; up: Promise<void>; exited: Promise<number | null>; stderr: () => string } {
    const env = { ...process.env }
    delete env.COOKREW_REGISTRY
    const child = spawn(process.execPath, [bundle, '--port', String(port), '--data', data, ...extra], {
      cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe']
    })
    running.push(child)
    let out = ''
    let err = ''
    child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()))
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
    const up = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`registry did not start: ${err}`)), 20_000)
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString()
        if (out.includes('registry on ')) {
          clearTimeout(timer)
          resolve()
        }
      })
      void exited.then((code) => {
        clearTimeout(timer)
        reject(new Error(`registry exited ${code}: ${err}`))
      })
    })
    return { child, up, exited, stderr: () => err }
  }

  /** A data dir holding one priced preset and one enrolled buyer, written before the binary starts. */
  async function pricedRegistry(name: string, extra: string[]) {
    const port = await freePort()
    const origin = loopbackOnly(`http://localhost:${port}`)
    const data = path.join(dir, name)
    const key = generateKeyPairSync('ed25519')
    const buyer = authenticator(IDENTITY, origin)
    const seeded = new RegistryStore(data)
    const m = authored('Pro Toolkit', 1, key.privateKey, ONE_TIME)
    seeded.putBlob(m.teamBytes)
    seeded.putManifest({ manifest: m.manifest, teamName: 'Pro Toolkit', visibility: 'identified', identityId: IDENTITY })
    new PayoutStore(data).bind(IDENTITY, PAYEE)
    new IdentityService(data, { ...CONFIG, origin }).register(buyer.credentialId, buyer.jwk)
    const booted = launch(data, port, extra)
    await booted.up
    const challenge = (await (await fetch(`${origin}/v1/identity/challenge`, { method: 'POST' })).json()) as { challenge: string }
    const minted = await fetch(`${origin}/v1/identity/assert`, {
      method: 'POST',
      body: JSON.stringify({ ...buyer.assert(challenge.challenge), scope: 'download' })
    })
    const { token } = (await minted.json()) as { token: string }
    return { origin, data, id: m.manifest.id, authorization: `Bearer ${token}` }
  }

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'registry-pay-gate-bin-'))
    bundle = path.join(dir, 'registry.mjs')
    execFileSync('/bin/sh', ['-c', buildCommand()], { cwd: ROOT, stdio: 'pipe' })
  }, 60_000)

  afterAll(async () => {
    for (const child of running) child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  })

  it('in production mode never settles a made-up tx', async () => {
    const r = await pricedRegistry('production', [])
    const res = await gate(r.origin, r.id, { authorization: r.authorization, 'x-payment': MADE_UP })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ reason: 'payment_unavailable' })
    const plain = await gate(r.origin, r.id, { authorization: r.authorization })
    expect(plain.status).toBe(503)
    expect(existsSync(path.join(r.data, 'receipts.jsonl'))).toBe(false)
  }, 30_000)

  it('under --dev still runs the whole handshake', async () => {
    const r = await pricedRegistry('dev', ['--dev'])
    const asked = await gate(r.origin, r.id, { authorization: r.authorization })
    expect(asked.status).toBe(402)
    const { terms } = (await asked.json()) as { terms: Terms }
    const proof = encodePaymentProof({ nonce: terms.nonce, tx: 'dev-tx-1' })
    const paid = await gate(r.origin, r.id, { authorization: r.authorization, 'x-payment': proof })
    expect(paid.status).toBe(200)
    const owned = await gate(r.origin, r.id, { authorization: r.authorization })
    expect(owned.status).toBe(200)
  }, 30_000)

  it('refuses --dev on a public origin at boot', async () => {
    const port = await freePort()
    const booted = launch(path.join(dir, 'public-dev'), port, ['--dev', '--origin', 'https://cookrew.dev'])
    booted.up.catch(() => undefined)
    expect(await booted.exited).toBe(1)
    expect(booted.stderr()).toContain('--dev')
  }, 30_000)
})
