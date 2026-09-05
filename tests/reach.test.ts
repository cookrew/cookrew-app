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
      register: async () => {
        if (fail) throw new Error('offline')
      }
    })
    expect(await p.publish('boot')).toBe('skipped')
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
    expect(sameReach(card, { ...card, at: AT + 60_000 })).toBe(true)
  })

  it('sees a real difference', () => {
    expect(sameReach(card, { ...card, relay: false })).toBe(false)
    expect(sameReach(null, card)).toBe(false)
  })
})
