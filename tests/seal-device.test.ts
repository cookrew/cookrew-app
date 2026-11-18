import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deviceIdFor, mintDeviceKey, type AccountFile } from '../src/main/account-v2'
import { createSealDevice } from '../src/main/seal-device'
import { createSealPinStore } from '../src/main/seal-pins'
import { deviceSigned } from '../src/shared/seal2/handshake'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const pinsIn = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seal-device-'))
  dirs.push(dir)
  return createSealPinStore(path.join(dir, 'pins.json'))
}

const accountWith = (deviceId?: string): AccountFile => {
  const { privateKeyJwk, publicKeyJwk } = mintDeviceKey()
  return { username: 'owner', deviceId: deviceId ?? deviceIdFor(publicKeyJwk), kind: 'desktop', name: 'Mac', privateKeyJwk, publicKeyJwk, registry: 'https://cookrew.dev', session: null, unlock: null } as AccountFile
}

const OTHER = '53ab5b71-1430-891d-a7ce-2e3d6f3856bc'

describe('seal device mode on this desktop', () => {
  it('signs with the account key, and its signature verifies', async () => {
    const account = accountWith()
    const sealed = createSealDevice({ account: () => account, desktops: async () => [OTHER], pins: pinsIn() })
    const self = sealed.self()
    expect(self?.deviceId).toBe(account.deviceId)
    const message = deviceSigned('responder', new Uint8Array(32))
    const sig = await self!.sign(message)
    expect(await sealed.device.verify(self!.jwk, message, sig)).toBe(true)
    expect(await sealed.device.verify(self!.jwk, `${message}x`, sig)).toBe(false)
  })

  it('has no signer without an account, or when the id is not the key\'s own', () => {
    expect(createSealDevice({ account: () => null, desktops: async () => [], pins: pinsIn() }).self()).toBeNull()
    const forged = accountWith(OTHER)
    expect(createSealDevice({ account: () => forged, desktops: async () => [], pins: pinsIn() }).self()).toBeNull()
  })

  it('lets in only a desktop the account lists, and nobody when the listing cannot be asked', async () => {
    const account = accountWith()
    let listing: string[] | null = [OTHER]
    const sealed = createSealDevice({ account: () => account, desktops: async () => listing, pins: pinsIn() })
    expect(await sealed.device.trusted(OTHER)).toBe(true)
    expect(await sealed.device.trusted('48e5b104-a62d-8f13-a322-2b66aee4dbeb')).toBe(false)
    listing = null
    expect(await sealed.device.trusted('48e5b104-a62d-8f13-a322-2b66aee4dbeb')).toBe(false)
  })

  it('asks the listing again for an id it has not seen, at most then', async () => {
    const account = accountWith()
    let asked = 0
    let listing = [OTHER]
    let now = 0
    const sealed = createSealDevice({ account: () => account, desktops: async () => (asked++, listing), pins: pinsIn(), now: () => now })
    await sealed.device.trusted(OTHER)
    await sealed.device.trusted(OTHER)
    expect(asked).toBe(1)
    const added = '48e5b104-a62d-8f13-a322-2b66aee4dbeb'
    listing = [OTHER, added]
    expect(await sealed.device.trusted(added)).toBe(true)
    expect(asked).toBe(2)
    now += 61_000
    listing = []
    expect(await sealed.device.trusted(OTHER)).toBe(false)
  })

  it('with the policy pinned, a listed desktop still needs its pin', async () => {
    const account = accountWith()
    const pins = pinsIn()
    pins.setPolicy('pinned')
    const sealed = createSealDevice({ account: () => account, desktops: async () => [OTHER], pins })
    expect(await sealed.device.trusted(OTHER)).toBe(false)
    pins.pin(OTHER)
    expect(await sealed.device.trusted(OTHER)).toBe(true)
  })
})
