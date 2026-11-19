// A desktop the owner blocks WHILE its handshake is under way (Relay round 4, F1 and S14): the real terminus, the
// real seal-device and pin store, the real handshake over HTTP. The hello's `trusted` asks cookrew.dev's listing,
// which a relay can stall; NOT THE SAME said meanwhile must still keep the desktop out, and so must one said
// between its hello and its finish.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deviceIdFor, mintDeviceKey, type AccountFile } from '../src/main/account-v2'
import { createSealTerminus, type SealTerminus } from '../src/main/canvas-seal-terminus'
import { createSealDevice } from '../src/main/seal-device'
import { createSealPinStore, type SealPinStore } from '../src/main/seal-pins'
import { createSealWatchKeys, type SealWatchKeys } from '../src/main/seal-watch-keys'
import { startDeviceHandshake } from '../src/shared/seal2/handshake'
import { Seal2RefusedError, shakeHandsOverHttp } from '../src/shared/seal2/http-link'
import { newDevice, verifyDevice } from './support/seal2-accounts'

const dirs: string[] = []
const servers: Server[] = []
const terminuses: SealTerminus[] = []
afterEach(async () => {
  for (const terminus of terminuses.splice(0)) terminus.close()
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const accountWith = (): AccountFile => {
  const { privateKeyJwk, publicKeyJwk } = mintDeviceKey()
  return { username: 'owner', deviceId: deviceIdFor(publicKeyJwk), kind: 'desktop', name: 'Mac', privateKeyJwk, publicKeyJwk, registry: 'https://cookrew.dev', session: null, unlock: null } as AccountFile
}

/** A listing held until the test lets it answer, as a stalled relay holds cookrew.dev's. */
function heldListing() {
  let release: (ids: readonly string[]) => void = () => undefined
  let asked = 0
  const desktops = (): Promise<readonly string[]> => {
    asked += 1
    return new Promise((resolve) => (release = resolve))
  }
  return { desktops, release: (ids: readonly string[]) => release(ids), asked: () => asked }
}

/** Runs inside the Mac's check of a finish's signature, once set: the moment between a finish arriving and its session opening. */
interface Hooks {
  duringFinish?: () => void
  /** Watches whose words the owner confirmed (R2). */
  watchKeys?: SealWatchKeys
  /** In place of the seal device's own answer at a finish. */
  admits?: (deviceId: string) => boolean
}

async function macWith(desktops: () => Promise<readonly string[] | null>, hooks: Hooks = {}): Promise<{ pins: SealPinStore; terminus: SealTerminus; origin: string; macId: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'seal-device-race-'))
  dirs.push(dir)
  const pins = createSealPinStore(path.join(dir, 'seal-pins.json'))
  const account = accountWith()
  const sealDevice = createSealDevice({ account: () => account, desktops, pins, ...(hooks.watchKeys ? { watchKeys: hooks.watchKeys } : {}) })
  const terminus = createSealTerminus({
    codeFor: () => null,
    dial: () => ({ write: () => undefined, end: () => undefined, destroy: () => undefined }),
    device: {
      ...sealDevice.device,
      ...(hooks.admits ? { admits: hooks.admits } : {}),
      verify: async (jwk, message, sig) => {
        if (message.includes('initiator')) hooks.duringFinish?.()
        return sealDevice.device.verify(jwk, message, sig)
      }
    }
  })
  terminuses.push(terminus)
  const server = createServer((request, response) => void terminus.handle(request, response, { device: request.headers['x-test-device'] as string }))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { pins, terminus, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, macId: account.deviceId }
}

/** The other desktop's handshake to the Mac; `between` runs after the hello is answered and before the finish is sent. */
async function dial(mac: { origin: string; macId: string }, desk: ReturnType<typeof newDevice>, between: () => void | Promise<void> = () => undefined) {
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/~seal/finish')) await between()
    return fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), 'x-test-device': desk.id } })
  }) as typeof fetch
  const started = await startDeviceHandshake({ self: desk.signer, to: mac.macId, verify: verifyDevice })
  return shakeHandsOverHttp({ url: (route) => `${mac.origin}${route}`, fetchFn }, started, async (said) => new Seal2RefusedError('device', String(said?.error)))
}

const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !ok(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5))
  if (!ok()) throw new Error('never happened')
}

describe('NOT THE SAME during a desktop\'s handshake', () => {
  it('endPeer while the finish is being checked: refused, never a 200 for a session that was not opened', async () => {
    const desk = newDevice()
    const hooks: Hooks = {}
    const mac = await macWith(async () => [desk.id], hooks)
    hooks.duringFinish = () => mac.terminus.endPeer(desk.id, 'the owner said not the same')
    await expect(dial(mac, desk)).rejects.toBeInstanceOf(Seal2RefusedError)
    expect(mac.terminus.stats()).toMatchObject({ sessions: 0, pending: 0 })
  })

  it('said while the listing is being asked (a relay stalling it): the hello is refused, no session', async () => {
    const listing = heldListing()
    const mac = await macWith(listing.desktops)
    const desk = newDevice()
    const dialled = dial(mac, desk)
    await until(() => listing.asked() > 0)
    mac.pins.block(desk.id)
    listing.release([desk.id])
    await expect(dialled).rejects.toThrow(/not a machine of this account/)
    expect(mac.terminus.stats()).toMatchObject({ sessions: 0, pending: 0 })
  })

  it('said between its hello and its finish: the finish is refused, no session', async () => {
    const desk = newDevice()
    const listed = await macWith(async () => [desk.id])
    await expect(dial(listed, desk, () => listed.pins.block(desk.id))).rejects.toBeInstanceOf(Seal2RefusedError)
    expect(listed.terminus.stats()).toMatchObject({ sessions: 0, pending: 0 })
    // The control: not blocked, the same handshake opens a session.
    const other = newDevice()
    const open = await macWith(async () => [other.id])
    await dial(open, other)
    expect(open.terminus.stats().sessions).toBe(1)
  })

  it('endPeer between its hello and its finish drops the waiting hello: the finish opens nothing (S14)', async () => {
    const desk = newDevice()
    const mac = await macWith(async () => [desk.id])
    // The waiting hello is gone: the finish finds no such session (404).
    await expect(dial(mac, desk, () => mac.terminus.endPeer(desk.id, 'the owner said not the same'))).rejects.toThrow(/did not open \(404\)/)
    expect(mac.terminus.stats()).toMatchObject({ sessions: 0, pending: 0 })
  })
})

describe('a device seal that cannot say whether it admits (Relay round 4, LOW)', () => {
  it('fails closed: only a yes opens a session', async () => {
    const desk = newDevice()
    const mac = await macWith(async () => [desk.id], { admits: (() => undefined) as unknown as (deviceId: string) => boolean })
    await expect(dial(mac, desk)).rejects.toBeInstanceOf(Seal2RefusedError)
    expect(mac.terminus.stats()).toMatchObject({ sessions: 0, pending: 0 })
  })
})

describe('a watch forgotten during its handshake (R2)', () => {
  /** A watch: its own key, and an id not made from it, confirmed here by its words. */
  function confirmedWatch() {
    const dir = mkdtempSync(path.join(tmpdir(), 'seal-device-race-watch-'))
    dirs.push(dir)
    const keys = createSealWatchKeys(path.join(dir, 'seal-watch-keys.json'))
    const key = newDevice()
    const id = randomUUID()
    keys.offer(id, key.jwk)
    expect(keys.confirm(id, key.jwk.x)).toBe(true)
    return { keys, watch: { ...key, id, signer: { ...key.signer, deviceId: id } } }
  }

  it('confirmed, it opens a session; forgotten between its hello and its finish, it opens none', async () => {
    const kept = confirmedWatch()
    const open = await macWith(async () => [], { watchKeys: kept.keys })
    await dial(open, kept.watch)
    expect(open.terminus.stats().sessions).toBe(1)
    const lost = confirmedWatch()
    const mac = await macWith(async () => [], { watchKeys: lost.keys })
    await expect(dial(mac, lost.watch, () => void lost.keys.forgetAll())).rejects.toBeInstanceOf(Seal2RefusedError)
    expect(mac.terminus.stats()).toMatchObject({ sessions: 0, pending: 0 })
  })
})
