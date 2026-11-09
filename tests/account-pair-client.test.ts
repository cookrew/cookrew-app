import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAccountPairDoor } from '../src/main/account-pair'
import { handleAccountPairRoutes } from '../src/main/account-pair-routes'
import { createAdmittedDeviceStore, type AdmittedDeviceStore } from '../src/main/admitted-devices'
import { createV2CallTokenVerifier, v2KeysOverHttp } from '../src/main/v2-call-token'
import { forgetGrantRests } from '../registry/src/v2-device-grant'
import {
  enterWithGrant,
  grantOptions,
  proveForGrant,
  type GrantStore,
  type Http,
  type PairClientDeps
} from '../src/renderer/src/account-pair-client'
import type { DeviceGrant } from '../src/shared/account-pair'
import { fakeAccount, tempBase } from './support/idv2'
import { b64u, getAssertion, GET_FLAGS_VERIFIED, type Pair } from './support/webauthn'
import { grantWorld, PASSWORD, type Browser, type GrantWorld } from './support/grant-world'

/**
 * THE PHONE, cookrew.dev AND TWO MACHINES, OVER HTTP (owner 2026-11-09).
 *
 * The browser code runs in node with node's WebCrypto; cookrew.dev is the real
 * registry; each machine is the real door behind its real routes, checking the
 * pass against the registry's /v2/keys exactly as the app does.
 */

const memoryGrants = (): GrantStore & { held: DeviceGrant | null } => {
  const store = {
    held: null as DeviceGrant | null,
    read: () => store.held,
    write: (grant: DeviceGrant) => void (store.held = grant),
    clear: () => void (store.held = null)
  }
  return store
}

const authenticator = (pair: Pair, credentialId: Buffer, origin: string) => async (options: CredentialRequestOptions): Promise<Credential> => {
  const asked = options.publicKey!
  const challenge = b64u(new Uint8Array(asked.challenge as ArrayBuffer))
  const made = getAssertion({ pair, credentialId, challenge, origin, rpId: asked.rpId!, flags: GET_FLAGS_VERIFIED })
  const bytes = (text: string): ArrayBuffer => new Uint8Array(Buffer.from(text, 'base64url')).buffer
  return {
    id: made.id,
    rawId: bytes(made.id),
    type: 'public-key',
    response: {
      clientDataJSON: bytes(made.response.clientDataJSON),
      authenticatorData: bytes(made.response.authenticatorData),
      signature: bytes(made.response.signature)
    }
  } as unknown as Credential
}

interface Machine {
  readonly desktopId: string
  readonly http: Http
  readonly admitted: AdmittedDeviceStore
  readonly close: () => Promise<void>
}

let world: GrantWorld
let n = 0
beforeAll(async () => {
  world = await grantWorld()
})
afterAll(async () => world.close())

describe('entering machines from the phone', () => {
  let temp: { base: string; clean: () => void }
  let username: string
  let browser: Browser
  let machines: Machine[]

  /** A machine of the account: the real door behind the real routes. */
  const machine = async (): Promise<Machine> => {
    const account = fakeAccount({ username })
    const admitted = createAdmittedDeviceStore({ base: `${temp.base}/${account.deviceId}` })
    const verifier = createV2CallTokenVerifier({ keys: v2KeysOverHttp(world.origin) })
    const door = createAccountPairDoor({ account: () => account, grants: (t) => verifier.grant(t), admitted, platform: 'linux' })
    const server = http.createServer((request, response) => {
      void handleAccountPairRoutes(request, response, new URL(request.url ?? '/', 'http://x'), door, null).then((handled) => {
        if (!handled) response.writeHead(404).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const read = async (r: Response) => ({ status: r.status, body: (await r.json().catch(() => null)) as unknown })
    return {
      desktopId: account.deviceId,
      admitted,
      http: {
        get: async (p) => read(await fetch(`${base}${p}`)),
        post: async (p, body) => read(await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
      },
      close: () => new Promise((resolve) => server.close(() => resolve()))
    }
  }

  beforeEach(async () => {
    forgetGrantRests()
    temp = tempBase()
    username = `phone${++n}`
    await world.account(username)
    browser = await world.browser(username)
    machines = [await machine(), await machine()]
  })
  afterEach(async () => {
    for (const m of machines) await m.close()
    temp.clean()
  })

  const deps = (m: Machine, grants: GrantStore, passkey: PairClientDeps['passkey'] = null): PairClientDeps => ({
    machine: m.http,
    registry: browser.registry,
    device: async () => browser.device,
    passkey,
    grants
  })

  it('proves once with the password, then enters BOTH machines with no second proof', async () => {
    const grants = memoryGrants()
    expect((await enterWithGrant(deps(machines[0], grants), machines[0].desktopId)).kind).toBe('needs-proof')
    const options = await grantOptions(browser.registry)
    expect(await proveForGrant(deps(machines[0], grants), PASSWORD, options!)).toEqual({ kind: 'granted' })
    for (const m of machines) {
      const entered = await enterWithGrant(deps(m, grants), m.desktopId)
      expect(entered.kind).toBe('entered')
      if (entered.kind === 'entered') expect(m.admitted.deviceFor(entered.token)).toBe(browser.device.id)
    }
  })

  it('proves with a passkey', async () => {
    const { pair, credentialId } = world.addPasskey(username)
    const grants = memoryGrants()
    const options = await grantOptions(browser.registry)
    const passkey = authenticator(pair, credentialId, world.origin)
    expect(await proveForGrant(deps(machines[0], grants, passkey), null, options!)).toEqual({ kind: 'granted' })
    expect((await enterWithGrant(deps(machines[0], grants), machines[0].desktopId)).kind).toBe('entered')
  })

  it('says how many tries are left after a wrong password, and stores nothing', async () => {
    const grants = memoryGrants()
    const options = await grantOptions(browser.registry)
    expect(await proveForGrant(deps(machines[0], grants), 'not the password at all', options!)).toMatchObject({ kind: 'refused', triesLeft: 2 })
    expect(grants.held).toBeNull()
  })

  it('a pass the machine no longer takes is dropped and asked for again', async () => {
    const grants = memoryGrants()
    await proveForGrant(deps(machines[0], grants), PASSWORD, (await grantOptions(browser.registry))!)
    grants.write({ ...grants.held!, grant: `${grants.held!.grant.slice(0, -4)}AAAA` })
    expect(await enterWithGrant(deps(machines[0], grants), machines[0].desktopId)).toEqual({ kind: 'needs-proof' })
    expect(grants.held).toBeNull()
  })

  it('a device taken off the account cannot enter with its pass', async () => {
    const grants = memoryGrants()
    await proveForGrant(deps(machines[0], grants), PASSWORD, (await grantOptions(browser.registry))!)
    world.v2.accounts.revokeDevice(username, browser.device.id)
    const fresh = await machine()
    machines.push(fresh)
    expect(await enterWithGrant(deps(fresh, grants), fresh.desktopId)).toEqual({ kind: 'needs-proof' })
  })

  it('the password goes only to cookrew.dev: nothing sent to a machine carries it', async () => {
    const grants = memoryGrants()
    const seen: string[] = []
    const spy = (m: Machine): Machine => ({ ...m, http: { get: m.http.get, post: async (p, b) => (seen.push(JSON.stringify(b)), m.http.post(p, b)) } })
    await proveForGrant(deps(spy(machines[0]), grants), PASSWORD, (await grantOptions(browser.registry))!)
    await enterWithGrant(deps(spy(machines[0]), grants), machines[0].desktopId)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.join('\n')).not.toContain(PASSWORD)
  })
})
