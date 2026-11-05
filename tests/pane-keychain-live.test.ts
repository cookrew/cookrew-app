import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ownerSecretPaths, sessionsRootOf } from '../src/main/owner-secrets'
import { macKeychain } from '../src/main/pane-keychain'
import { seatbeltProfile } from '../src/main/session-sandbox'

/**
 * THE REAL KEYCHAIN UNDER THE REAL SEAT RULES, by hand only, since it writes one
 * throwaway item to the login keychain: COOKREW_KEYCHAIN_LIVE=1 npx vitest run …
 * The value is a canary, never a key, and it is gone when this ends.
 */

const LIVE = process.env.COOKREW_KEYCHAIN_LIVE === '1' && process.platform === 'darwin'
const NAME = `lane-canary-${process.pid}`
const CANARY = 'canary-not-a-secret'

describe.skipIf(!LIVE)('a pane key in the login keychain', () => {
  const keychain = macKeychain()
  const { command, args } = keychain.reader(NAME)
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'seat-keychain-'))
    expect(keychain.put(NAME, CANARY)).toBe(true)
  })

  afterAll(() => {
    keychain.remove(NAME)
    rmSync(dir, { recursive: true, force: true })
  })

  it('is read back by the command a harness is given, with the app nowhere near', () => {
    expect(spawnSync(command, [...args], { encoding: 'utf8' }).stdout.trim()).toBe(CANARY)
  })

  it('is out of reach of a served seat, on the profile a seat really gets', () => {
    const base = path.join(homedir(), '.cookrew')
    const profile = path.join(dir, 'seat.sb')
    writeFileSync(profile, seatbeltProfile({ sandbox: dir, siblingRoot: path.join(dir, 'siblings'), sessionsRoot: sessionsRootOf(base), secretPaths: ownerSecretPaths(base) }))
    const seat = spawnSync('sandbox-exec', ['-f', profile, command, ...args], { encoding: 'utf8', timeout: 10_000 })
    expect(seat.stdout).not.toContain(CANARY)
    expect(seat.status).not.toBe(0)
  })

  it('goes when it is removed', () => {
    keychain.remove(NAME)
    expect(spawnSync(command, [...args], { encoding: 'utf8' }).status).not.toBe(0)
    expect(keychain.put(NAME, CANARY)).toBe(true)
  })
})
