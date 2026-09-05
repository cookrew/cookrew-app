import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deviceIdFor, mintDeviceKey, unlockVerifierFor, type AccountFile } from '../../src/main/account-v2'

/** A temp ~/.cookrew for a test, removed by the returned cleanup. */
export const tempBase = (): { base: string; clean: () => void } => {
  const base = mkdtempSync(path.join(tmpdir(), 'cookrew-idv2-'))
  return { base, clean: () => rmSync(base, { recursive: true, force: true }) }
}

/** A whole account file, with a real Ed25519 key so signatures are real. */
export const fakeAccount = (over: Partial<AccountFile> = {}): AccountFile => {
  const keys = mintDeviceKey()
  return {
    username: 'drej',
    deviceId: deviceIdFor(keys.publicKeyJwk),
    kind: 'desktop',
    name: 'MacBook Pro',
    privateKeyJwk: keys.privateKeyJwk,
    publicKeyJwk: keys.publicKeyJwk,
    registry: 'https://cookrew.dev',
    session: { token: 'session-token', exp: Date.now() + 3_600_000 },
    unlock: unlockVerifierFor('correct horse battery staple'),
    lockAfterMs: 900_000,
    claimedAt: 1_700_000_000_000,
    workspacesReachable: true,
    recoveryCodesSavedAt: null,
    ...over
  }
}
