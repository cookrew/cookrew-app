import { afterEach, describe, expect, it } from 'vitest'
import { X509Certificate, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2, type V2Identity } from '../registry/src/v2-routes'
import { canonicalJson } from '../registry/src/v2-reach'
import { AcmeClient } from '../registry/src/acme-client'
import { createNames, type NamesFeature } from '../registry/src/names'
import { createDnsServer, type DnsServer } from '../registry/src/dns-server'
import { ACCOUNT_KEY_FILE } from '../registry/src/acme-jose'
import { T, askUdp, buildQuery, parseAnswer } from './support/dns-probe'
import { startFakeAcme, type FakeAcme } from './support/fake-acme'
import { ecPair, makeCa, makeCsr, rsaPair } from './support/x509-forge'

/**
 * ISSUANCE, END TO END, WITH NO NETWORK AND NO STUBS.
 *
 * A real registry on a port, a real DNS server on another, and a CA in the
 * suite that validates dns-01 by ACTUALLY QUERYING that DNS server over UDP.
 * A Mac signs in, publishes its addresses, POSTs a CSR it generated here, and
 * polls until a chain comes back — the same six requests C2's Mac half will
 * make, over the same wire format Let's Encrypt speaks.
 *
 * The one thing this cannot prove is that Let's Encrypt agrees; see the
 * docblock on tests/support/fake-acme.ts for exactly where the line is.
 */

const PASSWORD = 'correct horse battery staple'
const ZONE = 'd.cookrew.dev'
const CERT_FP = 'a'.repeat(64)
const LAN = '192.168.2.40'

interface Up {
  origin: string
  dnsPort: number
  fake: FakeAcme
  v2: V2Identity
  names: NamesFeature | null
  dir: string
  close: () => Promise<void>
}

const alive: Up[] = []

async function up(
  options: { names?: boolean; refuseAll?: boolean; challengeDelayMs?: number; notAfter?: Date } = {}
): Promise<Up> {
  const dir = mkdtempSync(path.join(tmpdir(), 'cert-issue-'))
  const v2 = createV2(dir, { limits: { accountsPerMinute: 1000, sessionsPerMinute: 1000 } })
  // The three depend on each other in a ring — DNS answers for the zone, the
  // CA reads DNS, the zone's ACME client talks to the CA — so the responder is
  // resolved lazily and the ring is closed after all three exist.
  let names: NamesFeature | null = null
  const dns: DnsServer = createDnsServer({
    port: 0,
    address: '127.0.0.1',
    respond: (question) => names!.respond(question)
  })
  const dnsPort = await dns.start()
  const fake = await startFakeAcme({
    dnsPort,
    ca: makeCa(),
    badNonceOnce: true,
    ...(options.refuseAll === undefined ? {} : { refuseAll: options.refuseAll }),
    ...(options.challengeDelayMs === undefined ? {} : { challengeDelayMs: options.challengeDelayMs }),
    ...(options.notAfter === undefined ? {} : { notAfter: options.notAfter })
  })
  if (options.names !== false) {
    names = createNames({
      zone: ZONE,
      ns: [{ host: `ns1.${ZONE}`, address: '203.0.113.10' }],
      dataDir: dir,
      desktops: {
        find: (deviceId) => v2.accounts.desktopFor(deviceId),
        changedAt: () => v2.accounts.desktopsChangedAt()
      },
      acme: new AcmeClient({ directory: fake.directory, dataDir: dir, pollMs: 20, deadlineMs: 15_000 })
    })
  }
  const server: Server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    v2,
    ...(names === null ? {} : { names })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const site: Up = {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    dnsPort,
    fake,
    v2,
    names,
    dir,
    close: async () => {
      await fake.close()
      await dns.stop()
      await new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
      rmSync(dir, { recursive: true, force: true })
    }
  }
  alive.push(site)
  return site
}

afterEach(async () => {
  while (alive.length > 0) await alive.pop()?.close()
})

const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json'
})

interface Who {
  token: string
  deviceId: string
  /** The DEVICE key — what signs a reach card. Not the certificate key. */
  pair: { privateKey: KeyObject; publicKey: KeyObject }
}

/** An account whose first device is a desktop, exactly as the app claims one. */
async function claim(site: Up, username: string, kind: 'desktop' | 'phone' = 'desktop'): Promise<Who> {
  const pair = generateKeyPairSync('ed25519')
  const deviceId = randomUUID()
  const res = await fetch(`${site.origin}/v2/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      password: PASSWORD,
      device: { id: deviceId, kind, name: 'MacBook Pro', jwk: pair.publicKey.export({ format: 'jwk' }) }
    })
  })
  const body = (await res.json()) as { session: { token: string } }
  return { token: body.session.token, deviceId, pair }
}

/** The signed reach card, so the zone will answer this Mac's address label. */
async function publish(site: Up, who: Who): Promise<void> {
  const reach = {
    lan: [{ url: `https://${LAN}:8643`, certFp: CERT_FP }],
    tailnet: null,
    relay: true,
    at: new Date().toISOString()
  }
  const sig = sign(null, Buffer.from(canonicalJson({ deviceId: who.deviceId, ...reach }), 'utf8'), who.pair.privateKey)
  const res = await fetch(`${site.origin}/v2/me/desktops/${who.deviceId}`, {
    method: 'PUT',
    headers: bearer(who.token),
    body: JSON.stringify({
      name: 'MacBook Pro',
      workspaces: [{ id: 'w1', name: 'Cookrew Dev' }],
      reach,
      sig: sig.toString('base64url')
    })
  })
  expect(res.status).toBe(204)
}

const csrFor = (deviceId: string, over: { names?: string[]; commonName?: string | null; rsa?: number } = {}): string =>
  makeCsr({
    pair: over.rsa === undefined ? ecPair() : rsaPair(over.rsa),
    names: over.names ?? [`*.${deviceId}.${ZONE}`],
    ...(over.commonName === undefined ? {} : { commonName: over.commonName })
  })

const postCert = (site: Up, who: Who, csr: string): Promise<Response> =>
  fetch(`${site.origin}/v2/me/desktops/${who.deviceId}/cert`, {
    method: 'POST',
    headers: bearer(who.token),
    body: JSON.stringify({ csr })
  })

const getCert = (site: Up, who: Who): Promise<Response> =>
  fetch(`${site.origin}/v2/me/desktops/${who.deviceId}/cert`, { headers: bearer(who.token) })

/** Polls the route the way the Mac will, and gives up rather than hanging. */
async function settle(site: Up, who: Who, want: 'issued' | 'failed'): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const res = await getCert(site, who)
    const body = (await res.json()) as Record<string, unknown>
    if (body.status === want) return body
    if (body.status !== 'pending' && attempt > 3) throw new Error(`unexpected state ${JSON.stringify(body)}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`the order never became ${want}`)
}

const txtFor = async (site: Up, deviceId: string): Promise<ReturnType<typeof parseAnswer>> => {
  const reply = await askUdp(
    site.dnsPort,
    buildQuery({ name: `_acme-challenge.${deviceId}.${ZONE}`, type: T.TXT, edns: 4096 })
  )
  if (reply === null) throw new Error('the DNS server did not answer')
  return parseAnswer(reply)
}

describe('a Mac gets its own certificate', () => {
  it('goes from CSR to chain, with the CA reading our DNS for the proof', async () => {
    const site = await up()
    const mac = await claim(site, 'drej')
    await publish(site, mac)

    // Nothing held yet.
    expect((await getCert(site, mac)).status).toBe(404)

    const started = await postCert(site, mac, csrFor(mac.deviceId))
    expect(started.status).toBe(202)
    const accepted = (await started.json()) as { status: string; order: string }
    expect(accepted.status).toBe('pending')
    expect(accepted.order).toMatch(/^[0-9a-f-]{36}$/)

    const done = await settle(site, mac, 'issued')
    expect(done.status).toBe('issued')
    const chain = String(done.chain)
    expect(chain.split('BEGIN CERTIFICATE').length - 1).toBe(2)
    const leaf = new X509Certificate(chain)
    expect(leaf.subjectAltName).toContain(`*.${mac.deviceId}.${ZONE}`)
    expect(Number(done.notAfter)).toBe(new Date(leaf.validTo).getTime())
    expect(Number(done.notAfter)).toBeGreaterThan(Date.now())

    // THE PROOF WAS REAL: the CA read a TXT set off our own zone, over UDP,
    // and it was not empty.
    expect(site.fake.seen().length).toBeGreaterThan(0)
    expect(site.fake.seen()[0][0]).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(site.fake.issued()).toBe(1)

    // AND THE RECORD IS GONE. A challenge that outlives its order is a name
    // answering a question nobody will ask again.
    expect((await txtFor(site, mac.deviceId)).rcode).toBe(3)

    // The address label still resolves — that half never depended on the cert.
    const address = parseAnswer(
      (await askUdp(site.dnsPort, buildQuery({ name: `192-168-2-40.${mac.deviceId}.${ZONE}`, type: T.A })))!
    )
    expect(address.answers[0]?.data).toBe(LAN)
  })

  it('tells the phone that trusted names exist, beside the signed card', async () => {
    const site = await up()
    const mac = await claim(site, 'drej')
    await publish(site, mac)

    const before = (await (await fetch(`${site.origin}/v2/me`, { headers: bearer(mac.token) })).json()) as {
      desktops: { names: boolean; reach: { sig: string } }[]
    }
    expect(before.desktops[0].names).toBe(false)
    // The field is BESIDE the card, not in it: the card is exactly what the
    // desktop signed, or the phone's signature check breaks.
    expect(Object.keys(before.desktops[0].reach)).not.toContain('names')

    expect((await postCert(site, mac, csrFor(mac.deviceId))).status).toBe(202)
    await settle(site, mac, 'issued')

    const after = (await (await fetch(`${site.origin}/v2/me`, { headers: bearer(mac.token) })).json()) as {
      desktops: { names: boolean }[]
    }
    expect(after.desktops[0].names).toBe(true)
    const list = (await (await fetch(`${site.origin}/v2/me/desktops`, { headers: bearer(mac.token) })).json()) as {
      names: boolean
    }[]
    expect(list[0].names).toBe(true)
  })

  it('answers a second ask with the chain it already holds, not a second order', async () => {
    const site = await up()
    const mac = await claim(site, 'drej')
    await publish(site, mac)
    expect((await postCert(site, mac, csrFor(mac.deviceId))).status).toBe(202)
    const first = await settle(site, mac, 'issued')

    const again = await postCert(site, mac, csrFor(mac.deviceId))
    expect(again.status).toBe(200)
    const held = (await again.json()) as { status: string; chain: string }
    expect(held.status).toBe('issued')
    expect(held.chain).toBe(first.chain)
    expect(site.fake.issued()).toBe(1)
  })

  it('writes the ACME account key once, 0600, and never in an answer', async () => {
    const site = await up()
    const mac = await claim(site, 'drej')
    await publish(site, mac)
    expect((await postCert(site, mac, csrFor(mac.deviceId))).status).toBe(202)
    const done = await settle(site, mac, 'issued')
    const file = path.join(site.dir, ACCOUNT_KEY_FILE)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const key = readFileSync(file, 'utf8')
    expect(key).toContain('PRIVATE KEY')
    expect(JSON.stringify(done)).not.toContain('PRIVATE KEY')
  })

  it('records why an order failed instead of pending for ever', async () => {
    // The CA refuses whatever DNS says — a CAA refusal, a broken delegation,
    // any of the ways this fails in the world.
    const site = await up({ refuseAll: true })
    const mac = await claim(site, 'drej')
    await publish(site, mac)
    expect((await postCert(site, mac, csrFor(mac.deviceId))).status).toBe(202)
    const failed = await settle(site, mac, 'failed')
    expect(String(failed.reason)).toContain('invalid')
    // And the challenge record was taken back down on the way out.
    expect((await txtFor(site, mac.deviceId)).rcode).toBe(3)
    // One order an hour: the retry is refused rather than spending another.
    const again = await postCert(site, mac, csrFor(mac.deviceId))
    expect(again.status).toBe(429)
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(((await again.json()) as { error: string }).error).toBe('rate_limited')
  })

  it('refuses a second order while one is in flight', async () => {
    const site = await up({ challengeDelayMs: 1500 })
    const mac = await claim(site, 'drej')
    await publish(site, mac)
    expect((await postCert(site, mac, csrFor(mac.deviceId))).status).toBe(202)
    const second = await postCert(site, mac, csrFor(mac.deviceId))
    expect(second.status).toBe(409)
    expect(((await second.json()) as { error: string }).error).toBe('in_flight')
    expect((await (await getCert(site, mac)).json()).status).toBe('pending')
  })
})

describe('who may ask, and for what', () => {
  it('refuses every session but that Mac’s own', async () => {
    const site = await up()
    const mac = await claim(site, 'drej')
    const other = await claim(site, 'sam')
    await publish(site, mac)

    // Signed in, same registry, different device: the account is not enough.
    const wrong = await fetch(`${site.origin}/v2/me/desktops/${mac.deviceId}/cert`, {
      method: 'POST',
      headers: bearer(other.token),
      body: JSON.stringify({ csr: csrFor(mac.deviceId) })
    })
    expect(wrong.status).toBe(403)
    expect(((await wrong.json()) as { error: string }).error).toBe('not_this_desktop')

    // Not signed in at all.
    const none = await fetch(`${site.origin}/v2/me/desktops/${mac.deviceId}/cert`, { method: 'GET' })
    expect(none.status).toBe(401)
  })

  it('refuses a request for any name but this Mac’s wildcard', async () => {
    const site = await up()
    const mac = await claim(site, 'drej')
    await publish(site, mac)
    const others = await claim(site, 'sam')
    const bad = [
      { names: [`*.${others.deviceId}.${ZONE}`] },
      { names: [`*.${mac.deviceId}.${ZONE}`, 'cookrew.dev'] },
      { names: ['cookrew.dev'] },
      { names: [`${mac.deviceId}.${ZONE}`] },
      { names: [] },
      { names: [`*.${mac.deviceId}.${ZONE}`], commonName: 'cookrew.dev' },
      { names: [`*.${mac.deviceId}.${ZONE}`], rsa: 1024 }
    ]
    for (const over of bad) {
      const res = await postCert(site, mac, csrFor(mac.deviceId, over))
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string; detail: string }
      expect(body.error).toBe('bad_csr')
      expect(body.detail.length).toBeGreaterThan(0)
    }
    // A body with no CSR at all, and one that is not PEM.
    for (const csr of ['', 'hello', 'x'.repeat(100)]) {
      expect((await postCert(site, mac, csr)).status).toBe(400)
    }
    // Nothing was ordered by any of that.
    expect(site.fake.issued()).toBe(0)
  })

  it('takes a 2048-bit RSA request as readily as an EC one', async () => {
    const site = await up()
    const mac = await claim(site, 'drej')
    await publish(site, mac)
    expect((await postCert(site, mac, csrFor(mac.deviceId, { rsa: 2048 }))).status).toBe(202)
    const done = await settle(site, mac, 'issued')
    expect(new X509Certificate(String(done.chain)).publicKey.asymmetricKeyType).toBe('rsa')
  })

  it('answers 503 where no zone is configured, and leaves the card honest', async () => {
    const site = await up({ names: false })
    const mac = await claim(site, 'drej')
    await publish(site, mac)
    const res = await postCert(site, mac, csrFor(mac.deviceId))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('names_disabled')
    expect((await getCert(site, mac)).status).toBe(503)
    const me = (await (await fetch(`${site.origin}/v2/me`, { headers: bearer(mac.token) })).json()) as {
      desktops: { names: boolean }[]
    }
    expect(me.desktops[0].names).toBe(false)
  })
})
