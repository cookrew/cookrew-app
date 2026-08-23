import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'node:fs'
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
import { FilePaymentNonces } from '../registry/src/payment-nonces'
import { purchaseBinding, type Terms } from '../registry/src/terms'
import { encodePaymentProof } from '../registry/src/payment'
import { buildManifest, signManifest } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
import type { PresetPricing } from '../src/shared/preset-manifest'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

/**
 * M2-A4 — IDEMPOTENCY AND DURABLE REPLAY DEFENCE.
 *
 * One payment must not buy twice, and a retried GET carrying the same
 * X-Payment must be SAFE. Both properties have to survive a restart, which is
 * what Magpie flagged when the spent set lived in a Map: replay defence that
 * resets on reboot is process-scoped theatre.
 *
 * Every restart here is a REAL one — fresh stores over the same data directory,
 * nothing carried in a closure — because the whole claim is about what is on
 * disk rather than what is in memory.
 */

const PAYEE = '0xA1b2C3d4E5f6789012345678901234567890aBcD'
const IDENTITY = 'cred-buyer'
const ONE_TIME: PresetPricing = { model: 'one-time', amount: '12.00', asset: 'USDC' }
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
let author: { publicKey: KeyObject; privateKey: KeyObject }
let auth: ReturnType<typeof authenticator>
let clock = 1_700_000_000_000
let settlements = 0

/** Everything a registry process holds. A restart builds a brand new one. */
interface Boot {
  url: string
  close: () => void
  store: RegistryStore
  receipts: ReceiptStore
  identity: IdentityService
  pricing: PricingDeps
}
let live: Boot

async function boot(): Promise<Boot> {
  const store = new RegistryStore(base)
  const log = new TransparencyLog(base)
  const identity = new IdentityService(base, CONFIG)
  const receipts = new ReceiptStore(base)
  const pricing: PricingDeps = {
    payouts: new PayoutStore(base),
    receipts,
    config: { chain: 'base', ttlMs: TTL },
    // FILE-backed, so quotes outlive the process that issued them.
    nonces: new FilePaymentNonces(base),
    facilitator: {
      settle: () => {
        settlements += 1
        return { ok: true }
      }
    },
    now: () => clock
  }
  const server = createRegistry({
    store, log, identity, pricing, dev: true,
    authorize: makeAuthorize(store, identity, pricing)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => server.close(),
    store, receipts, identity, pricing
  }
}

/** Stop the process and start a genuinely new one over the same disk. */
async function restart(): Promise<void> {
  live.close()
  live = await boot()
}

const seed = (name: string, version = 1): string => {
  const snapshot: TeamSnapshot = {
    name, savedAt: version, dir: '/w', nodes: [terminal(`${name}-${version}`)], connections: [], turns: {}
  }
  const built = buildManifest({
    scrub: scrubForPublish(snapshot), version, author: { handle: 'drej' }, pricing: ONE_TIME
  })
  if (!built.ok) throw new Error(`refused: ${built.reason}`)
  const manifest = signManifest(built.manifest, author.privateKey)
  live.store.putBlob(built.teamBytes)
  live.store.putManifest({ manifest, teamName: name, visibility: 'identified', identityId: IDENTITY })
  return manifest.id
}

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), 'registry-m2-a4-'))
  author = generateKeyPairSync('ed25519')
  auth = authenticator(IDENTITY)
  clock = 1_700_000_000_000
  settlements = 0
  live = await boot()
  live.identity.register(auth.credentialId, auth.jwk)
  live.pricing.payouts.bind(IDENTITY, PAYEE)
})
afterEach(() => {
  live.close()
  rmSync(base, { recursive: true, force: true })
})

async function tokenFor(who = auth): Promise<string> {
  const minted = (await (
    await fetch(`${live.url}/v1/identity/assert`, {
      method: 'POST',
      body: JSON.stringify({ ...who.assert(live.identity.challenge()), scope: 'download' })
    })
  ).json()) as { token: string }
  return minted.token
}

const gate = (id: string, token: string, proof?: string): Promise<Response> =>
  fetch(`${live.url}/v1/presets/${encodeURIComponent(id)}/manifest`, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(proof === undefined ? {} : { 'x-payment': proof })
    }
  })

async function quote(id: string, token: string): Promise<Terms> {
  const res = await gate(id, token)
  expect(res.status).toBe(402)
  return ((await res.json()) as { terms: Terms }).terms
}

const proofFor = (terms: Terms, tx = 'tx-1'): string =>
  encodePaymentProof({ nonce: terms.nonce, tx })

const reasonOf = async (res: Response): Promise<string | undefined> =>
  ((await res.json()) as { reason?: string }).reason

const receiptCount = (id: string): number =>
  live.receipts.forLineage(IDENTITY, live.store.lineageFor(id) as string).length

describe('one payment buys once', () => {
  it('records exactly ONE receipt however many times the GET is retried', async () => {
    const id = seed('Pro Toolkit')
    const token = await tokenFor()
    const proof = proofFor(await quote(id, token))
    for (let i = 0; i < 5; i++) expect((await gate(id, token, proof)).status).toBe(200)
    expect(receiptCount(id)).toBe(1)
  })

  it('settles with the facilitator ONCE, not once per retry', async () => {
    // The retries after the first are answered by the receipt, above the price
    // step — so nothing is asked of the facilitator at all.
    const id = seed('Pro Toolkit')
    const token = await tokenFor()
    const proof = proofFor(await quote(id, token))
    await gate(id, token, proof)
    const afterFirst = settlements
    for (let i = 0; i < 4; i++) await gate(id, token, proof)
    expect(afterFirst).toBe(1)
    expect(settlements).toBe(1)
  })

  it('holds under CONCURRENT submissions of the same proof', async () => {
    // The decision function is synchronous end to end, so two requests cannot
    // interleave inside it — but that is a property worth pinning rather than
    // assuming, because it is the kind of thing an await added later would
    // quietly break.
    const id = seed('Pro Toolkit')
    const token = await tokenFor()
    const proof = proofFor(await quote(id, token))
    const answers = await Promise.all(
      Array.from({ length: 8 }, () => gate(id, token, proof))
    )
    expect(answers.every((r) => r.status === 200)).toBe(true)
    expect(receiptCount(id)).toBe(1)
    expect(settlements).toBe(1)
  })

  it('a retried GET is SAFE: same answer, same bytes, no second charge', async () => {
    const id = seed('Pro Toolkit')
    const token = await tokenFor()
    const proof = proofFor(await quote(id, token))
    const first = await gate(id, token, proof)
    const second = await gate(id, token, proof)
    expect(first.status).toBe(second.status)
    expect(await first.json()).toEqual(await second.json())
    expect(receiptCount(id)).toBe(1)
  })
})

describe('replay defence survives a RESTART — not process-scoped theatre', () => {
  it('still calls a stranger replay `replayed` after a reboot', async () => {
    // The assertion Magpie will make. It was already true the moment receipts
    // became the durable record of what has been bought, and A4 makes the rest
    // of the machinery agree with it rather than keeping a second copy.
    const id = seed('Pro Toolkit')
    const token = await tokenFor()
    const proof = proofFor(await quote(id, token))
    expect((await gate(id, token, proof)).status).toBe(200)

    await restart()

    const stranger = authenticator('cred-stranger')
    live.identity.register(stranger.credentialId, stranger.jwk)
    const theirs = await tokenFor(stranger)
    const res = await gate(id, theirs, proof)
    expect(res.status).toBe(402)
    expect(await reasonOf(res)).toBe('replayed')
  })

  it('does not degrade a replay into `invalid` across the reboot', async () => {
    // The specific collapse a memory-only spent set produced: after a restart
    // every nonce is unknown, so a replay reads as "that is not a payment".
    const id = seed('Pro Toolkit')
    const token = await tokenFor()
    const proof = proofFor(await quote(id, token))
    await gate(id, token, proof)
    await restart()
    const stranger = authenticator('cred-other')
    live.identity.register(stranger.credentialId, stranger.jwk)
    expect(await reasonOf(await gate(id, await tokenFor(stranger), proof))).not.toBe('invalid')
  })

  it('keeps the BUYER entitled across a reboot, with no second payment', async () => {
    const id = seed('Pro Toolkit')
    const token = await tokenFor()
    await gate(id, token, proofFor(await quote(id, token)))
    await restart()
    expect((await gate(id, await tokenFor())).status).toBe(200)
    expect(settlements).toBe(1)
    expect(receiptCount(id)).toBe(1)
  })

  it('records no second receipt when the same proof returns after a reboot', async () => {
    const id = seed('Pro Toolkit')
    const token = await tokenFor()
    const proof = proofFor(await quote(id, token))
    await gate(id, token, proof)
    await restart()
    await gate(id, await tokenFor(), proof)
    expect(receiptCount(id)).toBe(1)
  })
})

describe('a quote outlives the process that issued it', () => {
  it('a buyer who paid mid-flight is NOT told their payment is invalid', async () => {
    // The case that made quotes durable, and it is the same lie as reporting
    // our outage as their fault: they took a real quote, moved real money, and
    // came back to a registry that had bounced. Telling them `invalid` accuses
    // somebody who did exactly what we asked.
    const id = seed('Pro Toolkit')
    const token = await tokenFor()
    const terms = await quote(id, token)

    await restart()

    const res = await gate(id, await tokenFor(), proofFor(terms))
    expect(res.status).toBe(200)
    expect(receiptCount(id)).toBe(1)
  })

  it('still lapses on time after a reboot — durability is not immortality', async () => {
    const id = seed('Pro Toolkit')
    const terms = await quote(id, await tokenFor())
    await restart()
    clock += TTL + 1
    expect(await reasonOf(await gate(id, await tokenFor(), proofFor(terms)))).toBe('expired')
  })

  it('remembers WHAT a quote was for, so a reboot cannot loosen the binding', async () => {
    const mine = seed('Pro Toolkit')
    const other = seed('Audit Pack')
    const terms = await quote(other, await tokenFor())
    await restart()
    // Same buyer, same price, wrong preset — still refused after the reboot.
    expect(await reasonOf(await gate(mine, await tokenFor(), proofFor(terms)))).toBe('invalid')
  })

  it('reads a truncated quote file without handing out `unknown` for live quotes', async () => {
    const id = seed('Pro Toolkit')
    const terms = await quote(id, await tokenFor())
    // A crash mid-append leaves half a line behind the good ones.
    appendFileSync(path.join(base, 'quotes.jsonl'), '{"nonce":"half')
    await restart()
    expect((await gate(id, await tokenFor(), proofFor(terms))).status).toBe(200)
  })

  it('keeps the file bounded rather than growing for every quote ever issued', async () => {
    const id = seed('Pro Toolkit')
    const token = await tokenFor()
    const nonces = new FilePaymentNonces(base)
    const binding = purchaseBinding(IDENTITY, id)
    // Well past the compaction threshold — and genuinely dead, which means
    // past the retention that keeps `expired` distinguishable from `unknown`,
    // not merely past their own TTL.
    const DAY = 24 * 60 * 60 * 1000
    for (let i = 0; i < 700; i++) nonces.mint(binding, clock, 1)
    const live = nonces.mint(binding, clock + DAY + 60_000, TTL)
    const lines = readFileSync(path.join(base, 'quotes.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
    expect(lines.length).toBeLessThan(700)
    // And compaction keeps the quote that still matters.
    expect(nonces.stateOf(live, clock + DAY + 60_000)).toBe('ok')
    void token
  })
})

describe('the receipt is the single record of a purchase', () => {
  it('is what makes a nonce spent — there is no second bookkeeping to drift', async () => {
    const id = seed('Pro Toolkit')
    const token = await tokenFor()
    const terms = await quote(id, token)
    await gate(id, token, proofFor(terms))
    expect(live.receipts.hasNonce(terms.nonce)).toBe(true)
    // Nothing else claims to know. The quote store still holds the quote; what
    // it does NOT hold is an opinion about whether it was spent.
    expect(live.pricing.nonces.stateOf(terms.nonce, clock)).toBe('ok')
  })

  it('fails SAFE: no receipt means not spent, so a retry can still settle', async () => {
    // The dangerous direction is the other one — a spend marked without a
    // receipt would tell a buyer whose money moved that they were replaying,
    // while owning nothing. Re-verifying the same tx moves no money twice.
    const id = seed('Pro Toolkit')
    const token = await tokenFor()
    const terms = await quote(id, token)
    live.pricing.facilitator = { settle: () => ({ ok: false, reason: 'unverifiable' }) }
    expect((await gate(id, token, proofFor(terms))).status).toBe(402)
    expect(live.receipts.hasNonce(terms.nonce)).toBe(false)
    live.pricing.facilitator = { settle: () => ({ ok: true }) }
    expect((await gate(id, token, proofFor(terms))).status).toBe(200)
    expect(receiptCount(id)).toBe(1)
  })
})
