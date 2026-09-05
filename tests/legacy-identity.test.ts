import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, type AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService, identityConfigFor } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import { registryAccount, existingRegistryAccount } from '../src/main/registry-account'
import { legacyIdentity, relayHandle } from '../src/main/legacy-identity'
import { Accounts, accountFilePath, deviceIdFor, loadAccount } from '../src/main/account-v2'

/**
 * PHASE 6 ON THE APP SIDE — the key this Mac already has, and the name it
 * serves under.
 *
 * Two things are proved here. THE DOOR NEVER GOES DOWN: `relayHandle` is a
 * pure function and every state a real machine can be in is a row in its
 * table, including today's (no account, a legacy key, COOKREW_HANDLE set),
 * which must keep answering exactly what it answers now. And THE CROSSING IS
 * REAL: the app signs the v1 ceremony with the key on disk, the registry
 * takes it, and account.json is written only when it did.
 */

const PASSWORD = 'correct horse battery staple'
const HANDLE = 'drej'

let home = ''

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'idv2-p6-home-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('which name this Mac serves under', () => {
  const table: readonly {
    what: string
    input: { account: string | null; legacy: string | null; env: string | null }
    handle: string
    source: string
    note: boolean
  }[] = [
    {
      what: 'today: no account, a legacy key, and the environment — serves as it does now',
      input: { account: null, legacy: HANDLE, env: HANDLE },
      handle: HANDLE,
      source: 'legacy',
      note: false
    },
    {
      what: 'a claimed account, and nothing else — the account',
      input: { account: 'mira', legacy: null, env: null },
      handle: 'mira',
      source: 'account',
      note: false
    },
    {
      what: 'a claimed account and the env that used to decide — the account, and it says so',
      input: { account: 'mira', legacy: null, env: 'someone-else' },
      handle: 'mira',
      source: 'account',
      note: true
    },
    {
      what: 'a migrated Mac: the account and the key agree',
      input: { account: HANDLE, legacy: HANDLE, env: HANDLE },
      handle: HANDLE,
      source: 'account',
      note: false
    },
    {
      what: 'an account the old key cannot prove — the doors keep the key’s name',
      input: { account: 'mira', legacy: HANDLE, env: null },
      handle: HANDLE,
      source: 'legacy',
      note: true
    },
    {
      what: 'a fresh dev machine with the override — the override, once',
      input: { account: null, legacy: null, env: 'dev-box' },
      handle: 'dev-box',
      source: 'env',
      note: true
    },
    {
      what: 'nothing at all — no name, and nothing to serve',
      input: { account: null, legacy: null, env: null },
      handle: '',
      source: 'none',
      note: false
    }
  ]

  for (const row of table) {
    it(row.what, () => {
      const out = relayHandle(row.input)
      expect(out.handle).toBe(row.handle)
      expect(out.source).toBe(row.source)
      expect(out.note === null).toBe(!row.note)
    })
  }

  it('says the override is a development one, in those words', () => {
    const out = relayHandle({ account: null, legacy: null, env: 'dev-box' })
    expect(out.note).toBe('COOKREW_HANDLE is a development override; claim a username instead.')
  })

  it('names both when the account and the environment disagree, and the account wins', () => {
    const out = relayHandle({ account: 'mira', legacy: null, env: 'drej' })
    expect(out.handle).toBe('mira')
    expect(out.note).toContain('@mira')
    expect(out.note).toContain('@drej')
  })

  it('is not fooled by an @ or by shouting', () => {
    expect(relayHandle({ account: null, legacy: null, env: '@Dev-Box ' }).handle).toBe('dev-box')
  })
})

describe('the key this Mac already holds', () => {
  const ORIGIN = 'https://cookrew.dev'

  it('is nothing on a machine that never served', () => {
    expect(existingRegistryAccount(ORIGIN, home)).toBe(null)
    expect(legacyIdentity({ account: null, origin: ORIGIN, base: home })).toBe(null)
  })

  it('is the handle in ~/.cookrew/registry/<host>.json, and never creates one', () => {
    registryAccount(ORIGIN, HANDLE, home)
    expect(existsSync(path.join(home, 'registry', 'cookrew.dev.json'))).toBe(true)
    expect(existingRegistryAccount(ORIGIN, home)?.handle).toBe(HANDLE)
    expect(legacyIdentity({ account: null, origin: ORIGIN, base: home })).toEqual({ handle: HANDLE })
  })

  it('is filed per registry, so a test deployment cannot speak for the real one', () => {
    registryAccount(ORIGIN, HANDLE, home)
    expect(existingRegistryAccount('http://localhost:8790', home)).toBe(null)
  })

  it('is silent once there is an account — the sheet has nothing to offer', () => {
    registryAccount(ORIGIN, HANDLE, home)
    expect(legacyIdentity({ account: HANDLE, origin: ORIGIN, base: home })).toBe(null)
  })
})

/** A registry that has never heard of /v2 — every one of its routes is a 404. */
const oldRegistry = async (input: string): Promise<Response> =>
  input.includes('/v2/')
    ? new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      })
    : new Response(JSON.stringify({ challenge: 'nonce' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })

describe('the new app against a registry that has no passwords yet', () => {
  it('says so, changes nothing, and leaves the Mac serving under its old name', async () => {
    const origin = 'https://cookrew.dev'
    registryAccount(origin, HANDLE, home)
    const app = new Accounts({ base: home, origin, fetch: oldRegistry })
    const out = await app.migrate({ password: PASSWORD })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('no_passwords_yet')
    expect(existsSync(accountFilePath(home))).toBe(false)
    expect(app.account()).toBe(null)
    // The door is unmoved: the legacy key still names the handle it serves.
    expect(relayHandle({ account: null, legacy: HANDLE, env: HANDLE }).handle).toBe(HANDLE)
  })

  it('does not crash when the registry answers nothing at all', async () => {
    const origin = 'https://cookrew.dev'
    registryAccount(origin, HANDLE, home)
    const app = new Accounts({
      base: home,
      origin,
      fetch: () => Promise.reject(new Error('ENOTFOUND'))
    })
    const out = await app.migrate({ password: PASSWORD })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('offline')
  })

  it('refuses a password under the floor before it opens a socket', async () => {
    const origin = 'https://cookrew.dev'
    registryAccount(origin, HANDLE, home)
    let asked = 0
    const app = new Accounts({
      base: home,
      origin,
      fetch: (input) => {
        asked += 1
        return oldRegistry(input)
      }
    })
    const out = await app.migrate({ password: 'short' })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('weak_password')
    expect(asked).toBe(0)
  })

  it('has nothing to migrate on a Mac with no legacy key', async () => {
    const app = new Accounts({ base: home, origin: 'https://cookrew.dev', fetch: oldRegistry })
    const out = await app.migrate({ password: PASSWORD })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('no_account')
  })
})

/**
 * A PORT BEFORE THE SERVER. WebAuthn compares the assertion's origin against
 * a CONFIGURED string, so the registry has to be told which address it will
 * be reached at before it starts listening at it — the same knot
 * `identityConfigFor` exists to untie in production.
 */
const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })

describe('the crossing, against a real registry', () => {
  let dir = ''
  let origin = ''
  let identity: IdentityService
  let server: Server

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'idv2-p6-registry-'))
    const port = await freePort()
    const config = identityConfigFor({ port })
    if (!config.ok) throw new Error(config.reason)
    identity = new IdentityService(dir, config.config)
    server = createRegistry({
      store: new RegistryStore(dir),
      log: new TransparencyLog(dir),
      identity,
      doors: new DoorStore(dir, { allowPrivate: true }),
      stars: new StarStore(dir),
      v2: createV2(dir)
    })
    await new Promise<void>((resolve) => server.listen(port, resolve))
    origin = `http://localhost:${port}`
  })
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    rmSync(dir, { recursive: true, force: true })
  })

  /** Enrol this Mac's key the way serving a door already enrols it. */
  async function enrol(): Promise<void> {
    const account = registryAccount(origin, HANDLE, home)
    const { credentialId, publicKeyJwk } = account.enrolment()
    const answer = await fetch(`${origin}/v1/identity/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentialId, publicKeyJwk })
    })
    expect(answer.status).toBe(201)
  }

  it('turns the handle into an account, and writes the file only then', async () => {
    await enrol()
    const app = new Accounts({ base: home, origin, deviceName: 'MacBook Pro' })
    expect(app.account()).toBe(null)

    const out = await app.migrate({ password: PASSWORD })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.username).toBe(HANDLE)
    const file = accountFilePath(home)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const stored = loadAccount(home)
    expect(stored?.username).toBe(HANDLE)
    expect(stored?.deviceId).toBe(deviceIdFor(stored?.publicKeyJwk ?? {}))
    expect(stored?.registry).toBe(origin)
    // The password unlocks this Mac offline, exactly as a claim's does.
    expect(app.verifyUnlock(PASSWORD)).toBe(true)
    expect(app.verifyUnlock('something else')).toBe(false)
    expect(app.sessionLive()).toBe(true)
    // And it never reached the disk.
    expect(readFileSync(file, 'utf8').includes(PASSWORD)).toBe(false)
  })

  it('leaves the old key on the account as a device, beside this Mac', async () => {
    await enrol()
    const app = new Accounts({ base: home, origin, deviceName: 'MacBook Pro' })
    expect((await app.migrate({ password: PASSWORD })).ok).toBe(true)
    const profile = await app.profile()
    expect(profile.ok).toBe(true)
    if (!profile.ok) return
    expect(profile.value.devices.map((d) => d.kind).sort()).toEqual(['desktop', 'legacy'])
    expect(profile.value.devices.find((d) => d.current)?.kind).toBe('desktop')
  })

  it('is refused when the key on this Mac is not the one that holds the name', async () => {
    // Somebody else's key enrolled the handle; ours has never been seen.
    identity.register(
      HANDLE,
      generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, unknown>
    )
    registryAccount(origin, HANDLE, home)
    const app = new Accounts({ base: home, origin })
    const out = await app.migrate({ password: PASSWORD })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toBe('bad_credentials')
    expect(existsSync(accountFilePath(home))).toBe(false)
  })

  it('refuses to migrate a Mac that already has an account', async () => {
    await enrol()
    const app = new Accounts({ base: home, origin })
    expect((await app.migrate({ password: PASSWORD })).ok).toBe(true)
    const again = await app.migrate({ password: PASSWORD })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.message).toContain(`@${HANDLE}`)
  })

  it('holds the name against a stranger while it is still unclaimed', async () => {
    await enrol()
    const stranger = new Accounts({
      base: mkdtempSync(path.join(tmpdir(), 'idv2-p6-stranger-')),
      origin
    })
    expect(await stranger.checkUsername(HANDLE)).toBe('taken')
    const refused = await stranger.claim({ username: HANDLE, password: PASSWORD })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.message).toContain('from before passwords')
  })
})
