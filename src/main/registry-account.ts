import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { buildRegistryAssertion, type RegistryAssertion } from './registry-assertion'

/**
 * THE OWNER'S ACCOUNT AT A REGISTRY.
 *
 * Publishing a door and dialling the relay both have to prove who is asking,
 * and the registry already knows exactly one way to be convinced: the WebAuthn
 * ceremony it uses for everything else. This produces that ceremony from a key
 * the app holds, rather than adding a second kind of credential that could
 * disagree with the first.
 *
 * IT IS A KEY ON THIS MACHINE, and that is the honest description. A hardware
 * authenticator proves a person was present; this proves the app was running.
 * For "this laptop is serving that team" the second is the true claim — the
 * door is the machine — and pretending otherwise by demanding a touch would
 * make an unattended door impossible to keep online.
 *
 * ONE ACCOUNT PER REGISTRY, filed by origin. A key that followed the owner
 * between a local registry and cookrew.dev would make a test deployment able
 * to speak for the real one.
 *
 * SUPERSEDED BY account.ts. The account is now the USERNAME, minted once and
 * held in `~/.cookrew/account.json` with every other surface bound to it as a
 * device. This file remains for the doors and relay tickets a machine
 * registered under the old per-registry credential — the key is the same
 * algorithm and the ceremony is the same bytes (registry-assertion.ts), so an
 * existing registration keeps working while it is migrated rather than being
 * orphaned by the rename.
 */

export interface RegistryAccount {
  /** The handle this account holds at that registry. */
  handle: string
  /** A ceremony for one challenge, in the shape the registry verifies. */
  assert(challenge: string): RegistryAssertion
  /** Enrolment, for a registry that has not met this key. */
  enrolment(): { credentialId: string; publicKeyJwk: Record<string, unknown> }
}

export type { RegistryAssertion }

interface Stored {
  handle: string
  privateKeyJwk: Record<string, unknown>
  publicKeyJwk: Record<string, unknown>
}

/** Where accounts live. Beside the other secrets the app keeps, and as private. */
function accountFile(origin: string): string {
  const host = new URL(origin).host.replace(/[^a-z0-9.-]/gi, '_')
  return path.join(homedir(), '.cookrew', 'registry', `${host}.json`)
}

/**
 * Load or create the account for a registry.
 *
 * `handle` is only used when creating one — an existing account keeps the
 * handle it was enrolled under, because that handle is what the registry has
 * bound its doors to and changing it locally would silently orphan them.
 */
export function registryAccount(origin: string, handle: string): RegistryAccount {
  const file = accountFile(origin)
  const stored = load(file) ?? create(file, handle)
  const exact = new URL(origin).origin

  return {
    handle: stored.handle,
    enrolment: () => ({ credentialId: stored.handle, publicKeyJwk: stored.publicKeyJwk }),
    assert: (challenge) =>
      buildRegistryAssertion({
        origin: exact,
        credentialId: stored.handle,
        privateKeyJwk: stored.privateKeyJwk,
        challenge
      })
  }
}

function load(file: string): Stored | null {
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Stored
    return typeof parsed.handle === 'string' && parsed.privateKeyJwk ? parsed : null
  } catch {
    // A corrupt account file is not something to repair silently — but it is
    // also not worth refusing to start over. A new key can be enrolled; the
    // doors bound to the old one will simply need re-registering.
    return null
  }
}

function create(file: string, handle: string): Stored {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const stored: Stored = {
    handle,
    privateKeyJwk: privateKey.export({ format: 'jwk' }) as Record<string, unknown>,
    publicKeyJwk: publicKey.export({ format: 'jwk' }) as Record<string, unknown>
  }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 })
  // Set explicitly as well as at creation: an existing file keeps its old mode.
  chmodSync(file, 0o600)
  return stored
}
