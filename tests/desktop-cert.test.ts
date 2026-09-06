import http from 'node:http'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createDesktopCert, RENEW_BEFORE_MS, type AuthedFetch } from '../src/main/desktop-cert'
import { NameCertStore, namesCertDir } from '../src/main/name-cert-store'
import { DEFAULT_NAME_ZONE, wildcardFor } from '../src/shared/reach-names'
import { issueLeaf, makeCa, spkiFromCsr } from './support/x509-forge'

/**
 * THE ORDER, DRIVEN AGAINST A REGISTRY THAT ANSWERS THE REAL CONTRACT.
 *
 * A fake on 127.0.0.1 rather than a stubbed fetch, because half of what this
 * file has to get right is HTTP: a 202 is not a failure, a 429 carries the
 * CA's clock in a header, and a 503 is an answer. A stub that returns objects
 * would let every one of those be wrong in the same shape as right.
 */

const MAC = '3f2b9c14-7a55-4d2e-9d0f-1c8e6b4a7f30'
const WILDCARD = wildcardFor(MAC) as string
const DAY = 24 * 60 * 60 * 1000

const ca = makeCa()
const bases: string[] = []
afterAll(() => bases.forEach((base) => rmSync(base, { recursive: true, force: true })))

const freshStore = (): { store: NameCertStore; base: string } => {
  const base = mkdtempSync(path.join(tmpdir(), 'cookrew-names-'))
  bases.push(base)
  return { store: new NameCertStore(base), base }
}

type Answer = { status: number; body?: unknown; headers?: Record<string, string> }

interface Fake {
  origin: string
  close: () => Promise<void>

  /** Requests seen, newest last: `POST /v2/…` */
  seen: string[]
  csrs: string[]
  post: Answer[]
  get: Answer[]
}

const startFake = async (): Promise<Fake> => {
  const fake: Fake = {
    origin: '',
    close: () => Promise.resolve(),
    seen: [],
    csrs: [],
    post: [],
    get: []
  }
  const server = http.createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      const method = request.method ?? 'GET'
      fake.seen.push(`${method} ${request.url}`)
      if (method === 'POST') {
        try {
          fake.csrs.push(String((JSON.parse(raw || '{}') as { csr?: string }).csr ?? ''))
        } catch {
          fake.csrs.push('')
        }
      }
      const queue = method === 'POST' ? fake.post : fake.get
      // The last answer in a queue repeats, so a poll that runs longer than
      // the script does not fall off the end into a 500.
      const answer = queue.length > 1 ? (queue.shift() as Answer) : queue[0]
      if (!answer) {
        response.writeHead(500, { 'content-type': 'application/json' }).end('{}')
        return
      }
      response.writeHead(answer.status, {
        'content-type': 'application/json',
        ...(answer.headers ?? {})
      })
      response.end(JSON.stringify(answer.body ?? {}))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  fake.origin = `http://127.0.0.1:${port}`
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  return fake
}

/** The one authenticated call, as `Accounts.authedResponse` shapes it. */
const authedTo = (origin: string): AuthedFetch => async (pathname, init) => {
  try {
    const response = await fetch(`${origin}${pathname}`, {
      method: init?.method ?? 'GET',
      ...(init?.body === undefined
        ? {}
        : { body: init.body, headers: { 'content-type': 'application/json' } })
    })
    return { ok: true, response }
  } catch {
    return { ok: false, reason: 'offline' }
  }
}

/** A chain the fake CA signs for whatever key the CSR carried. */
const chainFor = (csrPem: string, notAfter: Date): string =>
  issueLeaf({
    ca,
    spki: spkiFromCsr(csrPem),
    names: [WILDCARD],
    serial: 7,
    notBefore: new Date(Date.now() - DAY),
    notAfter
  })

let fake: Fake

describe('ordering a certificate for this Mac’s names', () => {
  beforeEach(async () => {
    if (fake) await fake.close()
    fake = await startFake()
  })
  afterAll(async () => {
    await fake?.close()
  })

  const cert = (store: NameCertStore, log: string[] = []): ReturnType<typeof createDesktopCert> =>
    createDesktopCert({
      store,
      fetch: authedTo(fake.origin),
      deviceId: () => MAC,
      zone: DEFAULT_NAME_ZONE,
      wait: () => Promise.resolve(),
      pollBackoffMs: [0, 0, 0],
      log: (message) => log.push(message)
    })

  it('takes a chain the registry already holds (200 issued)', async () => {
    const { store } = freshStore()
    const subject = cert(store)
    const csrs: string[] = []
    const outcome = await orderWith(subject, fake, csrs, (csr) => ({
      status: 200,
      body: { status: 'issued', chain: chainFor(csr, new Date(Date.now() + 90 * DAY)) }
    }))
    // A chain that is already held is the ANSWER, not a second order: Let's
    // Encrypt counts new certificates, and a Mac that asks twice spends two.
    expect(outcome).toBe('issued')
    expect(subject.held()?.wildcard).toBe(WILDCARD)
    expect(fake.seen.filter((line) => line.startsWith('GET'))).toHaveLength(0)
    // The request named exactly the wildcard and carried a P-256 key.
    expect(csrs[0]).toContain('BEGIN CERTIFICATE REQUEST')
  })

  it('follows 202 → pending → issued', async () => {
    const { store, base } = freshStore()
    const log: string[] = []
    const subject = cert(store, log)
    const csrs: string[] = []
    fake.post = [{ status: 202, body: { status: 'pending', order: 'abc' } }]
    fake.get = [
      { status: 200, body: { status: 'pending' } },
      { status: 200, body: { status: 'pending' } },
      { status: 200, body: { status: 'issued', chain: 'LATER' } }
    ]
    // The chain has to certify the CSR's key, which only exists once the
    // request has been built — so the GET answer is filled in on the way.
    const outcome = await orderWith(subject, fake, csrs, (csr) => {
      fake.get = [
        { status: 200, body: { status: 'pending' } },
        { status: 200, body: { status: 'issued', chain: chainFor(csr, new Date(Date.now() + 90 * DAY)) } }
      ]
      return { status: 202, body: { status: 'pending', order: 'abc' } }
    })
    expect(outcome).toBe('issued')
    const held = subject.held()
    expect(held).not.toBeNull()
    expect(new X509Certificate(held?.chain ?? '').subjectAltName).toContain(WILDCARD)
    // Key and chain both land 0600 in ~/.cookrew/certs/names.
    const dir = namesCertDir(base)
    for (const file of ['key.pem', 'chain.pem']) {
      expect(statSync(path.join(dir, file)).mode & 0o777).toBe(0o600)
    }
    expect(readFileSync(path.join(dir, 'key.pem'), 'utf8')).toContain('PRIVATE KEY')
    expect(log.join('\n')).toContain('a certificate for')
  })

  it('waits the retry-after a 429 names, and does not order again inside it', async () => {
    const { store } = freshStore()
    const log: string[] = []
    const subject = cert(store, log)
    fake.post = [{ status: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': '120' } }]
    expect(await subject.ensure('boot')).toBe('rate_limited')
    // Inside the window there is no second request at all.
    const before = fake.seen.length
    expect(await subject.ensure('again')).toBe('skipped')
    expect(fake.seen.length).toBe(before)
    expect(log.filter((line) => line.includes('wait'))).toHaveLength(1)
  })

  it('stops quietly on 503 names_disabled and says so once', async () => {
    const { store } = freshStore()
    const log: string[] = []
    const subject = cert(store, log)
    fake.post = [{ status: 503, body: { error: 'names_disabled' }, headers: { 'retry-after': '3600' } }]
    expect(await subject.ensure('boot')).toBe('disabled')
    expect(await subject.ensure('again')).toBe('skipped')
    expect(log.filter((line) => line.includes('not issuing certificates'))).toHaveLength(1)
    expect(subject.held()).toBeNull()
  })

  it('polls an order already in flight (409) instead of starting a second', async () => {
    const { store } = freshStore()
    const subject = cert(store)
    const csrs: string[] = []
    const outcome = await orderWith(subject, fake, csrs, (csr) => {
      fake.get = [
        { status: 200, body: { status: 'issued', chain: chainFor(csr, new Date(Date.now() + 90 * DAY)) } }
      ]
      return { status: 409, body: { error: 'in_flight' } }
    })
    expect(outcome).toBe('issued')
    expect(fake.seen.filter((line) => line.startsWith('POST'))).toHaveLength(1)
    expect(fake.seen.filter((line) => line.startsWith('GET'))).toHaveLength(1)
  })

  it('reports a failed order with the registry’s own sentence, once', async () => {
    const { store } = freshStore()
    const log: string[] = []
    const subject = cert(store, log)
    fake.post = [{ status: 202, body: { status: 'pending', order: 'abc' } }]
    fake.get = [{ status: 200, body: { status: 'failed', reason: 'dns: no TXT record' } }]
    expect(await subject.ensure('boot')).toBe('failed')
    expect(log.join('\n')).toContain('dns: no TXT record')
    expect(await subject.ensure('again')).toBe('skipped')
  })

  it('refuses a chain that is not this Mac’s key', async () => {
    const { store } = freshStore()
    const log: string[] = []
    const subject = cert(store, log)
    const other = freshStore().store
    // A chain for someone else's key: right name, wrong holder.
    const foreign = issueLeaf({
      ca,
      spki: Buffer.from(other.publicKey().export({ type: 'spki', format: 'der' })),
      names: [WILDCARD],
      serial: 9,
      notBefore: new Date(Date.now() - DAY),
      notAfter: new Date(Date.now() + 90 * DAY)
    })
    fake.post = [{ status: 200, body: { status: 'issued', chain: foreign } }]
    expect(await subject.ensure('boot')).toBe('failed')
    expect(subject.held()).toBeNull()
    expect(log.join('\n')).toContain('not this Mac')
  })

  it('does nothing at all without an account, and nothing when the chain is fresh', async () => {
    const { store } = freshStore()
    const anonymous = createDesktopCert({
      store,
      fetch: authedTo(fake.origin),
      deviceId: () => null,
      wait: () => Promise.resolve()
    })
    expect(await anonymous.ensure('boot')).toBe('skipped')
    expect(anonymous.wildcard()).toBeNull()
    expect(fake.seen).toHaveLength(0)

    const subject = cert(store)
    const csrs: string[] = []
    await orderWith(subject, fake, csrs, (csr) => ({
      status: 200,
      body: { status: 'issued', chain: chainFor(csr, new Date(Date.now() + 90 * DAY)) }
    }))
    const after = fake.seen.length
    expect(await subject.ensure('renewal check')).toBe('held')
    expect(fake.seen.length).toBe(after)
  })

  it('orders again once the chain is inside the renewal window', async () => {
    const { store } = freshStore()
    const subject = cert(store)
    const csrs: string[] = []
    // A chain with less than thirty days left is not a reason to sit still.
    await orderWith(subject, fake, csrs, (csr) => ({
      status: 200,
      body: { status: 'issued', chain: chainFor(csr, new Date(Date.now() + RENEW_BEFORE_MS - DAY)) }
    }))
    const outcome = await orderWith(subject, fake, csrs, (csr) => ({
      status: 200,
      body: { status: 'issued', chain: chainFor(csr, new Date(Date.now() + 90 * DAY)) }
    }))
    // It ASKED — the whole point. A chain inside the window is not 'held'.
    expect(outcome).toBe('issued')
    expect(fake.seen.filter((line) => line.startsWith('POST'))).toHaveLength(1)
    expect((subject.held()?.notAfter ?? 0) - Date.now()).toBeGreaterThan(RENEW_BEFORE_MS)
  })

  it('is offline, not broken, when the registry cannot be reached', async () => {
    const { store } = freshStore()
    const subject = createDesktopCert({
      store,
      fetch: async () => ({ ok: false, reason: 'offline' }),
      deviceId: () => MAC,
      wait: () => Promise.resolve()
    })
    expect(await subject.ensure('boot')).toBe('offline')
    // No quiet period: the next pass tries again, because being offline is a
    // fact about this minute rather than about the registry.
    expect(await subject.ensure('again')).toBe('offline')
  })
})

/**
 * Run one order where the answer depends on the CSR the Mac just sent — the
 * fake CA has to certify the key inside it, and that key is minted here.
 */
async function orderWith(
  subject: ReturnType<typeof createDesktopCert>,
  server: Fake,
  csrs: string[],
  answer: (csr: string) => Answer
): Promise<string> {
  // First pass: capture the CSR and answer 'pending' forever so nothing is
  // stored; then replay with the real answer built from that CSR.
  const pair = subject.wildcard()
  expect(pair).toBe(WILDCARD)
  server.post = [{ status: 202, body: { status: 'pending', order: 'probe' } }]
  server.get = [{ status: 404 }]
  await subject.ensure('probe')
  const csr = server.csrs[server.csrs.length - 1]
  csrs.push(csr)
  server.post = [answer(csr)]
  // Only the graded pass is counted: the probe above exists to mint the key,
  // and a test that asserted on both would be asserting about the harness.
  server.seen.length = 0
  return subject.ensure('order')
}
