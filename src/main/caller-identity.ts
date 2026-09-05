import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import { callAssertionPayload } from './call-ceremony'
import { HANDLE_SHAPE, loadAccount } from './account'

/**
 * THE CALLER'S ACCOUNT AT SOMEONE ELSE'S DOOR.
 *
 * A served door signs a caller in by TOFU: the first sign-in presents an
 * ed25519 public key and IS the sign-up; every later one proves the same key.
 * The placed orch card does this for itself (resources/orch-line.mjs), but the
 * APP needs the same identity before the card exists — the gate sheet has to
 * ask a door what it wants, and be told as the account that will hold the
 * session.
 *
 * So this reads the SAME key file the card uses, under the same account name.
 * Two processes, one account: the session the sheet pays for is the session
 * the card then opens.
 */

const keyDir = (): string => path.join(homedir(), '.cookrew', 'caller-keys')

/**
 * Where a door's account key lives — filed by the DOOR'S IDENTITY.
 *
 * It used to be filed by network address, and that was a real lockout: the
 * account is bound at the door to (serviceId, sub), so reaching the same team
 * by loopback, by its LAN address, or later by a domain minted a DIFFERENT key
 * for the same account name — and TOFU exists precisely to refuse a second key
 * for a known name. The first address you ever used owned your account and
 * every other one was refused forever. The serviceId is the thing that does
 * not move, so it is the thing the file is named for.
 */
export function callerKeyFile(serviceId: string): string {
  const safe = serviceId.replace(/[^a-z0-9._-]/gi, '_').slice(0, 96) || 'unknown-service'
  return path.join(keyDir(), `${safe}.json`)
}

/**
 * Keys this device may already hold for a door, newest scheme first.
 *
 * The address-named files are the retired scheme (and `crew-keys/` the one
 * before that). They are still offered because an account enrolled under one
 * of them is a real account with real sessions — dropping them would strand
 * people behind a naming change they never made.
 */
export function callerKeyCandidates(origin: string, slug: string, serviceId: string): string[] {
  const host = new URL(origin).host.replace(/[^a-z0-9.-]/gi, '_')
  return [
    callerKeyFile(serviceId),
    path.join(keyDir(), `${host}-${slug}.json`),
    path.join(homedir(), '.cookrew', 'crew-keys', `${host}-${slug}.json`)
  ]
}

/**
 * The account name, in the one shape a door accepts.
 *
 * A door refuses any sub that would change under its path-segment
 * normalisation — two names that collapse to one segment would share a
 * sandbox. A raw system username like `Drej.Smith` is therefore rejected
 * outright, so it is normalised here rather than failing at the door.
 * MUST match safeSub() in resources/orch-line.mjs: the card and the app have
 * to arrive as the same account.
 */
export function callerSub(raw?: string): string {
  const cleaned = String(raw ?? userInfo().username ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 32)
    .replace(/[^a-z0-9]+$/, '')
  return cleaned.length > 0 ? cleaned : 'caller'
}

export interface CallerKey {
  priv: ReturnType<typeof createPrivateKey>
  jwk: Record<string, unknown>
}

/** Read one key file, or null when it is absent or unusable. Throws only on
 *  a file this user should not trust — one others can read. */
export function readCallerKey(file: string): CallerKey | null {
  try {
    if ((statSync(file).mode & 0o077) !== 0) {
      throw new Error(`${file} is readable by others — chmod 600 it`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      priv: Record<string, unknown>
      pub: Record<string, unknown>
    }
    return { priv: createPrivateKey({ key: parsed.priv, format: 'jwk' }), jwk: parsed.pub }
  } catch {
    return null
  }
}

/** Write a key file privately. `mode` applies at creation only, so the chmod
 *  is unconditional — an existing file keeps whatever it had otherwise. */
export function writeKeyFile(file: string, key: { pub: unknown; priv: unknown }): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(key), { mode: 0o600 })
  chmodSync(file, 0o600)
}

/** Write a key under the door's identity — the canonical home. */
export function saveCallerKey(serviceId: string, key: { pub: unknown; priv: unknown }): void {
  writeKeyFile(callerKeyFile(serviceId), key)
}

/** Mint a fresh account key. Minting IS the sign-up, at a door that has no
 *  account for this name yet. */
export function mintCallerKey(): CallerKey & { raw: { pub: unknown; priv: unknown } } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ format: 'jwk' }) as Record<string, unknown>
  const priv = privateKey.export({ format: 'jwk' }) as Record<string, unknown>
  return { priv: createPrivateKey({ key: priv, format: 'jwk' }), jwk: pub, raw: { pub, priv } }
}

/** Sign the door's challenge with this account's key. */
export function signChallenge(
  key: CallerKey,
  serviceId: string,
  sub: string,
  challenge: string
): string {
  const payload = Buffer.from(callAssertionPayload(serviceId, sub, challenge), 'utf8')
  return sign(null, payload, key.priv).toString('base64url')
}

/**
 * WHO IS CALLING — the account, when this machine has one.
 *
 * `callerSub()` above answers with the OS username, and that was the whole
 * caller identity until accounts existed. It cannot stay that: two people
 * called `admin` are one subject at every door they both use, and the door
 * keys a session sandbox by that subject. The account is a name the registry
 * made unique, so when one has been minted it IS the caller.
 *
 * The OS username survives ONLY as the no-account fallback — a machine that
 * has never opened the setup sheet still has to be able to knock on a door on
 * the LAN — and it is marked as such (`source`), so a surface can say which
 * name it is about to use rather than implying the person chose it.
 */
export interface CallingIdentity {
  sub: string
  source: 'account' | 'os-user'
  /**
   * The key that signs for this subject. The ACCOUNT key when the subject is
   * an account: one key for one name is the point — a per-door key would make
   * the same person a different stranger at every door, which is the TOFU
   * problem accounts exist to end. Null means "mint or read a per-door key",
   * the old path.
   */
  key: CallerKey | null
}

export function callingIdentity(
  options: { baseDir?: string; osUser?: string } = {}
): CallingIdentity {
  const account = loadAccount(options.baseDir)
  // A handle is already a legal door sub (its shape is a subset), so it is
  // used verbatim rather than pushed through callerSub() — normalising a name
  // the registry minted could only ever change it into somebody else's.
  if (account !== null && HANDLE_SHAPE.test(account.handle)) {
    return {
      sub: account.handle,
      source: 'account',
      key: {
        priv: createPrivateKey({ key: account.privateKeyJwk as never, format: 'jwk' }),
        jwk: account.publicKeyJwk
      }
    }
  }
  return { sub: callerSub(options.osUser), source: 'os-user', key: null }
}
