import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import {
  PRESET_SCHEMA,
  canonicalJson,
  signedPayload,
  type PresetAuthor,
  type PresetManifest,
  type PresetPricing
} from '../shared/preset-manifest'
import type { ScrubResult } from './preset-scrub'

/**
 * PUBLISHER (marketplace §5, appendix). Turns a scrubbed team into the signed
 * manifest the gate serves, and verifies one on the way back in.
 *
 * A5: the registry is dumb and keys live at the edges. The author signs here
 * with a local ed25519 key that keeps working if the marketplace is down (A2),
 * and the CLIENT verifies for itself — so a compromised registry degrades to
 * denial of service, never to serving a tampered preset.
 */

/** `sha256:<hex>` content address. */
export function blobId(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/**
 * `ed25519:<base64url raw public key>`, derived from the key material itself so
 * a manifest's stated author cannot drift from the key that signed it.
 */
export function keyIdOf(key: KeyObject): string {
  // createPublicKey only accepts a PRIVATE KeyObject; a public one is already
  // what we want. Taking either end of the pair matters because the publisher
  // stamps from the private key and the verifier checks from the public one —
  // they must derive the same id.
  const pub = key.type === 'private' ? createPublicKey(key) : key
  const raw = pub.export({ format: 'jwk' }).x
  // M6: throw rather than mint `ed25519:`. An empty key id would compare equal
  // to another empty one, so a bad key would authenticate against a bad key.
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('not an ed25519 key: no public component to derive a key id from')
  }
  return `ed25519:${raw}`
}

/**
 * Rebuild a public key from a key id. Used by the store to check a manifest
 * against the key it was pinned to at install, so the identity that verifies
 * is the one recorded then rather than one the file supplies now.
 */
export function publicKeyFromId(keyId: string): KeyObject {
  if (!keyId.startsWith('ed25519:')) throw new Error('unsupported key id')
  const x = keyId.slice('ed25519:'.length)
  if (x.length === 0) throw new Error('empty key id')
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' })
}

export interface BuildManifestInput {
  scrub: ScrubResult
  version: number
  author: { handle: string }
  pricing?: PresetPricing
}

export type BuildManifestResult =
  | { ok: true; manifest: PresetManifest; teamBytes: Buffer }
  | { ok: false; reason: string }

/**
 * Build an unsigned manifest from a scrub result.
 *
 * The scrub result is taken WHOLE rather than as a snapshot plus a report, so
 * the refusal cannot be bypassed by a caller that scrubs, ignores the verdict
 * and passes the pieces along: a blocked scrub carries no snapshot, and this is
 * the only door to publishing.
 */
export function buildManifest(input: BuildManifestInput): BuildManifestResult {
  if (!input.scrub.ok) {
    const kinds = [...new Set(input.scrub.report.findings.map((f) => f.kind))].join(', ')
    return {
      ok: false,
      reason: `publish blocked: the export carries secrets (${kinds}) — remove them and re-export`
    }
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    return { ok: false, reason: `publish blocked: version must be a positive integer` }
  }

  // The team file is canonicalised before hashing so its content address is a
  // property of the TEAM, not of whichever serializer happened to write it.
  const teamBytes = Buffer.from(canonicalJson(input.scrub.snapshot), 'utf8')
  const teamId = blobId(teamBytes)

  return {
    ok: true,
    teamBytes,
    manifest: {
      schema: PRESET_SCHEMA,
      id: teamId,
      version: input.version,
      team: 'team.json',
      blobs: { 'team.json': teamId },
      // Stamped for real at signing time, when the key is in hand.
      author: { keyId: '', handle: input.author.handle },
      scrub: input.scrub.report,
      ...(input.pricing ? { pricing: input.pricing } : {})
    }
  }
}

/**
 * Sign a manifest, stamping the author keyId from the signing key itself. The
 * caller does not get to name the author: a keyId taken on trust would let a
 * publisher attribute a preset to someone else and still produce a valid
 * signature.
 */
export function signManifest(manifest: PresetManifest, privateKey: KeyObject): PresetManifest {
  const authored: PresetManifest = {
    ...manifest,
    author: { ...manifest.author, keyId: keyIdOf(privateKey) }
  }
  const signature = sign(null, Buffer.from(signedPayload(authored), 'utf8'), privateKey)
  return { ...authored, sig: `ed25519:${signature.toString('base64url')}` }
}

/**
 * Verify a manifest against a public key. False — never a throw — for every
 * failure, because this runs on data a hostile registry chose: malformed
 * signatures are an expected input, not an exception.
 *
 * Two checks, both required. The signature must cover the manifest, AND the
 * stated author keyId must be the key doing the verifying: a signature alone
 * would let a registry keep valid bytes while rewriting the handle it is
 * attributed to, and attribution is what the transparency log makes permanent.
 */
export function verifyManifest(manifest: PresetManifest, publicKey: KeyObject): boolean {
  try {
    if (typeof manifest.sig !== 'string' || !manifest.sig.startsWith('ed25519:')) return false
    if (manifest.author.keyId !== keyIdOf(publicKey)) return false
    const signature = Buffer.from(manifest.sig.slice('ed25519:'.length), 'base64url')
    if (signature.length === 0) return false
    return verify(null, Buffer.from(signedPayload(manifest), 'utf8'), publicKey, signature)
  } catch {
    return false
  }
}

/** Author key material used by the publisher — never leaves the machine (A5). */
export interface PublishingKey {
  publicKey: KeyObject
  privateKey: KeyObject
}
