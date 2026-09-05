import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { IdentityService } from '../registry/src/identity'
import { DoorStore } from '../registry/src/doors'
import { StarStore } from '../registry/src/stars'
import { createV2 } from '../registry/src/v2-routes'
import { Accounts, accountFilePath, loadAccount } from '../src/main/account-v2'

/**
 * IDENTITY v2, PHASE 1, END TO END.
 *
 * The registry half and the app half were built in parallel to one written
 * contract. This is the receipt: a REAL registry listens on a port, and the
 * app's own account module talks to it over HTTP — claim a username with a
 * password, unlock offline, read the profile, register this Mac's
 * workspaces, mint recovery codes, revoke a device, change the password,
 * resume a session. No stubs on either side.
 */

const PASSWORD = 'correct horse battery staple'
const USERNAME = 'drej'

let dir = ''
let home = ''
let origin = ''
let server: Server

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'idv2-e2e-registry-'))
  home = mkdtempSync(path.join(tmpdir(), 'idv2-e2e-home-'))
  server = createRegistry({
    store: new RegistryStore(dir),
    log: new TransparencyLog(dir),
    identity: new IdentityService(dir),
    doors: new DoorStore(dir, { allowPrivate: true }),
    stars: new StarStore(dir),
    v2: createV2(dir)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

const accounts = (): Accounts => new Accounts({ base: home, origin, deviceName: 'MacBook Pro' })

describe('phase 1 — claim, unlock, profile, devices', () => {
  it('a free name is claimed once, written privately, and taken from then on', async () => {
    const app = accounts()
    expect(await app.checkUsername(USERNAME)).toBe('free')
    const claimed = await app.claim({ username: USERNAME, password: PASSWORD })
    expect(claimed.ok).toBe(true)
    const file = accountFilePath(home)
    expect(existsSync(file)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const stored = loadAccount(home)
    expect(stored?.username).toBe(USERNAME)
    expect(stored?.kind).toBe('desktop')
    // The password never lands on disk in the clear.
    expect(readFileSync(file, 'utf8')).not.toContain(PASSWORD)
    expect(await app.checkUsername(USERNAME)).toBe('taken')
    const again = await accounts().claim({ username: USERNAME, password: PASSWORD })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.reason).toBe('taken')
  })

  it('refuses a weak password and a bad username before the registry is asked', async () => {
    const app = accounts()
    const weak = await app.claim({ username: USERNAME, password: 'short' })
    expect(weak.ok).toBe(false)
    if (!weak.ok) expect(weak.reason).toBe('weak_password')
    const bad = await app.claim({ username: 'Drej Smith', password: PASSWORD })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.reason).toBe('bad_username')
    expect(await app.checkUsername('acct-drej')).toBe('reserved')
    expect(existsSync(accountFilePath(home))).toBe(false)
  })

  it('unlocks offline with the password and refuses the wrong one', async () => {
    const app = accounts()
    await app.claim({ username: USERNAME, password: PASSWORD })
    // The registry is gone; unlocking still works from the local verifier.
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    server = createRegistry({
      store: new RegistryStore(dir),
      log: new TransparencyLog(dir),
      identity: new IdentityService(dir),
      doors: new DoorStore(dir, { allowPrivate: true }),
      stars: new StarStore(dir),
      v2: createV2(dir)
    })
    expect(app.verifyUnlock(PASSWORD)).toBe(true)
    expect(app.verifyUnlock('not it')).toBe(false)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  })

  it('reads the profile, registers this Mac, mints recovery codes, revokes a device', async () => {
    const app = accounts()
    await app.claim({ username: USERNAME, password: PASSWORD, name: 'MacBook Pro' })
    const profile = await app.profile()
    expect(profile.ok).toBe(true)
    if (profile.ok) {
      expect(profile.value.username).toBe(USERNAME)
      expect(profile.value.devices.map((d) => [d.kind, d.name, d.current])).toEqual([
        ['desktop', 'MacBook Pro', true]
      ])
    }
    expect(app.setWorkspacesReachable(true)).toBe(true)
    const registered = await app.registerDesktop([
      { id: 'ws-1', name: 'Cookrew Dev' },
      { id: 'ws-2', name: 'Playground' }
    ])
    expect(registered.ok).toBe(true)
    const after = await app.profile()
    if (after.ok) {
      expect(after.value.desktops.map((d) => d.workspaces.map((w) => w.name))).toEqual([
        ['Cookrew Dev', 'Playground']
      ])
    }
    const codes = await app.recoveryCodes()
    expect(codes.ok).toBe(true)
    if (codes.ok) {
      expect(codes.value).toHaveLength(8)
      for (const code of codes.value) expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    }
    // The only device cannot be revoked; the sentence says so.
    const devices = await app.devices()
    expect(devices.ok).toBe(true)
    if (devices.ok) {
      const only = devices.value[0]
      const refused = await app.revokeDevice(only.id)
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.reason).toBe('last_device')
    }
  })

  it('a second desktop with the same name and password joins as a second device', async () => {
    const first = accounts()
    await first.claim({ username: USERNAME, password: PASSWORD, name: 'MacBook Pro' })
    const otherHome = mkdtempSync(path.join(tmpdir(), 'idv2-e2e-home2-'))
    const second = new Accounts({ base: otherHome, origin, deviceName: 'Mac mini' })
    const resumed = await second.resume(PASSWORD)
    // Phase 1: a second device signs in with the password alone (the ladder is phase 4).
    // resume() on a machine with no account file cannot know the username; claim() refuses
    // 'taken'. So the second device signs in through the wire the way the sheet will:
    expect(resumed.ok).toBe(false)
    const signIn = await fetch(`${origin}/v2/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: USERNAME,
        password: PASSWORD,
        device: {
          id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
          kind: 'desktop',
          name: 'Mac mini',
          jwk: { kty: 'OKP', crv: 'Ed25519', x: 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyYWE' }
        }
      })
    })
    expect(signIn.status).toBe(201)
    const devices = await first.devices()
    expect(devices.ok).toBe(true)
    if (devices.ok) expect(devices.value.map((d) => d.name).sort()).toEqual(['Mac mini', 'MacBook Pro'])
    // And the first Mac can revoke it, since it is no longer the last device.
    if (devices.ok) {
      const mini = devices.value.find((d) => d.name === 'Mac mini')
      const revoked = await first.revokeDevice(mini!.id)
      expect(revoked.ok).toBe(true)
    }
    rmSync(otherHome, { recursive: true, force: true })
  })

  it('changes the password and resumes a session with the new one', async () => {
    const app = accounts()
    await app.claim({ username: USERNAME, password: PASSWORD })
    const changed = await app.setPassword({ current: PASSWORD, next: 'a much longer new password' })
    expect(changed.ok).toBe(true)
    expect(app.verifyUnlock('a much longer new password')).toBe(true)
    const wrong = await app.resume(PASSWORD)
    expect(wrong.ok).toBe(false)
    const right = await app.resume('a much longer new password')
    expect(right.ok).toBe(true)
    expect(app.sessionLive()).toBe(true)
  })
})
