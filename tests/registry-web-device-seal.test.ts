import { describe, expect, it } from 'vitest'
import { webcrypto } from 'node:crypto'
import { sealToDevice } from '../registry/src/v2-device-seal'
import '../registry/assets/device-seal.js'

/**
 * THE PHONE OPENS WHAT THE MAC SEALED — byte for byte (M5, R2).
 *
 * device-seal.js is the receiving half of registry/src/v2-device-seal.ts
 * written in WebCrypto, because the device that asked to reach a Mac is a page
 * on cookrew.dev and cookrew.dev must not be able to read the pairing URL it
 * is carrying. The only thing that makes two implementations of one cipher
 * safe is a test standing between them: this one is the Mac, sealing with the
 * Node half, and the page opens it under Node's WebCrypto.
 *
 * If this file fails, the phone gets a token it cannot read and quietly falls
 * back to the QR door for a reason nobody can see.
 */

type DeviceSeal = {
  open(
    privateKey: CryptoKey,
    info: string,
    sealed: { alg: string; e: string; sealed: string }
  ): Promise<string | null>
}
const CookrewDeviceSeal = (globalThis as unknown as { CookrewDeviceSeal: DeviceSeal }).CookrewDeviceSeal

const PAIRING_URL = 'https://cookrew.dev/relay/@drej/desktop/11111111-2222-3333-4444-555555555555/#pair=Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFy'

/**
 * A device key exactly as site.js mints it: one P-256 pair, the private half
 * imported NON-EXTRACTABLE for deriveBits. If this stops being possible the
 * browser cannot open a seal at all, so the mint is part of what is asserted.
 */
async function device(): Promise<{ jwk: Record<string, string>; key: CryptoKey }> {
  const subtle = webcrypto.subtle
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const priv = (await subtle.exportKey('jwk', pair.privateKey)) as Record<string, string>
  const pub = (await subtle.exportKey('jwk', pair.publicKey)) as Record<string, string>
  const seed = { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, d: priv.d }
  const key = await subtle.importKey('jwk', seed, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  expect(key.extractable).toBe(false)
  return { jwk: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }, key: key as CryptoKey }
}

describe('the page opens what the Mac sealed to it', () => {
  it('opens a pairing URL sealed to this device’s own key', async () => {
    const phone = await device()
    const sealed = sealToDevice(phone.jwk, 'reach:r1', PAIRING_URL)
    expect(sealed.alg).toBe('p256')
    // The envelope never carries the thing it is protecting.
    expect(JSON.stringify(sealed)).not.toContain('pair=')
    expect(await CookrewDeviceSeal.open(phone.key, 'reach:r1', sealed)).toBe(PAIRING_URL)
  })

  it('the same key under a different label opens nothing', async () => {
    const phone = await device()
    const sealed = sealToDevice(phone.jwk, 'reach:r1', PAIRING_URL)
    // The label is what stops a secret sealed for one request opening another.
    expect(await CookrewDeviceSeal.open(phone.key, 'reach:r2', sealed)).toBeNull()
  })

  it('another device of the same account opens nothing', async () => {
    const phone = await device()
    const other = await device()
    const sealed = sealToDevice(phone.jwk, 'reach:r1', PAIRING_URL)
    expect(await CookrewDeviceSeal.open(other.key, 'reach:r1', sealed)).toBeNull()
  })

  it('a tampered envelope is null, never a throw and never a partial read', async () => {
    const phone = await device()
    const sealed = sealToDevice(phone.jwk, 'reach:r1', PAIRING_URL)
    const flipped = { ...sealed, sealed: `${sealed.sealed.slice(0, -2)}${sealed.sealed.slice(-2) === 'AA' ? 'BB' : 'AA'}` }
    expect(await CookrewDeviceSeal.open(phone.key, 'reach:r1', flipped)).toBeNull()
    expect(await CookrewDeviceSeal.open(phone.key, 'reach:r1', { ...sealed, e: 'not.akey' })).toBeNull()
    expect(await CookrewDeviceSeal.open(phone.key, 'reach:r1', { ...sealed, e: 'nodot' })).toBeNull()
  })

  it('says no to an Ed25519 envelope rather than half-opening one', async () => {
    const phone = await device()
    // A browser cannot map an Ed25519 seed it does not hold. The caller is
    // meant to read this null and offer the QR door — see reach.js.
    const ed = { alg: 'x25519', e: 'AAAA', sealed: 'AAAA' }
    expect(await CookrewDeviceSeal.open(phone.key, 'reach:r1', ed)).toBeNull()
  })

  it('and the key it opens with can still sign, which renew will ask for', async () => {
    // One pair, two verbs: the mint imports the private half twice. A device
    // that could only decrypt would be a device that cannot renew its session.
    const subtle = webcrypto.subtle
    const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const priv = (await subtle.exportKey('jwk', pair.privateKey)) as Record<string, string>
    const seed = { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, d: priv.d }
    const signer = await subtle.importKey('jwk', seed, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer, new TextEncoder().encode('nonce'))
    expect(sig.byteLength).toBe(64)
  })
})
