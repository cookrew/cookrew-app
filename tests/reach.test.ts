import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { verifyWithDevice } from '../src/main/account-v2'
import {
  NETWORK_POLL_MS,
  certFingerprint,
  createReachPublisher,
  reachCard,
  sameReach,
  signReach,
  type ReachEndpoint,
  type ReachPublisherDeps,
  type SignedReach
} from '../src/main/reach'
import { canonicalJson } from '../src/shared/canonical-json'
import { canonicalJson as registryCanonicalJson, readReach, reachHostKind } from '../registry/src/v2-reach'
import { fakeAccount, tempBase } from './support/idv2'

const AT = 1_800_000_000_000
const FP = 'a'.repeat(64)

const endpoint = (url: string, kind: string, host: string): ReachEndpoint => ({ url, kind, host })

describe('the reach card', () => {
  it('keeps https endpoints and drops the plain-http listener', () => {
    const card = reachCard({
      deviceId: 'd1',
      endpoints: [
        endpoint('https://192.168.1.24:8643/?token=t', 'lan', '192.168.1.24'),
        endpoint('http://192.168.1.24:8639/?token=t', 'lan', '192.168.1.24')
      ],
      certFp: FP,
      relay: false,
      at: AT
    })
    expect(card.lan).toEqual([{ url: 'https://192.168.1.24:8643', certFp: FP }])
  })

  it('STRIPS THE PAIRING TOKEN — the card is a directory entry, not a credential', () => {
    const card = reachCard({
      deviceId: 'd1',
      endpoints: [endpoint('https://192.168.1.24:8643/?token=SECRET', 'lan', '192.168.1.24')],
      certFp: FP,
      relay: false,
      at: AT
    })
    expect(JSON.stringify(card)).not.toContain('SECRET')
    expect(JSON.stringify(card)).not.toContain('token')
  })

  it('puts the tailnet address in its own slot, and only one of them', () => {
    const card = reachCard({
      deviceId: 'd1',
      endpoints: [
        endpoint('https://mac.tail1.ts.net:8643/', 'tailscale', 'mac.tail1.ts.net'),
        endpoint('https://100.101.1.2:8643/', 'tailscale', '100.101.1.2'),
        endpoint('https://192.168.1.24:8643/', 'lan', '192.168.1.24')
      ],
      certFp: FP,
      relay: false,
      at: AT
    })
    expect(card.tailnet).toEqual({ url: 'https://mac.tail1.ts.net:8643', certFp: FP })
    expect(card.lan).toEqual([{ url: 'https://192.168.1.24:8643', certFp: FP }])
  })

  it('classifies a tailnet host even when the endpoint kind does not say so', () => {
    const card = reachCard({
      deviceId: 'd1',
      endpoints: [endpoint('https://100.75.9.9:8643/', 'other', '100.75.9.9')],
      certFp: FP,
      relay: false,
      at: AT
    })
    expect(card.tailnet).not.toBeNull()
    expect(card.lan).toEqual([])
  })

  it('drops loopback and de-duplicates repeated addresses', () => {
    const card = reachCard({
      deviceId: 'd1',
      endpoints: [
        endpoint('https://127.0.0.1:8643/', 'loopback', '127.0.0.1'),
        endpoint('https://192.168.1.24:8643/', 'lan', '192.168.1.24'),
        endpoint('https://192.168.1.24:8643/?token=t', 'lan', '192.168.1.24')
      ],
      certFp: FP,
      relay: false,
      at: AT
    })
    expect(card.lan).toHaveLength(1)
  })

  it('publishes nothing but the relay flag when there is no certificate', () => {
    const card = reachCard({
      deviceId: 'd1',
      endpoints: [endpoint('https://192.168.1.24:8643/', 'lan', '192.168.1.24')],
      certFp: null,
      relay: true,
      at: AT
    })
    expect(card.lan).toEqual([])
    expect(card.tailnet).toBeNull()
    expect(card.relay).toBe(true)
  })

  it('carries the relay flag as given', () => {
    const base = { deviceId: 'd1', endpoints: [], certFp: FP, at: AT }
    expect(reachCard({ ...base, relay: true }).relay).toBe(true)
    expect(reachCard({ ...base, relay: false }).relay).toBe(false)
  })
})

describe('the reach signature', () => {
  const account = fakeAccount()

  it('signs the canonical JSON, so key order cannot change the signature', () => {
    const card = reachCard({
      deviceId: account.deviceId,
      endpoints: [endpoint('https://192.168.1.24:8643/', 'lan', '192.168.1.24')],
      certFp: FP,
      relay: true,
      at: AT
    })
    const { sig } = signReach(account, card)
    expect(verifyWithDevice(account.publicKeyJwk, canonicalJson(card), sig)).toBe(true)
    // The same card, spelled with its keys in another order, verifies too.
    const reordered = JSON.parse(JSON.stringify({ at: card.at, relay: card.relay, tailnet: card.tailnet, lan: card.lan, deviceId: card.deviceId }))
    expect(verifyWithDevice(account.publicKeyJwk, canonicalJson(reordered), sig)).toBe(true)
  })

  it('will not verify a card whose address was swapped', () => {
    const card = reachCard({
      deviceId: account.deviceId,
      endpoints: [endpoint('https://192.168.1.24:8643/', 'lan', '192.168.1.24')],
      certFp: FP,
      relay: false,
      at: AT
    })
    const { sig } = signReach(account, card)
    const tampered = { ...card, lan: [{ url: 'https://10.0.0.9:8643', certFp: FP }] }
    expect(verifyWithDevice(account.publicKeyJwk, canonicalJson(tampered), sig)).toBe(false)
  })

  it('will not verify against another desktop key', () => {
    const card = reachCard({ deviceId: 'd', endpoints: [], certFp: FP, relay: true, at: AT })
    const { sig } = signReach(account, card)
    expect(verifyWithDevice(fakeAccount().publicKeyJwk, canonicalJson(card), sig)).toBe(false)
  })
})

describe('the certificate fingerprint', () => {
  const temp = tempBase()
  let pem = ''

  beforeAll(() => {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(temp.base, 'key.pem'),
      '-out', path.join(temp.base, 'cert.pem'),
      '-days', '2', '-subj', '/CN=Cookrew Test',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
    ], { stdio: 'ignore' })
    pem = readFileSync(path.join(temp.base, 'cert.pem'), 'utf8')
  })
  afterAll(() => temp.clean())

  it('is the SHA-256 of the DER, lowercase hex, matching what openssl reports', () => {
    const mine = certFingerprint(pem)
    expect(mine).toMatch(/^[0-9a-f]{64}$/)
    const openssl = execFileSync(
      'openssl',
      ['x509', '-noout', '-fingerprint', '-sha256', '-in', path.join(temp.base, 'cert.pem')],
      { encoding: 'utf8' }
    )
    expect(openssl.trim().split('=')[1].replace(/:/g, '').toLowerCase()).toBe(mine)
  })

  it('is the same whether given the PEM as a string or a buffer', () => {
    expect(certFingerprint(Buffer.from(pem))).toBe(certFingerprint(pem))
  })
})

describe('when reach is published', () => {
  const account = fakeAccount()
  const lan = [endpoint('https://192.168.1.24:8643/?token=t', 'lan', '192.168.1.24')]

  const publisher = (over: Partial<ReachPublisherDeps> = {}) => {
    const sent: SignedReach[] = []
    const deps: ReachPublisherDeps = {
      account: () => account,
      endpoints: () => lan,
      certFp: () => FP,
      relay: () => false,
      workspaces: () => [{ id: 'w1', name: 'Cookrew Dev' }],
      register: async (_workspaces, reach) => void sent.push(reach),
      now: () => AT,
      ...over
    }
    return { sent, publisher: createReachPublisher(deps) }
  }

  it('publishes on the first call and stays quiet when nothing changed', async () => {
    const { sent, publisher: p } = publisher()
    expect(await p.publish('boot')).toBe('published')
    expect(await p.publish('poll')).toBe('unchanged')
    expect(sent).toHaveLength(1)
  })

  it('publishes again when the addresses change', async () => {
    let addresses = lan
    const { sent, publisher: p } = publisher({ endpoints: () => addresses })
    await p.publish('boot')
    addresses = [endpoint('https://10.0.0.9:8643/', 'lan', '10.0.0.9')]
    expect(await p.publish('network change')).toBe('published')
    expect(sent).toHaveLength(2)
    expect(sent[1].reach.lan[0].url).toBe('https://10.0.0.9:8643')
  })

  it('publishes again when the certificate is reissued', async () => {
    let fp = FP
    const { sent, publisher: p } = publisher({ certFp: () => fp })
    await p.publish('boot')
    fp = 'b'.repeat(64)
    expect(await p.publish('cert')).toBe('published')
    expect(sent).toHaveLength(2)
  })

  it('NEVER publishes without an account', async () => {
    const { sent, publisher: p } = publisher({ account: () => null })
    expect(await p.publish('boot')).toBe('skipped')
    expect(await p.republish('toggle')).toBe('skipped')
    expect(sent).toEqual([])
  })

  it('NEVER publishes when the owner turned reachability off', async () => {
    const off = fakeAccount({ workspacesReachable: false })
    const { sent, publisher: p } = publisher({ account: () => off })
    expect(await p.publish('boot')).toBe('skipped')
    expect(sent).toEqual([])
  })

  it('publishes nothing when there is no address and no relay', async () => {
    const { sent, publisher: p } = publisher({ endpoints: () => [], relay: () => false })
    expect(await p.publish('boot')).toBe('skipped')
    expect(sent).toEqual([])
  })

  it('publishes a relay-only card when the relay is up with no addresses', async () => {
    const { sent, publisher: p } = publisher({ endpoints: () => [], relay: () => true })
    expect(await p.publish('boot')).toBe('published')
    expect(sent[0].reach).toMatchObject({ lan: [], tailnet: null, relay: true })
  })

  it('publishes again the moment the relay line comes up, and again when it drops', async () => {
    // The line is half the card, and it goes up long after boot. Without a
    // republish on the change a Mac that dialled out would sit advertising
    // `relay: false` until the next network poll — a phone off the LAN would
    // be told there is no way home while the way home was open.
    let held = false
    const { sent, publisher: p } = publisher({ relay: () => held })
    await p.publish('boot')
    held = true
    expect(await p.publish('relay link')).toBe('published')
    expect(sent[1].reach.relay).toBe(true)
    held = false
    expect(await p.publish('relay link')).toBe('published')
    expect(sent[2].reach.relay).toBe(false)
    // And a line that is simply still up is not news.
    expect(await p.publish('relay link')).toBe('unchanged')
    expect(sent).toHaveLength(3)
  })

  it('republishes on demand even when nothing changed — boot and the toggle', async () => {
    const { sent, publisher: p } = publisher()
    await p.publish('boot')
    expect(await p.republish('reachable on')).toBe('published')
    expect(sent).toHaveLength(2)
  })

  it('carries the workspaces alongside the card', async () => {
    const seen: unknown[] = []
    const { publisher: p } = publisher({
      register: async (workspaces) => void seen.push(workspaces)
    })
    await p.publish('boot')
    expect(seen[0]).toEqual([{ id: 'w1', name: 'Cookrew Dev' }])
  })

  it('survives a registry that refuses, and retries on the next change', async () => {
    let fail = true
    let addresses = lan
    const { publisher: p } = publisher({
      endpoints: () => addresses,
      setTimeout: () => ({ unref: () => undefined }),
      register: async () => {
        if (fail) throw new Error('offline')
        return { ok: true }
      }
    })
    expect(await p.publish('boot')).toBe('refused')
    expect(p.last()).toBeNull()
    fail = false
    addresses = [endpoint('https://10.0.0.9:8643/', 'lan', '10.0.0.9')]
    expect(await p.publish('network change')).toBe('published')
  })

  it('polls for a network change every minute', () => {
    const calls: number[] = []
    const { publisher: p } = publisher({
      setInterval: (_fn, ms) => {
        calls.push(ms)
        return { unref: () => undefined }
      }
    })
    p.watch()
    expect(calls).toEqual([NETWORK_POLL_MS])
    expect(NETWORK_POLL_MS).toBe(60_000)
  })

  it('fires the poll body, which publishes when the addresses moved', async () => {
    let addresses = lan
    let tick: (() => void) | null = null
    const { sent, publisher: p } = publisher({
      endpoints: () => addresses,
      setInterval: (fn) => {
        tick = fn
        return { unref: () => undefined }
      }
    })
    await p.publish('boot')
    p.watch()
    addresses = [endpoint('https://10.0.0.9:8643/', 'lan', '10.0.0.9')]
    ;(tick as unknown as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sent).toHaveLength(2)
  })
})

describe('reach comparison', () => {
  const card = reachCard({ deviceId: 'd', endpoints: [], certFp: FP, relay: true, at: AT })

  it('ignores the timestamp, so a quiet minute is not a change', () => {
    expect(sameReach(card, { ...card, at: new Date(AT + 60_000).toISOString() })).toBe(true)
  })

  it('sees a real difference', () => {
    expect(sameReach(card, { ...card, relay: false })).toBe(false)
    expect(sameReach(null, card)).toBe(false)
  })
})

describe('the two sides of the reach card agree', () => {
  const account = fakeAccount()
  const jwk = account.publicKeyJwk as Record<string, string>

  /** Exactly what the publisher sends: the card, and the signature over it. */
  const signedCard = (over: Partial<Parameters<typeof reachCard>[0]> = {}) => {
    const card = reachCard({
      deviceId: account.deviceId,
      endpoints: [
        endpoint('https://192.168.1.24:8643/?token=t', 'lan', '192.168.1.24'),
        endpoint('https://mac.tail1.ts.net:8643/', 'tailscale', 'mac.tail1.ts.net')
      ],
      certFp: FP,
      relay: true,
      at: AT,
      ...over
    })
    return signReach(account, card)
  }

  it('THE REGISTRY ACCEPTS WHAT THIS DESKTOP SIGNS', () => {
    // The whole point of this file. `at` was a number here and the registry
    // wants ISO 8601 — proven live as 400 bad_reach — and nothing on this side
    // could see it, because registerDesktop ANSWERS a refusal rather than
    // throwing one. This test is the thing that would have caught it.
    const { reach, sig } = signedCard()
    const read = readReach(account.deviceId, jwk, { reach, sig })
    expect(read).not.toBeNull()
    expect(read?.lan).toEqual([{ url: 'https://192.168.1.24:8643', certFp: FP }])
    expect(read?.tailnet).toEqual({ url: 'https://mac.tail1.ts.net:8643', certFp: FP })
    expect(read?.relay).toBe(true)
  })

  it('writes `at` as ISO 8601 to the millisecond, which is what the registry parses', () => {
    const { reach } = signedCard()
    expect(reach.at).toBe(new Date(AT).toISOString())
    expect(reach.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/)
    expect(Number.isFinite(Date.parse(reach.at))).toBe(true)
  })

  it('a number for `at` is what the registry refused — and can no longer be built', () => {
    const { reach, sig } = signedCard()
    const asNumber = { ...reach, at: AT as unknown as string }
    expect(readReach(account.deviceId, jwk, { reach: asNumber, sig })).toBeNull()
  })

  it('computes the same canonical bytes as the registry does', () => {
    const { reach } = signedCard()
    const card = {
      deviceId: account.deviceId,
      lan: reach.lan.map((a) => ({ url: a.url, certFp: a.certFp })),
      tailnet: reach.tailnet,
      relay: reach.relay,
      at: reach.at
    }
    expect(canonicalJson(card)).toBe(registryCanonicalJson(card))
  })

  it('names only hosts the registry allows', () => {
    const { reach } = signedCard()
    for (const address of reach.lan) expect(reachHostKind(address.url)).toBe('lan')
    expect(reachHostKind(reach.tailnet?.url)).toBe('tailnet')
  })

  it('is refused when another device signs it', () => {
    const card = reachCard({ deviceId: account.deviceId, endpoints: [], certFp: FP, relay: true, at: AT })
    const { sig } = signReach(fakeAccount(), card)
    expect(readReach(account.deviceId, jwk, { reach: card, sig })).toBeNull()
  })

  it('never sends more addresses than the registry will read', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      endpoint(`https://192.168.1.${i + 2}:8643/`, 'lan', `192.168.1.${i + 2}`)
    )
    const { reach, sig } = signedCard({ endpoints: many })
    expect(reach.lan).toHaveLength(8)
    expect(readReach(account.deviceId, jwk, { reach, sig })).not.toBeNull()
  })
})

describe('a refused publish is not a published one', () => {
  const account = fakeAccount()
  const lan = [endpoint('https://192.168.1.24:8643/?token=t', 'lan', '192.168.1.24')]

  const publisher = (register: ReachPublisherDeps['register'], over: Partial<ReachPublisherDeps> = {}) => {
    const waits: number[] = []
    const logs: string[] = []
    const p = createReachPublisher({
      account: () => account,
      endpoints: () => lan,
      certFp: () => FP,
      relay: () => false,
      workspaces: () => [],
      register,
      now: () => AT,
      log: (message) => logs.push(message),
      setTimeout: (_fn, ms) => {
        waits.push(ms)
        return { unref: () => undefined }
      },
      ...over
    })
    return { p, waits, logs }
  }

  it('DOES NOT CACHE a card the registry refused, so the next publish retries', async () => {
    let refuse = true
    const { p } = publisher(async () => (refuse ? { ok: false, reason: 'bad_reach' } : { ok: true }))
    expect(await p.publish('boot')).toBe('refused')
    expect(p.last()).toBeNull()
    // Nothing about the machine changed, and it must try again anyway.
    expect(await p.publish('poll')).toBe('refused')
    refuse = false
    expect(await p.publish('poll')).toBe('published')
    expect(p.last()).not.toBeNull()
  })

  it('says the registry\'s own sentence, once', async () => {
    const { p, logs } = publisher(async () => ({
      ok: false,
      reason: 'bad_reach',
      message: 'at must be ISO 8601'
    }))
    await p.publish('boot')
    await p.publish('poll')
    await p.publish('poll')
    const refusals = logs.filter((line) => line.includes('bad_reach'))
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toContain('at must be ISO 8601')
    expect(refusals[0]).toContain('retrying')
  })

  it('backs off 30 s, then a minute, then two, then five and stays there', async () => {
    // ONE retry is pending at a time, by design — a Mac that stacked a timer
    // per failure would hammer a recovering registry. So the test fires the
    // pending one to earn the next, which is exactly what the clock does.
    const waits: number[] = []
    const pending: (() => void)[] = []
    const p = createReachPublisher({
      account: () => account,
      endpoints: () => lan,
      certFp: () => FP,
      relay: () => false,
      workspaces: () => [],
      register: async () => ({ ok: false, reason: 'bad_reach' }),
      now: () => AT,
      setTimeout: (fn, ms) => {
        waits.push(ms)
        pending.push(fn)
        return { unref: () => undefined }
      }
    })
    await p.republish('boot')
    for (let i = 0; i < 5; i++) {
      pending.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(waits.slice(0, 5)).toEqual([30_000, 60_000, 120_000, 300_000, 300_000])
  })

  it('reports how long until the retry, and forgets it once one lands', async () => {
    let refuse = true
    const { p } = publisher(async () => (refuse ? { ok: false, reason: 'x' } : { ok: true }))
    await p.publish('boot')
    expect(p.retryInMs()).toBe(30_000)
    refuse = false
    await p.republish('manual')
    expect(p.retryInMs()).toBeNull()
  })

  it('fires the scheduled retry, and publishes when the registry recovers', async () => {
    let refuse = true
    let fire: (() => void) | null = null
    const { p } = publisher(
      async () => (refuse ? { ok: false, reason: 'x' } : { ok: true }),
      { setTimeout: (fn) => {
        fire = fn
        return { unref: () => undefined }
      } }
    )
    await p.publish('boot')
    refuse = false
    ;(fire as unknown as () => void)()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(p.last()).not.toBeNull()
  })

  it('treats a thrown network error the same as a refusal', async () => {
    const { p, waits } = publisher(async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(await p.publish('boot')).toBe('refused')
    expect(p.last()).toBeNull()
    expect(waits[0]).toBe(30_000)
  })
})
