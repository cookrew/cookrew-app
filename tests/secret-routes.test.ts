// THE PHONE'S SIDE OF THE SLOT: names out, values in, owner token only.
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import type net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
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
