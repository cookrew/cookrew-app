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
  SEALED_ONLY_COPY,
  sealedRetrying,
  type GrantStore,
  type SealedWay,
  type Http,
  type PairClientDeps
} from '../src/renderer/src/account-pair-client'
import { PAIR_PATHS, type DeviceGrant } from '../src/shared/account-pair'
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

  /** The machine's door, with its relay line refusing one path in the clear as a sealed-only Mac does (main/mobile-server.ts). */
  const sealedOnlyAt = (m: Machine, refused: string, body: Record<string, unknown> = { error: 'sealed-only' }): Machine => ({
    ...m,
    http: { get: m.http.get, post: async (p, b) => (p === refused ? { status: 403, body } : m.http.post(p, b)) }
  })

  const proven = async (): Promise<ReturnType<typeof memoryGrants>> => {
    const grants = memoryGrants()
    await proveForGrant(deps(machines[0], grants), PASSWORD, (await grantOptions(browser.registry))!)
    return grants
  }

  // `failed`, not `refused`: the sentence is this page's own (it knows why), not words the machine said.
  it.each<[string, Record<string, unknown>, () => string, boolean]>([
    ['with no code held, says to pair once', { error: 'sealed-only', seal: 'no-code' }, () => SEALED_ONLY_COPY.noCode, true],
    ['with a code held but no session opened, says only to try again', { error: 'sealed-only', seal: 'unopened' }, () => SEALED_ONLY_COPY.unopened, false],
    ['when the machine PROVED it replaced the held code, says to scan its new one', { error: 'sealed-only', seal: 'code-replaced' }, () => SEALED_ONLY_COPY.codeReplaced, true],
    ['when the held code was refused with no proof, asserts nothing and changes nothing', { error: 'sealed-only', seal: 'code-unverified' }, () => SEALED_ONLY_COPY.codeUnverified, false],
    ['when the page cannot tell why, says both', { error: 'sealed-only' }, () => SEALED_ONLY_COPY.unknown, true]
  ])('a machine that takes only sealed connections, %s; the page\'s own sentence, never "did not start an entry", and the pass is kept', async (_name, body, sentenceOf, pairs) => {
    const sentence = sentenceOf()
    const grants = await proven()
    const held = grants.held
    const entered = await enterWithGrant(deps(sealedOnlyAt(machines[0], PAIR_PATHS.begin, body), grants), machines[0].desktopId)
    expect(entered).toEqual({ kind: 'failed', message: sentence })
    expect(sentence).toMatch(/only sealed|sealed/)
    expect(/[Pp]air/.test(sentence)).toBe(pairs)
    expect(sentence).not.toMatch(/did not start an entry/)
    expect(grants.held).toEqual(held)
  })

  it('the five sentences are five: what the page knows is what it says, and none asks to sign out or forget', () => {
    expect(new Set(Object.values(SEALED_ONLY_COPY)).size).toBe(5)
    for (const sentence of Object.values(SEALED_ONLY_COPY)) expect(sentence).not.toMatch(/[Ss]ign out|[Ff]orget|unpin/)
    // Proven: the Mac's own word, checked against the held code (seal-client.ts · checkReplaced). Scanning its new code
    // ends it: the next refusal vouches for exactly that code (seal-next-code.ts).
    expect(SEALED_ONLY_COPY.codeReplaced).toMatch(/proved/)
    expect(SEALED_ONLY_COPY.codeReplaced).toMatch(/[Ss]can/)
    // Not proven: anybody on the line could have said it. Nothing is asserted about the machine, nothing was changed.
    expect(SEALED_ONLY_COPY.codeUnverified).toMatch(/no proof/)
    expect(SEALED_ONLY_COPY.codeUnverified).toMatch(/changed nothing/)
    expect(SEALED_ONLY_COPY.codeUnverified).not.toMatch(/no longer knows|has changed|new code/)
    // Not "try again later": waiting does not end an unproven refusal, and saying so would be a promise.
    expect(SEALED_ONLY_COPY.codeUnverified).not.toMatch(/[Tt]ry again|later|in a moment/)
    expect(SEALED_ONLY_COPY.codeUnverified).toMatch(/cannot replace/)
    expect(SEALED_ONLY_COPY.noCode).toMatch(/none with it yet/)
    expect(SEALED_ONLY_COPY.noCode).toMatch(/Pair a phone/)
    // A session that did not open just now is passing: this browser is paired, and re-pairing is not the remedy.
    expect(SEALED_ONLY_COPY.unopened).toMatch(/could not be opened just now/)
    expect(SEALED_ONLY_COPY.unopened).toMatch(/[Tt]ry again/)
    expect(SEALED_ONLY_COPY.unopened).not.toMatch(/[Pp]air/)
  })

  it('refused in the clear at the finish: the same sentence, and the pass is kept', async () => {
    const grants = await proven()
    const refusedAtFinish = sealedOnlyAt(machines[0], PAIR_PATHS.finish, { error: 'sealed-only', seal: 'no-code' })
    expect(await enterWithGrant(deps(refusedAtFinish, grants), machines[0].desktopId)).toEqual({ kind: 'failed', message: SEALED_ONLY_COPY.noCode })
    expect(grants.held).not.toBeNull()
  })

  it('any other refusal is still the machine\'s own', async () => {
    const grants = await proven()
    const other = sealedOnlyAt(machines[0], PAIR_PATHS.begin, { error: 'This machine is busy right now.' })
    expect(await enterWithGrant(deps(other, grants), machines[0].desktopId)).toEqual({ kind: 'refused', message: 'This machine is busy right now.' })
  })
})

describe('a plain request the machine refused because it takes this device only sealed', () => {
  const answer = (status: number, body: unknown): Response =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const plain = (reply: () => Response) => {
    const sent: Array<{ input: string; init: RequestInit }> = []
    return { sent, send: async (input: string, init: RequestInit) => (sent.push({ input, init }), reply()) }
  }
  const URL_ = 'https://api.cookrew.dev/api/m/mac-1/api/pair/begin'
  const INIT: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"grant":"g"}' }
  const refused = (): Response => answer(403, { error: 'sealed-only' })
  /** A machine scope that stays put unless a case moves it (machine-scope.ts · heldScope). */
  const scopeOf = () => {
    let epoch = 0
    return {
      move: () => void (epoch += 1),
      held: () => {
        const at = epoch
        return () => epoch === at
      }
    }
  }
  /** The sealed plane, stood in for: loaded at once, refusing no code, with nothing to go on unless a case says so. */
  const way = (parts: Partial<SealedWay> = {}): Partial<SealedWay> => ({
    ready: async () => undefined,
    askNow: async () => undefined,
    planeRefusal: async () => null,
    again: async () => 'no-code',
    ...parts
  })

  it('goes again on the sealed session, once, as it was asked', async () => {
    const wire = plain(refused)
    const asked: Array<{ input: string; init: RequestInit }> = []
    const send = sealedRetrying(wire.send, way({ again: async (input, init) => (asked.push({ input, init }), answer(200, { sealed: true })) }))
    const got = await send(URL_, INIT)
    expect(got.status).toBe(200)
    expect(await got.json()).toEqual({ sealed: true })
    expect(wire.sent).toHaveLength(1)
    expect(asked).toEqual([{ input: URL_, init: INIT }])
  })

  it('the sealed plane is ready before the first request leaves, so a machine pinned sealed is never asked plain', async () => {
    const order: string[] = []
    const wire = plain(() => (order.push('sent'), answer(200, {})))
    const ready = async (): Promise<void> => void order.push('ready')
    await sealedRetrying(wire.send, way({ ready }))(URL_, INIT)
    expect(order).toEqual(['ready', 'sent'])
  })

  it('a door a person asked for cuts the wait short before its first request; any other never does', async () => {
    const order: string[] = []
    const wire = plain(() => (order.push('sent'), answer(200, {})))
    const parts = way({ ready: async () => void order.push('ready'), askNow: async (input) => void order.push(`ask-now ${input}`) })
    await sealedRetrying(wire.send, { ...parts, explicit: true })(URL_, INIT)
    expect(order).toEqual(['ready', `ask-now ${URL_}`, 'sent'])
    order.length = 0
    await sealedRetrying(wire.send, parts)(URL_, INIT)
    expect(order).toEqual(['ready', 'sent'])
  })

  it('a sealed plane that cannot load sends nothing: a failure, never a plain request', async () => {
    const wire = plain(() => answer(200, {}))
    const ready = async (): Promise<void> => {
      throw new Error('the chunk did not load')
    }
    await expect(sealedRetrying(wire.send, way({ ready }))(URL_, INIT)).rejects.toThrow('did not load')
    expect(wire.sent).toHaveLength(0)
  })

  it('the page left the machine while the sealed plane loaded: an abort, and nothing is sent', async () => {
    const scope = scopeOf()
    const wire = plain(() => answer(200, {}))
    await expect(sealedRetrying(wire.send, way({ held: scope.held, ready: async () => scope.move() }))(URL_, INIT)).rejects.toMatchObject({ name: 'AbortError' })
    expect(wire.sent).toHaveLength(0)
  })

  it.each(['no-code', 'unopened', 'code-replaced', 'code-unverified'] as const)('with no sealed session to go on (%s), the refusal stands and says why; nothing is sent plain again', async (why) => {
    const wire = plain(refused)
    const got = await sealedRetrying(wire.send, way({ again: async () => why }))(URL_, INIT)
    expect(got.status).toBe(403)
    expect(await got.json()).toEqual({ error: 'sealed-only', seal: why })
    expect(wire.sent).toHaveLength(1)
  })

  it('a sealed try that fails is said as a session that could not open, never a plain resend', async () => {
    const wire = plain(refused)
    const send = sealedRetrying(
      wire.send,
      way({
        again: async () => {
          throw new Error('This machine did not answer on the sealed session.')
        }
      })
    )
    const got = await send(URL_, INIT)
    expect(got.status).toBe(403)
    expect(await got.json()).toEqual({ error: 'sealed-only', seal: 'unopened' })
    expect(wire.sent).toHaveLength(1)
  })

  it('the page left the machine before the refusal came back: an abort, and no sealed session is asked', async () => {
    const scope = scopeOf()
    const wire = plain(() => (scope.move(), refused()))
    let asked = 0
    const send = sealedRetrying(wire.send, way({ again: async () => ((asked += 1), answer(200, {})), held: scope.held }))
    await expect(send(URL_, INIT)).rejects.toMatchObject({ name: 'AbortError' })
    expect(asked).toBe(0)
    expect(wire.sent).toHaveLength(1)
  })

  it("the page left the machine while the sealed try was under way: its answer is nobody's, an abort", async () => {
    const scope = scopeOf()
    const send = sealedRetrying(plain(refused).send, way({ again: async () => (scope.move(), answer(200, { token: 'for the machine that was left' })), held: scope.held }))
    await expect(send(URL_, INIT)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('a sealed try that fails after the page left is an abort, not a sentence for the next machine', async () => {
    const scope = scopeOf()
    const send = sealedRetrying(
      plain(refused).send,
      way({
        again: async () => {
          scope.move()
          throw new Error('the machine was left')
        },
        held: scope.held
      })
    )
    await expect(send(URL_, INIT)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('the sealed try is handed the scope it was asked in, so it can stop before it sends', async () => {
    const scope = scopeOf()
    let told: (() => boolean) | null = null
    await sealedRetrying(plain(refused).send, way({ again: async (_input, _init, sameMachine) => ((told = sameMachine), 'unopened' as const), held: scope.held }))(URL_, INIT)
    expect(told!()).toBe(true)
    scope.move()
    expect(told!()).toBe(false)
  })

  it.each([
    ['another 403', 403, { error: 'forbidden' }],
    ['a 403 that is not JSON', 403, 'nope'],
    ['a 401', 401, { error: 'sealed-only' }],
    ['a 200', 200, { challengeId: 'c' }]
  ])('%s is left as it is, and no sealed session is asked', async (_name, status, body) => {
    const wire = plain(() => answer(status, body))
    let asked = 0
    const got = await sealedRetrying(wire.send, way({ again: async () => ((asked += 1), 'no-code' as const) }))(URL_, INIT)
    expect(got.status).toBe(status)
    expect(asked).toBe(0)
    expect(wire.sent).toHaveLength(1)
  })

  it.each([
    ['replaced', 'code-replaced'],
    ['unverified', 'code-unverified']
  ] as const)("the sealed plane's OWN re-pair answer (%s), known by identity, is said in the page's words", async (refusal, why) => {
    const own = answer(401, { error: 'This machine no longer knows the connect code held here. Scan its code again.' })
    const wire = plain(() => own)
    let asked = 0
    const send = sealedRetrying(wire.send, way({ planeRefusal: async (response) => (response === own ? refusal : null), again: async () => ((asked += 1), 'no-code' as const) }))
    const got = await send(URL_, INIT)
    expect(got.status).toBe(403)
    expect(await got.json()).toEqual({ error: 'sealed-only', seal: why })
    expect(asked).toBe(0)
    expect(wire.sent).toHaveLength(1)
  })

  it("the Mac's own 401 (a regrant) is never taken for the plane's, whatever it says and whatever the plane knows of the code", async () => {
    // Same status, same words as the plane's re-pair answer: only identity tells them apart.
    const mac = answer(401, { error: 'This machine no longer knows the connect code held here. Scan its code again.', outcome: 'regrant' })
    const got = await sealedRetrying(plain(() => mac).send, way({ planeRefusal: async () => null }))(URL_, INIT)
    expect(got).toBe(mac)
    expect(await got.json()).toMatchObject({ outcome: 'regrant' })
  })
})
