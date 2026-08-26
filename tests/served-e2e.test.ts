import { describe, expect, it, afterEach } from 'vitest'
import http from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, sign } from 'node:crypto'
import { CallCredentialService } from '../src/main/call-credential'
import { callAssertionPayload } from '../src/main/call-ceremony'
import { ServedCallers } from '../src/main/served-callers'
import { devSettle, handleServedRoute } from '../src/main/served-endpoints'
import { ServedTemplates } from '../src/main/session-served'
import { RemoteCrewStore, parseCrewLink } from '../src/main/remote-crews'

/**
 * THE WHOLE EXCHANGE, OVER A REAL SOCKET — the acceptance the ruling implies:
 * an owner serves a saved crew, a stranger adds it by link, meets the gate,
 * pays once, and gets an answer; a second ask reuses the session and is never
 * charged again.
 *
 * Real http.Server, real fetch, real ed25519 — only the crew's own PTY is
 * faked, because a live agent is the one thing a unit run cannot own.
 */

let servers: http.Server[] = []
let dirs: string[] = []
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))))
  servers = []
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }))
  dirs = []
})

/** Stand up an owner's app serving one crew, exactly as index.ts mounts it. */
async function ownerApp(access: 'account' | 'paid', priceUsd?: string): Promise<string> {
  const base = mkdtempSync(path.join(tmpdir(), 'e2e-owner-'))
  dirs.push(base)
  const issuer = new CallCredentialService({ base })
  const callers = new ServedCallers()
  const served = new ServedTemplates({ orchOf: () => 'Conductor' })
  served.serve({
    serviceId: 'svc-research',
    templateId: 'research-crew',
    slug: 'research-crew',
    access,
    ...(access === 'paid' ? { priceUsd } : {})
  })
  const sessions = new Map<string, string>()

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const slug = url.pathname.split('/').filter(Boolean)[0] ?? ''
      const template = served.bySlug(slug)
      if (!template) {
        res.writeHead(404).end('{}')
        return
      }
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      let body: unknown = null
      try {
        body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
      } catch {
        body = null
      }
      const headers: Record<string, string | undefined> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v
      }
      const answer = await handleServedRoute(
        {
          issuer: {
            challenge: (b) => issuer.challenge(b),
            consumeChallenge: (v, b) => issuer.consumeChallenge(v, b),
            mint: (sub, scope) => issuer.mint(sub, scope),
            verifyToken: (t) => issuer.verifyToken(t)
          },
          callers,
          grantBudget: { allowsNewSession: () => true },
          admit: async (serviceId, sub) => {
            const key = `${serviceId}/${sub}`
            const open = sessions.get(key)
            if (open) return { workspaceId: `ws-${open}`, sessionId: open, created: false }
            const sessionId = `${sub}-1`
            sessions.set(key, sessionId)
            return { workspaceId: `ws-${sessionId}`, sessionId, created: true }
          },
          hasOpenSession: (serviceId, sub) => sessions.has(`${serviceId}/${sub}`),
          conductorFor: (sessionId) => `orch-${sessionId}`,
          // The crew's one door, faked: the only thing a unit run cannot own.
          ask: async (_orch, prompt) => `Conductor heard: ${prompt}`,
          settle: devSettle,
          crewFace: (t) => ({
            name: 'Research Crew',
            serviceId: t.serviceId,
            slug: t.slug,
            version: 1,
            access: t.access,
            ...(t.priceUsd !== undefined ? { priceUsd: t.priceUsd } : {}),
            door: 'Conductor',
            agents: 4
          })
        },
        template,
        (req.method ?? 'GET').toUpperCase(),
        url.pathname.slice(`/${slug}`.length) || '/',
        { headers, body }
      )
      if (answer === null) {
        res.writeHead(404).end('{}')
        return
      }
      res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers ?? {}) })
      res.end(JSON.stringify(answer.body))
    })()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** The caller's half: sign in with a real key, then ask. */
async function caller(origin: string, slug: string, sub = 'bear') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' })
  const api = async (p: string, init: RequestInit = {}) => {
    const res = await fetch(`${origin}/${slug}${p}`, {
      method: init.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      body: init.body
    })
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) }
  }
  const face = await api('/crew', { method: 'GET' })
  const signIn = async (): Promise<string> => {
    const ch = await api('/api/call/challenge')
    const challenge = (ch.body as { challenge: string }).challenge
    const signature = sign(
      null,
      Buffer.from(callAssertionPayload(face.body.serviceId, sub, challenge), 'utf8'),
      privateKey
    ).toString('base64url')
    const res = await api('/api/call/assert', {
      body: JSON.stringify({ sub, challenge, signature, jwk })
    })
    return (res.body as { token: string }).token
  }
  return { api, face, signIn }
}

describe('end to end: an owner serves, a stranger calls', () => {
  it('a free crew: add by link → sign in → ask → the crew answers', async () => {
    const origin = await ownerApp('account')

    // The caller pastes the address into ADD A CREW.
    const link = parseCrewLink(`${origin.replace('http://', '')}/research-crew`)
    expect(link).not.toBeNull()
    const store = new RemoteCrewStore(mkdtempSync(path.join(tmpdir(), 'e2e-dock-')))
    const { api, face, signIn } = await caller(origin, 'research-crew')
    expect(face.status).toBe(200)
    expect(face.body).toMatchObject({ name: 'Research Crew', door: 'Conductor', agents: 4 })

    // The chip lands in the dock — free and inert.
    const crew = store.add({
      origin,
      slug: 'research-crew',
      name: face.body.name,
      door: face.body.door,
      access: face.body.access,
      version: face.body.version,
      agents: face.body.agents
    })
    expect(store.list()).toHaveLength(1)
    expect(crew.payRef).toBeUndefined()

    // Placing it starts the line: 401 first…
    const cold = await api('/ask', { body: JSON.stringify({ prompt: 'hello' }) })
    expect(cold.status).toBe(401)
    expect(cold.headers.get('www-authenticate')).toMatch(/challenge=/)

    // …then sign in and ask.
    const token = await signIn()
    const answer = await api('/ask', {
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: 'what is 2+2?' })
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ reply: 'Conductor heard: what is 2+2?', created: true })
  })

  it('a paid crew: 402 quotes once, payment mints, the session then asks free', async () => {
    const origin = await ownerApp('paid', '2.50')
    const { api, signIn } = await caller(origin, 'research-crew')
    const token = await signIn()
    const auth = { authorization: `Bearer ${token}` }

    // The gate quotes at session START.
    const quoted = await api('/ask', { headers: auth, body: JSON.stringify({ prompt: 'hi' }) })
    expect(quoted.status).toBe(402)
    expect(quoted.body.terms).toMatchObject({ amount: '2.50', asset: 'USDC' })

    // A bad reference accuses the payment; nothing is charged, nothing minted.
    const bad = await api('/ask', {
      headers: { ...auth, 'x-payment': 'bad-tx' },
      body: JSON.stringify({ prompt: 'hi' })
    })
    expect(bad.body).toMatchObject({ reason: 'invalid', retryable: false })

    // A settling one mints the session and answers.
    const paid = await api('/ask', {
      headers: { ...auth, 'x-payment': 'tx-ok' },
      body: JSON.stringify({ prompt: 'hi' })
    })
    expect(paid.status).toBe(200)
    expect(paid.body.created).toBe(true)

    // R5, proven over the wire: mid-conversation there is no 402 left to hit.
    const second = await api('/ask', { headers: auth, body: JSON.stringify({ prompt: 'again' }) })
    expect(second.status).toBe(200)
    expect(second.body).toMatchObject({ reply: 'Conductor heard: again', created: false })
  })

  it('two callers get two sessions; one cannot reach the other', async () => {
    const origin = await ownerApp('account')
    const bear = await caller(origin, 'research-crew', 'bear')
    const kestrel = await caller(origin, 'research-crew', 'kestrel')
    const a = await bear.api('/ask', {
      headers: { authorization: `Bearer ${await bear.signIn()}` },
      body: JSON.stringify({ prompt: 'mine' })
    })
    const b = await kestrel.api('/ask', {
      headers: { authorization: `Bearer ${await kestrel.signIn()}` },
      body: JSON.stringify({ prompt: 'mine' })
    })
    expect(a.body.sessionId).not.toBe(b.body.sessionId)
    expect(a.body.created && b.body.created).toBe(true)
  })
})
