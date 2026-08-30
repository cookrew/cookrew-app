import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import { callAssertionPayload } from './call-ceremony'

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

/** Where a door's account key lives. 0600, one per (host, slug). */
export function callerKeyFile(origin: string, slug: string): string {
  const host = new URL(origin).host.replace(/[^a-z0-9.-]/gi, '_')
  return path.join(homedir(), '.cookrew', 'caller-keys', `${host}-${slug}.json`)
}

/** The retired path, still read so an account made before the rename survives. */
function legacyKeyFile(origin: string, slug: string): string {
  const host = new URL(origin).host.replace(/[^a-z0-9.-]/gi, '_')
  return path.join(homedir(), '.cookrew', 'crew-keys', `${host}-${slug}.json`)
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

interface CallerKey {
  priv: ReturnType<typeof createPrivateKey>
  jwk: Record<string, unknown>
}

/** Load this door's account key, or mint one (that mint IS the sign-up). */
export function loadOrCreateCallerKey(origin: string, slug: string): CallerKey {
  const file = callerKeyFile(origin, slug)
  for (const candidate of [file, legacyKeyFile(origin, slug)]) {
    try {
      // A key another user can read is not this account's key.
      if ((statSync(candidate).mode & 0o077) !== 0) {
        throw new Error(`${candidate} is readable by others — chmod 600 it`)
      }
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
        priv: Record<string, unknown>
        pub: Record<string, unknown>
      }
      return { priv: createPrivateKey({ key: parsed.priv, format: 'jwk' }), jwk: parsed.pub }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ format: 'jwk' }) as Record<string, unknown>
  const priv = privateKey.export({ format: 'jwk' }) as Record<string, unknown>
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify({ pub, priv }), { mode: 0o600 })
  chmodSync(file, 0o600)
  return { priv: createPrivateKey({ key: priv, format: 'jwk' }), jwk: pub }
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
