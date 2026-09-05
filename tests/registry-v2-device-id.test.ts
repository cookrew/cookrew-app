import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { generateKeyPairSync } from 'node:crypto'
import { deviceIdFor } from '../src/main/account-v2'

/**
 * ONE DEVICE ID, DERIVED THE SAME WAY IN BOTH LANGUAGES.
 *
 * The desktop computes it in node:crypto and the browser in WebCrypto. If the
 * two ever disagree the same key is two devices — a phone that signs in twice
 * appears twice, a revoke misses, and the Devices list stops being a list of
 * things. So the browser's own file is loaded and RUN here, against the app's
 * function, rather than a copy of it being re-typed into a test.
 */

const source = readFileSync(path.join(__dirname, '..', 'registry', 'assets', 'device-id.js'), 'utf8')

interface DeviceId {
  canonicalKey: (jwk: Record<string, string>) => string
  deviceIdFrom: (jwk: Record<string, string>) => Promise<string>
}

const browser = (): DeviceId => {
  const sandbox: Record<string, unknown> = { crypto: globalThis.crypto, TextEncoder }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  vm.runInNewContext(source, sandbox)
  return sandbox.cookrewDeviceId as DeviceId
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ed = (): Record<string, string> =>
  generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, string>

describe('the device id', () => {
  it('agrees with the desktop for an Ed25519 key', async () => {
    const jwk = ed()
    expect(await browser().deviceIdFrom(jwk)).toBe(deviceIdFor(jwk))
  })

  it('is uuid-shaped, version 8, RFC variant', async () => {
    expect(await browser().deviceIdFrom(ed())).toMatch(UUID)
  })

  it('is a pure function of the key — same key, same id; other key, other id', async () => {
    const { deviceIdFrom } = browser()
    const one = ed()
    const two = ed()
    // A `kid` or a `use` is not part of the key: RFC 7638 names the members.
    expect(await deviceIdFrom(one)).toBe(await deviceIdFrom({ ...one, use: 'sig', kid: 'ignored' }))
    expect(await deviceIdFrom(one)).not.toBe(await deviceIdFrom(two))
  })

  it('canonicalises an OKP key as crv, kty, x in that order and no whitespace', () => {
    const jwk = ed()
    expect(browser().canonicalKey(jwk)).toBe(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
  })

  it('takes the P-256 fallback, whose canonical members carry y as RFC 7638 says', async () => {
    const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }) as Record<
      string,
      string
    >
    const { canonicalKey, deviceIdFrom } = browser()
    expect(canonicalKey(jwk)).toBe(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    expect(await deviceIdFrom(jwk)).toMatch(UUID)
  })

  it('refuses a key it cannot name', async () => {
    await expect(browser().deviceIdFrom({ kty: 'RSA', n: 'x', e: 'AQAB' })).rejects.toThrow()
  })
})
