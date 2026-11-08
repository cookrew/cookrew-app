import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { DeviceTransactions, hashBrowserSecret, hashCsrfToken } from '../registry/src/auth-device-transaction'
import { createProviders } from '../registry/src/v2-oauth-providers'
import { ProviderBinding } from '../registry/src/auth-provider-binding'
import { fakeOAuth, type FakeOAuth } from './support/fake-oauth'

const secret = () => randomBytes(32).toString('base64url')
let fake: FakeOAuth | undefined
afterEach(async () => { await fake?.close(); fake = undefined })

async function setup() {
  fake = await fakeOAuth()
  let time = 1_700_000_000_000
  const now = () => time
  const transactions = new DeviceTransactions({ audience: 'https://auth.cookrew.test', now, isDeviceRevoked: () => false })
  const browserSecret = secret(), csrfToken = secret()
  const keys = generateKeyPairSync('ed25519')
  const created = transactions.create({ device: { publicKeyJwk: keys.publicKey.export({ format: 'jwk' }) }, browserSecretHash: hashBrowserSecret(browserSecret), csrfHash: hashCsrfToken(csrfToken) })
  if (!created.ok) throw new Error('create failed')
  const binding = new ProviderBinding({ transactions, providers: createProviders(fake.config(), { now }), now, callbackOrigin: 'http://127.0.0.1:9876', isDeviceRevoked: () => false })
  const credentials = { transactionId: created.transactionId, browserSecret, csrfToken }
  const prove = () => transactions.prove(created.transactionId, { ...credentials, signature: sign(null, Buffer.from(created.transcript), keys.privateKey).toString('base64url') })
  return { binding, credentials, created, prove, advance: (ms: number) => { time += ms } }
}

async function callbackUrl(authorizeUrl: string): Promise<URL> {
  const response = await fetch(authorizeUrl, { redirect: 'manual' })
  return new URL(response.headers.get('location')!)
}

describe('device-bound provider proof', () => {
  it.each(['github', 'google'] as const)('binds %s proof to the proven device and original browser', async (provider) => {
    const s = await setup()
    expect(s.binding.start(provider, s.credentials)).toBeNull()
    expect(s.prove().ok).toBe(true)
    const start = s.binding.start(provider, s.credentials)!
    expect(s.binding.start(provider, s.credentials)).toBeNull()
    const url = await callbackUrl(start.authorizeUrl)
    expect(url.pathname).toBe(`/v2/oauth/${provider}/callback`)
    expect(await s.binding.callback(provider, url.searchParams)).toBe(true)
    expect(await s.binding.callback(provider, url.searchParams)).toBe(false)
    expect(s.binding.finish({ ...s.credentials, browserSecret: secret() })).toBeNull()
    expect(s.binding.finish({ ...s.credentials, csrfToken: secret() })).toBeNull()
    const result = s.binding.finish(s.credentials)!
    expect(result.device.device.deviceId).toBe(s.created.deviceId)
    expect(result.proof.provider).toBe(provider)
    expect(s.binding.finish(s.credentials)).toBeNull()
  })

  it('says whether it owns a callback state without spending it', async () => {
    const s = await setup(); s.prove()
    const url = await callbackUrl(s.binding.start('github', s.credentials)!.authorizeUrl)
    const state = url.searchParams.get('state')!
    expect(s.binding.owns(new URLSearchParams({ state: secret() }))).toBe(false)
    expect(s.binding.owns(new URLSearchParams([['state', state], ['state', state]]))).toBe(false)
    expect(s.binding.owns(url.searchParams)).toBe(true)
    expect(s.binding.owns(url.searchParams)).toBe(true)
    expect(await s.binding.callback('github', url.searchParams)).toBe(true)
    expect(s.binding.owns(url.searchParams)).toBe(false)
    await fake!.close(); fake = undefined
    const other = await setup(); other.prove()
    const expiring = await callbackUrl(other.binding.start('google', other.credentials)!.authorizeUrl)
    other.advance(300_000)
    expect(other.binding.owns(expiring.searchParams)).toBe(false)
  })

  it('rejects denial, provider mismatch, duplicate state and expiry', async () => {
    const s = await setup(); s.prove()
    const start = s.binding.start('github', s.credentials)!
    const url = await callbackUrl(start.authorizeUrl)
    expect(await s.binding.callback('google', url.searchParams)).toBe(false)
    expect(await s.binding.callback('github', url.searchParams)).toBe(false)
    expect(s.binding.finish(s.credentials)).toBeNull()
  })

  it('rejects forged codes and expiration after provider proof', async () => {
    const s = await setup(); s.prove()
    const start = s.binding.start('github', s.credentials)!
    const url = await callbackUrl(start.authorizeUrl)
    url.searchParams.set('code', 'forged')
    expect(await s.binding.callback('github', url.searchParams)).toBe(false)
    expect(s.binding.finish(s.credentials)).toBeNull()
    await fake!.close(); fake = undefined
    const next = await setup(); next.prove()
    const valid = await callbackUrl(next.binding.start('github', next.credentials)!.authorizeUrl)
    expect(await next.binding.callback('github', valid.searchParams)).toBe(true)
    next.advance(300_000)
    expect(next.binding.finish(next.credentials)).toBeNull()
  })

  it('fails closed on denial and on expiration before callback', async () => {
    const s = await setup(); s.prove(); fake!.denyNext()
    const first = s.binding.start('github', s.credentials)!
    const denied = await callbackUrl(first.authorizeUrl)
    expect(await s.binding.callback('github', denied.searchParams)).toBe(false)
    expect(s.binding.finish(s.credentials)).toBeNull()
    await fake!.close(); fake = undefined
    const other = await setup(); other.prove()
    const second = other.binding.start('github', other.credentials)!
    const expired = await callbackUrl(second.authorizeUrl)
    other.advance(300_000)
    expect(await other.binding.callback('github', expired.searchParams)).toBe(false)
  })
})
