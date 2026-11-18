// A watch in cookrew-seal/2 device mode: its id is a random uuid, so only the key
// the owner confirmed by its words lets it in (main/seal-watch-keys.ts, handshake.ts · keyOf).
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSealDevice } from '../src/main/seal-device'
import { createSealPinStore } from '../src/main/seal-pins'
import { createSealWatchKeys } from '../src/main/seal-watch-keys'
import { acceptDeviceHandshake, keyWords, startDeviceHandshake } from '../src/shared/seal2/handshake'
import { newDevice, verifyDevice } from './support/seal2-accounts'

const dirs: string[] = []
const dirIn = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seal-watch-keys-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A watch: an Ed25519 key, and an id that is NOT made from it, as watch/Sources/CookrewCore/Account.swift mints it. */
const newWatch = () => {
  const key = newDevice()
  const id = randomUUID()
  return { id, jwk: key.jwk, signer: { ...key.signer, deviceId: id } }
}

describe('the watch keys this Mac holds', () => {
  it('a claimed key waits with a fresh nonce; only the very key confirmed is let in', () => {
    const keys = createSealWatchKeys(path.join(dirIn(), 'keys.json'))
    const watch = newWatch()
    const nonce = keys.offer(watch.id, watch.jwk)
    expect(nonce).toHaveLength(16)
    expect(keys.keyOf(watch.id)).toBeNull()
    expect(keys.pending().map((row) => [row.deviceId, Buffer.from(row.nonce).toString('hex')])).toEqual([[watch.id, Buffer.from(nonce as Uint8Array).toString('hex')]])
    expect(keys.confirm(watch.id, newDevice().jwk.x)).toBe(false)
    expect(keys.confirm(watch.id, watch.jwk.x)).toBe(true)
    expect(keys.keyOf(watch.id)).toEqual(watch.jwk)
    expect(keys.pending()).toEqual([])
    // A second claim's nonce is a new one.
    expect(Buffer.from(keys.offer(watch.id, watch.jwk) as Uint8Array).equals(Buffer.from(nonce as Uint8Array))).toBe(false)
  })

  it('a claim with another key waits beside the confirmed one: the watch let in stays in, and "not the same" drops only the new key', () => {
    const keys = createSealWatchKeys(path.join(dirIn(), 'keys.json'))
    const watch = newWatch()
    keys.offer(watch.id, watch.jwk)
    keys.confirm(watch.id, watch.jwk.x)
    const planted = newDevice().jwk
    keys.offer(watch.id, planted)
    expect(keys.keyOf(watch.id)).toEqual(watch.jwk)
    keys.dropPending(watch.id)
    expect(keys.pending()).toEqual([])
    expect(keys.keyOf(watch.id)).toEqual(watch.jwk)
    keys.forgetAll()
    expect(keys.keyOf(watch.id)).toBeNull()
  })

  it('a key that waited a day without the owner\'s word cannot be confirmed', () => {
    let at = 1_000
    const keys = createSealWatchKeys(path.join(dirIn(), 'keys.json'), () => at)
    const watch = newWatch()
    keys.offer(watch.id, watch.jwk)
    at += 25 * 60 * 60 * 1000
    expect(keys.pending()).toEqual([])
    expect(keys.confirm(watch.id, watch.jwk.x)).toBe(false)
  })

  it('a file it cannot read holds nothing: no watch is let in', () => {
    const file = path.join(dirIn(), 'keys.json')
    writeFileSync(file, '{ broken')
    expect(createSealWatchKeys(file).keyOf(randomUUID())).toBeNull()
  })
})

describe('a watch in device mode', () => {
  const mac = newDevice()

  const shake = async (watch: ReturnType<typeof newWatch>, keyOf: (id: string) => Promise<ReturnType<typeof newDevice>['jwk'] | null>) => {
    const started = await startDeviceHandshake({ self: watch.signer, to: mac.id, verify: verifyDevice })
    const accepted = await acceptDeviceHandshake(started.hello, { self: mac.signer, verify: verifyDevice, keyOf })
    if (accepted === null) return null
    const done = await started.finish(accepted.accept)
    return done !== null && (await accepted.confirm(done.finish)) ? accepted : null
  }

  it('opens with the confirmed key, and with no other', async () => {
    const watch = newWatch()
    expect(await shake(watch, async () => watch.jwk)).not.toBeNull()
    expect(await shake(watch, async () => newDevice().jwk)).toBeNull()
    expect(await shake(watch, async () => null)).toBeNull()
  })

  it('the device trust lets in a confirmed watch and nothing else, whatever the pin policy', async () => {
    const dir = dirIn()
    const keys = createSealWatchKeys(path.join(dir, 'keys.json'))
    const pins = createSealPinStore(path.join(dir, 'pins.json'))
    pins.setPolicy('pinned')
    const account = { username: 'o', deviceId: mac.id, kind: 'desktop', name: 'Mac', privateKeyJwk: {}, publicKeyJwk: mac.jwk, registry: '', session: null, unlock: null } as never
    const sealed = createSealDevice({ account: () => account, desktops: async () => [], pins, watchKeys: keys })
    const watch = newWatch()
    keys.offer(watch.id, watch.jwk)
    expect(await sealed.device.trusted(watch.id)).toBe(false)
    keys.confirm(watch.id, watch.jwk.x)
    expect(await sealed.device.trusted(watch.id)).toBe(true)
    expect(await sealed.device.keyOf?.(watch.id)).toEqual(watch.jwk)
  })

  it('both screens show the same words for the two keys, and a swapped key shows others', async () => {
    const watch = newWatch()
    const nonce = new Uint8Array(16).fill(5)
    const onMac = await keyWords(watch.jwk, mac.jwk, nonce)
    expect(await keyWords(mac.jwk, watch.jwk, nonce)).toEqual(onMac)
    expect(await keyWords(newDevice().jwk, mac.jwk, nonce)).not.toEqual(onMac)
  })
})
