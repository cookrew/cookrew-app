import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TransparencyLog } from '../registry/src/log'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'

const origin = 'http://127.0.0.1:9876'
const keys = () => generateKeyPairSync('ed25519')
async function withRegistry(enabled: boolean, run: (server: Server) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'auth-device-http-'))
  const server = createRegistry({ store: new RegistryStore(dir), log: new TransparencyLog(dir), origin: 'https://cookrew.dev', authOrigin: origin, authDeviceTransactions: enabled ? { isDeviceRevoked: () => false, ttlMs: 200 } : undefined })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    await run(server)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
}
function call(server: Server, pathname: string, body: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any; cookie: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: (server.address() as AddressInfo).port, path: pathname, method: 'POST', headers: { host: '127.0.0.1:9876', origin, 'content-type': 'application/json', ...headers } }, (res) => {
      let data = ''; res.on('data', (chunk) => { data += chunk }); res.on('end', () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : {}, cookie: res.headers['set-cookie']?.[0] ?? '' }))
    })
    req.on('error', reject); req.end(JSON.stringify(body))
  })
}
const createPath = '/auth/device-transactions'
const proofPath = '/auth/device-transactions/proof'
const device = (key: ReturnType<typeof keys>) => ({ publicKeyJwk: key.publicKey.export({ format: 'jwk' }) })
const signature = (key: ReturnType<typeof keys>, transcript: string) => sign(null, Buffer.from(transcript), key.privateKey).toString('base64url')

describe('auth device transaction HTTP', () => {
  it('is dark by default and isolated from product and legacy routes', async () => {
    await withRegistry(false, async (server) => expect((await call(server, createPath, {})).status).toBe(404))
    await withRegistry(true, async (server) => {
      expect((await call(server, createPath, {}, { host: 'cookrew.dev' })).status).toBe(404)
      expect((await call(server, '/v2/sessions', {})).status).toBe(404)
    })
  })
  it('bounds bodies and rate limits repeated writes', async () => {
    await withRegistry(true, async (server) => {
      expect((await call(server, createPath, { device: 'x'.repeat(5000) })).status).toBe(413)
      let status = 0
      for (let i = 0; i < 30; i++) status = (await call(server, createPath, {})).status
      expect(status).toBe(429)
    })
  })
  it('binds proof to a secure cookie, independent CSRF and device key; rejects replay', async () => {
    await withRegistry(true, async (server) => {
      const key = keys(); const opened = await call(server, createPath, { device: device(key) })
      expect(opened.status).toBe(201)
      expect(opened.cookie).toMatch(/^__Host-/); expect(opened.cookie).toMatch(/; Secure/); expect(opened.cookie).toMatch(/; HttpOnly/)
      expect(opened.body.transcript).toContain(`audience:${origin}`)
      expect(opened.body).not.toHaveProperty('callbackState')
      const body = { transactionId: opened.body.transactionId, signature: signature(key, opened.body.transcript) }
      expect((await call(server, proofPath, body, { 'x-csrf-token': opened.body.csrfToken })).status).toBe(403)
      expect((await call(server, proofPath, body, { cookie: opened.cookie.split(';')[0], 'x-csrf-token': 'wrong' })).status).toBe(403)
      const headers = { cookie: opened.cookie.split(';')[0], 'x-csrf-token': opened.body.csrfToken }
      expect((await call(server, proofPath, body, headers)).status).toBe(204)
      expect((await call(server, proofPath, body, headers)).status).toBe(403)
    })
  })
  it('rejects forged origins, bad signatures, expiry and caller-selected audience', async () => {
    await withRegistry(true, async (server) => {
      const key = keys()
      expect((await call(server, createPath, { device: device(key) }, { origin: 'https://evil.test' })).status).toBe(403)
      expect((await call(server, createPath, { device: device(key), audience: 'https://evil.test' })).status).toBe(400)
      const opened = await call(server, createPath, { device: device(key) })
      const headers = { cookie: opened.cookie.split(';')[0], 'x-csrf-token': opened.body.csrfToken }
      const body = { transactionId: opened.body.transactionId, signature: signature(keys(), opened.body.transcript) }
      expect((await call(server, proofPath, body, { ...headers, origin: 'https://evil.test' })).status).toBe(403)
      expect((await call(server, proofPath, body, headers)).status).toBe(403)
      const expiring = await call(server, createPath, { device: device(keys()) })
      await new Promise((resolve) => setTimeout(resolve, 220))
      expect((await call(server, proofPath, { transactionId: expiring.body.transactionId, signature: 'bad' }, { cookie: expiring.cookie.split(';')[0], 'x-csrf-token': expiring.body.csrfToken })).status).toBe(403)
    })
  })
})
