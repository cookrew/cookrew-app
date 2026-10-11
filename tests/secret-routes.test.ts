// THE PHONE'S SIDE OF THE SLOT: names out, values in, owner token only.
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import type net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, redactSecretDetails, sealedTransport, type MobileApiDeps } from '../src/main/mobile-api'
import { createSecretsStore } from '../src/main/secrets-store'

const TOKEN = 'pairing-token-123'
const WALL = 'wall-token-456'
const VALUE = 'sk_live_51Hx9QxTESTVALUE0000'

describe('/api/secrets', () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const run of cleanup.splice(0)) run()
  })

  const start = async () => {
    const secrets = createSecretsStore({ baseDir: mkdtempSync(path.join(tmpdir(), 'cookrew-secret-routes-')) })
    const deps = { pairingToken: TOKEN, wallToken: WALL, turns: { list: () => [] }, secrets } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    cleanup.push(() => server.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    const call = async (p: string, init: { method?: string; body?: unknown; token?: string | null } = {}) => {
      const token = init.token === undefined ? TOKEN : init.token
      const response = await fetch(`http://127.0.0.1:${port}${p}`, {
        method: init.method ?? 'GET',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
      })
      const text = await response.text()
      return { status: response.status, text, json: text ? (JSON.parse(text) as unknown) : null }
    }
    return { secrets, call }
  }

  it('PUT seals, GET lists names only, DELETE forgets — all on the owner token', async () => {
    const { secrets, call } = await start()
    const put = await call('/api/secrets/stripe-key', { method: 'PUT', body: { value: VALUE, served: true } })
    expect(put.status).toBe(200)
    expect(put.json).toMatchObject({ name: 'stripe-key', served: true })
    expect(put.text).not.toContain(VALUE)
    expect(secrets.read('stripe-key')?.value).toBe(VALUE)
    const list = await call('/api/secrets')
    expect(list.status).toBe(200)
    expect(list.json).toEqual([{ name: 'stripe-key', served: true, updatedAt: expect.any(Number) }])
    expect(list.text).not.toContain(VALUE)
    const gone = await call('/api/secrets/stripe-key', { method: 'DELETE' })
    expect(gone.json).toEqual({ removed: true })
    expect(secrets.read('stripe-key')).toBeNull()
  })

  it('the read-only wall token is refused for everything, the GET included', async () => {
    const { call } = await start()
    expect((await call('/api/secrets', { token: WALL })).status).toBe(401)
    expect((await call('/api/secrets/stripe-key', { method: 'PUT', body: { value: VALUE }, token: WALL })).status).toBe(401)
    expect((await call('/api/secrets/stripe-key', { method: 'DELETE', token: WALL })).status).toBe(401)
    expect((await call('/api/secrets', { token: null })).status).toBe(401)
  })

  it('refuses a bad name and an empty value', async () => {
    const { call } = await start()
    expect((await call('/api/secrets/Not%20A%20Name', { method: 'PUT', body: { value: VALUE } })).status).toBe(400)
    expect((await call('/api/secrets/stripe-key', { method: 'PUT', body: { value: '' } })).status).toBe(400)
  })

  it('never answers a value on any route', async () => {
    const { secrets, call } = await start()
    secrets.put('stripe-key', VALUE)
    for (const p of ['/api/secrets', '/api/secrets/stripe-key']) {
      const got = await call(p)
      expect(got.text).not.toContain(VALUE)
    }
  })
})

describe('the transport a value may ride', () => {
  it('is TLS, or this Mac talking to itself', () => {
    expect(sealedTransport({ socket: { encrypted: true, remoteAddress: '192.168.2.46' } })).toBe(true)
    expect(sealedTransport({ socket: { remoteAddress: '127.0.0.1' } })).toBe(true)
    expect(sealedTransport({ socket: { remoteAddress: '::1' } })).toBe(true)
    expect(sealedTransport({ socket: { remoteAddress: '::ffff:127.0.0.1' } })).toBe(true)
    expect(sealedTransport({ socket: { remoteAddress: '192.168.2.46' } })).toBe(false)
    expect(sealedTransport({ socket: {} })).toBe(false)
  })

  it('a cleartext LAN PUT is refused with 403 and seals nothing; TLS from the LAN is taken', async () => {
    const secrets = createSecretsStore({ baseDir: mkdtempSync(path.join(tmpdir(), 'cookrew-secret-tls-')) })
    const deps = { pairingToken: TOKEN, turns: { list: () => [] }, secrets } as unknown as MobileApiDeps
    const call = async (socket: { encrypted?: boolean; remoteAddress: string }) => {
      const body = Buffer.from(JSON.stringify({ value: VALUE }))
      const request = Object.assign(require('node:stream').Readable.from([body]), {
        method: 'PUT',
        url: '/api/secrets/stripe-key',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'content-length': String(body.length), host: 'mac.local:8643' },
        socket
      }) as unknown as http.IncomingMessage
      let status = 0
      let text = ''
      const response = {
        writeHead: (code: number) => {
          status = code
          return response
        },
        setHeader: () => undefined,
        end: (chunk?: string) => {
          text += chunk ?? ''
        },
        writableEnded: false,
        destroyed: false
      } as unknown as http.ServerResponse
      await handleMobileApi(request, response, new URL('http://mac.local:8643/api/secrets/stripe-key'), deps)
      return { status, text }
    }
    const lan = await call({ remoteAddress: '192.168.2.46' })
    expect(lan.status).toBe(403)
    expect(lan.text).toContain('seal from the desktop or over TLS')
    expect(secrets.read('stripe-key')).toBeNull()
    const tls = await call({ encrypted: true, remoteAddress: '192.168.2.46' })
    expect(tls.status).toBe(200)
    expect(secrets.read('stripe-key')?.value).toBe(VALUE)
  })
})

describe('the small refusals', () => {
  it('no pairing token configured: refused, not open', async () => {
    const secrets = createSecretsStore({ baseDir: mkdtempSync(path.join(tmpdir(), 'cookrew-secret-notoken-')) })
    const deps = { turns: { list: () => [] }, secrets } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      expect((await fetch(`http://127.0.0.1:${port}/api/secrets`)).status).toBe(403)
      expect((await fetch(`http://127.0.0.1:${port}/api/secrets/stripe-key`, { method: 'DELETE' })).status).toBe(403)
    } finally {
      server.close()
    }
  })

  it('a name that is not even valid percent-encoding is 400, not 500', async () => {
    const secrets = createSecretsStore({ baseDir: mkdtempSync(path.join(tmpdir(), 'cookrew-secret-pct-')) })
    const deps = { pairingToken: TOKEN, turns: { list: () => [] }, secrets } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/secrets/%E0%A4%A`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } })
      expect(response.status).toBe(400)
    } finally {
      server.close()
    }
  })
})

describe('what the wall may know', () => {
  it('redacts the details of secret.* events and leaves every other event alone', () => {
    const read = { type: 'secret.read', entityId: 't1', details: 'stripe-key note:n1' }
    const other = { type: 'grant.revoke', entityId: 'x', details: 'via phone' }
    expect(redactSecretDetails(read)).toEqual({ type: 'secret.read', entityId: 't1' })
    expect(redactSecretDetails(other)).toBe(other)
  })

  it('the events query answers the wall token without secret names, and the owner with them', async () => {
    const rows = [
      { type: 'secret.requested', entityId: 't1', entityName: 'Tinker', workspaceId: 'w', workspaceName: 'W', actor: 'agent', timestamp: 1, details: 'stripe-key' },
      { type: 'note.write', entityId: 'n1', entityName: 'Keys', workspaceId: 'w', workspaceName: 'W', actor: 'agent', timestamp: 2, details: 'ok' }
    ]
    const deps = {
      pairingToken: TOKEN,
      wallToken: WALL,
      turns: { list: () => [] },
      events: { query: () => rows, count: () => ({}) }
    } as unknown as MobileApiDeps
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
      void handleMobileApi(request, response, url, deps).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    try {
      const wall = await (await fetch(`http://127.0.0.1:${port}/api/events/query`, { headers: { authorization: `Bearer ${WALL}` } })).text()
      expect(wall).toContain('secret.requested')
      expect(wall).not.toContain('stripe-key')
      expect(wall).toContain('"details":"ok"')
      const owner = await (await fetch(`http://127.0.0.1:${port}/api/events/query`, { headers: { authorization: `Bearer ${TOKEN}` } })).text()
      expect(owner).toContain('stripe-key')
    } finally {
      server.close()
    }
  })
})
