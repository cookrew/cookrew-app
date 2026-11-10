import { describe, expect, it, vi } from 'vitest'
import { verify, createPublicKey } from 'node:crypto'
import { deviceIdOf, type DeviceJwk } from '../registry/src/auth-device-transaction'
import { deviceIdFor } from '../src/main/account-v2'
import { consoleDevice, deviceIdFrom, deviceKindOf, deviceNameOf, mintDeviceKey, type DeviceStore, type StoredDevice } from '../src/renderer/src/console/device-key'
import { deviceFromStored } from '../src/renderer/src/account-device'

/**
 * THE CONSOLE IS A DEVICE OF THE ACCOUNT, WITH A KEY OF ITS OWN (0.6.0).
 *
 * console.cookrew.dev is a new origin, so it mints its own key the first time
 * it signs in: P-256, kept in IndexedDB with the private half non-extractable.
 * The page can sign with it (sign-in, renewal, each machine's door) and no
 * script can take it away. Its id is derived from the key, the same way the
 * registry and the desktop derive it, so one key is one device everywhere.
 */

const memoryStore = (): DeviceStore & { saves: number; put: (device: StoredDevice) => void } => {
  let held: StoredDevice | null = null
  const store = {
    saves: 0,
    put: (device: StoredDevice) => void (held = device),
    load: async () => held,
    claim: async (device: StoredDevice, usable: (held: StoredDevice) => boolean) => {
      if (held !== null && usable(held)) return held
      held = device
      store.saves += 1
      return device
    },
    clear: async () => void (held = null)
  }
  return store
}

describe('the key', () => {
  it('is P-256, and the private half cannot be taken out of the browser', async () => {
    const key = await mintDeviceKey()
    expect(key.jwk).toMatchObject({ kty: 'EC', crv: 'P-256' })
    expect(Object.keys(key.jwk).sort()).toEqual(['crv', 'kty', 'x', 'y'])
    expect(key.pair.privateKey.extractable).toBe(false)
    // Never extractable, not even while it is being made: nothing to hook, nothing to export.
    const exported = vi.spyOn(crypto.subtle, 'exportKey')
    const again = await mintDeviceKey()
    expect(exported.mock.calls.every(([, exportedKey]) => exportedKey.type === 'public')).toBe(true)
    expect(again.pair.privateKey.extractable).toBe(false)
    exported.mockRestore()
    expect(key.pair.privateKey.usages).toEqual(['sign'])
    await expect(crypto.subtle.exportKey('jwk', key.pair.privateKey)).rejects.toThrow()
  })

  it('signs what the registry verifies: ECDSA over SHA-256, as r and s', async () => {
    const key = await mintDeviceKey()
    const device = deviceFromStored({ id: await deviceIdFrom(key.jwk), name: 'Console', jwk: key.jwk, pair: key.pair })
    expect(device).not.toBeNull()
    const message = new TextEncoder().encode('cookrew-auth/device-transaction/v1\npurpose:authenticate-device')
    const signature = Buffer.from(await device!.sign(message))
    expect(signature.byteLength).toBe(64)
    const publicKey = createPublicKey({ key: key.jwk as never, format: 'jwk' })
    expect(verify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true)
  })
})

describe('the id', () => {
  it('is the one the registry and the desktop derive from the same key', async () => {
    const key = await mintDeviceKey()
    const id = await deviceIdFrom(key.jwk)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(id).toBe(deviceIdOf(key.jwk as unknown as DeviceJwk))
    // A machine's key is Ed25519: the same rule, over the members that curve has.
    const machineKey = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' }
    expect(await deviceIdFrom(machineKey)).toBe(deviceIdFor(machineKey))
    expect(await deviceIdFrom(machineKey)).toBe(deviceIdOf(machineKey as DeviceJwk))
  })

  it('does not change with how the key is labelled', async () => {
    const key = await mintDeviceKey()
    expect(await deviceIdFrom({ ...key.jwk, kid: 'a label', use: 'sig', alg: 'ES256' })).toBe(await deviceIdFrom(key.jwk))
  })

  it('is refused for anything that is not a device key', async () => {
    await expect(deviceIdFrom({ kty: 'RSA', n: 'x', e: 'AQAB' })).rejects.toThrow()
  })
})

describe('this browser as a device', () => {
  it('is minted once and is the same device ever after', async () => {
    const store = memoryStore()
    const first = await consoleDevice({ ...store, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/142.0 Safari/537.36' })
    const again = await consoleDevice({ ...store, userAgent: 'anything else' })
    expect(store.saves).toBe(1)
    expect(again.id).toBe(first.id)
    expect(first.payload).toEqual({ id: first.id, kind: 'browser', name: 'Console in Chrome on macOS', jwk: first.payload.jwk })
    expect(first.id).toBe(await deviceIdFrom(first.payload.jwk))
  })

  it('is told apart from the same browser’s key at any other site by its name', () => {
    expect(deviceNameOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1')).toBe('Console on iPhone')
    expect(deviceNameOf('Mozilla/5.0 (Linux; Android 15) Chrome/142.0 Mobile Safari/537.36')).toBe('Console on Android phone')
    expect(deviceNameOf('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toBe('Console on iPad')
    expect(deviceNameOf('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0')).toBe('Console in Firefox on Linux')
    expect(deviceNameOf('')).toBe('Console in Browser on this computer')
  })

  it('is a phone on a phone and a browser elsewhere: the two the registry lets a page be', () => {
    expect(deviceKindOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('phone')
    expect(deviceKindOf('Mozilla/5.0 (Linux; Android 15)')).toBe('phone')
    expect(deviceKindOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('browser')
  })

  it('a stored entry that cannot sign is not a device: a new key is minted in its place', async () => {
    const store = memoryStore()
    store.put({ id: 'x', kind: 'browser', name: 'broken', jwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }, pair: { privateKey: {} as CryptoKey, publicKey: {} as CryptoKey } })
    const device = await consoleDevice({ ...store, userAgent: '' })
    expect(device.id).not.toBe('x')
    expect(store.saves).toBe(1)
  })

  it('two pages minting at once end up as one device: the first key kept is the key', async () => {
    const store = memoryStore()
    const slow = { ...store, load: async () => null, userAgent: '' }
    const [one, two] = await Promise.all([consoleDevice(slow), consoleDevice(slow)])
    expect(two.id).toBe(one.id)
    expect(store.saves).toBe(1)
  })
})
