// What index.ts decides about a watch's sealed session (main/seal-watch-gate.ts), with the real key store,
// marks and device listing underneath: the routes it reaches, what Forget takes away, and who a claim's
// key is offered to (Relay round 4, C).
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deviceIdFor, mintDeviceKey, type AccountFile } from '../src/main/account-v2'
import { createSealDevice } from '../src/main/seal-device'
import { createSealMarks } from '../src/main/seal-marks'
import { createSealPinStore } from '../src/main/seal-pins'
import { createSealWatchKeys } from '../src/main/seal-watch-keys'
import { forgetWatchSeal, offerWatchSeal, watchDeviceHttp } from '../src/main/seal-watch-gate'
import { watchSealedRouteAllowed } from '../src/main/watch-routes'
import { keyWords } from '../src/shared/seal2/handshake'
import { newDevice } from './support/seal2-accounts'

const dirs: string[] = []
const fileIn = (name: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seal-watch-gate-'))
  dirs.push(dir)
  return path.join(dir, name)
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const newWatch = () => ({ id: randomUUID(), jwk: newDevice().jwk })

/** A watch whose words the owner confirmed here, and a store that holds it. */
function confirmedWatch() {
  const keys = createSealWatchKeys(fileIn('seal-watch-keys.json'))
  const watch = newWatch()
  keys.offer(watch.id, watch.jwk)
  expect(keys.confirm(watch.id, watch.jwk.x)).toBe(true)
  return { keys, watch }
}

describe('the routes a device-mode session reaches (deviceHttp)', () => {
  it('a confirmed watch reaches its own routes and the rekey, and nothing else', () => {
    const { keys, watch } = confirmedWatch()
    const http = watchDeviceHttp(keys, watchSealedRouteAllowed)
    expect(http(watch.id, 'GET', '/api/watch/cards')).toBe(true)
    expect(http(watch.id, 'POST', '/api/watch/rekey')).toBe(true)
    expect(http(watch.id, 'GET', '/api/fleet')).toBe(false)
    expect(http(watch.id, 'POST', '/api/terminal/t1/input')).toBe(watchSealedRouteAllowed('POST', '/api/terminal/t1/input'))
  })

  it('any other device, a desktop of the account or a watch still waiting for its words, reaches no route at all', () => {
    const { keys } = confirmedWatch()
    const http = watchDeviceHttp(keys, () => true)
    const desktop = newDevice()
    expect(http(desktop.id, 'GET', '/api/watch/cards')).toBe(false)
    const waiting = newWatch()
    keys.offer(waiting.id, waiting.jwk)
    expect(http(waiting.id, 'GET', '/api/watch/cards')).toBe(false)
    expect(http(randomUUID(), 'POST', '/api/watch/rekey')).toBe(false)
  })
})

describe('Forget on this Mac (watch:forget)', () => {
  it('takes the watch\'s keys and its sealed-only marks; other devices\' marks stay', () => {
    const { keys, watch } = confirmedWatch()
    const marks = createSealMarks(fileIn('seal-marks.json'))
    const phone = randomUUID()
    marks.mark(watch.id)
    marks.mark(phone)
    expect(marks.refuses(watch.id)).toBe(true)
    expect(forgetWatchSeal(keys, marks)).toEqual([watch.id])
    expect(keys.keyOf(watch.id)).toBeNull()
    expect(marks.refuses(watch.id)).toBe(false)
    expect(marks.refuses(phone)).toBe(true)
    expect(forgetWatchSeal(keys, marks)).toEqual([])
  })
})

const accountWith = (): AccountFile => {
  const { privateKeyJwk, publicKeyJwk } = mintDeviceKey()
  return { username: 'owner', deviceId: deviceIdFor(publicKeyJwk), kind: 'desktop', name: 'Mac', privateKeyJwk, publicKeyJwk, registry: 'https://cookrew.dev', session: null, unlock: null } as AccountFile
}

/** This Mac with a real seal-device listing behind it: `desktops` is what cookrew.dev answers (null: could not be asked). */
function macOffering(desktops: () => Promise<readonly string[] | null>) {
  const account = accountWith()
  const sealDevice = createSealDevice({ account: () => account, desktops, pins: createSealPinStore(fileIn('seal-pins.json')) })
  const keys = createSealWatchKeys(fileIn('seal-watch-keys.json'))
  const offer = (deviceId: string, jwk = newDevice().jwk) => offerWatchSeal(deviceId, jwk, { self: () => sealDevice.self(), listed: sealDevice.listed, keys })
  return { account, sealDevice, keys, offer }
}

describe('a claim\'s key offered for the sealed session (WatchHost.seal.offer)', () => {
  it('a watch the account does not list as a desktop gets this Mac\'s key, a fresh nonce and the words, and its key waits', async () => {
    const { account, keys, offer } = macOffering(async () => [])
    const watch = newWatch()
    const reply = await offer(watch.id.toUpperCase(), watch.jwk)
    expect(reply).not.toBeNull()
    expect(reply!.deviceId).toBe(account.deviceId)
    const nonce = new Uint8Array(Buffer.from(reply!.nonce, 'base64url'))
    expect(reply!.words).toEqual((await keyWords(watch.jwk, reply!.jwk, nonce)).words)
    expect(keys.pending().map((row) => [row.deviceId, row.jwk.x])).toEqual([[watch.id, watch.jwk.x]])
  })

  it('this Mac\'s own id, a desktop the account lists, and an id the listing could not be asked about get nothing, and nothing waits', async () => {
    const desktop = randomUUID()
    const { account, keys, offer } = macOffering(async () => [desktop])
    expect(await offer(account.deviceId)).toBeNull()
    expect(await offer(desktop)).toBeNull()
    expect(await offer(desktop.toUpperCase())).toBeNull()
    const unasked = macOffering(async () => null)
    expect(await unasked.offer(randomUUID())).toBeNull()
    const failing = macOffering(async () => {
      throw new Error('cookrew.dev is down')
    })
    expect(await failing.offer(randomUUID())).toBeNull()
    expect([...keys.pending(), ...unasked.keys.pending(), ...failing.keys.pending()]).toEqual([])
  })

  it('no account on this Mac: nothing', async () => {
    const keys = createSealWatchKeys(fileIn('seal-watch-keys.json'))
    expect(await offerWatchSeal(randomUUID(), newDevice().jwk, { self: () => null, listed: async () => false, keys })).toBeNull()
    expect(keys.pending()).toEqual([])
  })
})

describe('seal-device listed (Relay round 4, N11b)', () => {
  it('says true or false for an id when the listing answers, and null when it could not be asked', async () => {
    const desktop = randomUUID()
    expect(await macOffering(async () => [desktop]).sealDevice.listed(desktop)).toBe(true)
    expect(await macOffering(async () => [desktop]).sealDevice.listed(randomUUID())).toBe(false)
    expect(await macOffering(async () => null).sealDevice.listed(desktop)).toBeNull()
    const failing = macOffering(async () => {
      throw new Error('down')
    })
    expect(await failing.sealDevice.listed(desktop)).toBeNull()
  })
})
