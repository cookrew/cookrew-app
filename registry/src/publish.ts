import { canonicalJson, type PresetManifest } from '../../src/shared/preset-manifest'
import { RegistryStore, addressOf, isAddress, lineageOf } from './store'
import { TransparencyLog } from './log'
import { countersignPayload, type CountersignOperation } from './countersign'

/**
 * PUBLISH (P2-A3) — the write side of the gate.
 *
 * Three things have to be true before bytes are accepted, and they are
 * independent: the caller proved WHO they are with a fresh ceremony, the author
 * key claims THESE bytes with a signature the registry can check, and the
 * identity claims THAT KEY with a countersignature. Any one alone is
 * insufficient — a signature without an identity is anonymous, an identity
 * without a signature is a claim about someone else's work.
 */

export type PublishFailure =
  | 'scope'
  | 'schema_unsupported'
  | 'unsigned'
  | 'signature_invalid'
  | 'hash_mismatch'
  | 'countersign_missing'
  | 'author_key_changed'
  | 'version_not_newer'
  /**
   * M2-A1: the manifest carries a price and this identity has never said where
   * it is paid. Refused HERE rather than at the 402, so the failure lands on
   * the author — who can fix it in the ceremony they are already standing in —
   * instead of on a buyer who cannot fix it and has done nothing wrong.
   */
  | 'payout_missing'

export interface PublishInput {
  manifest: PresetManifest
  teamBytes: Buffer
  teamName: string
  visibility: 'public' | 'identified'
  /** The credential id from the publish-scoped token. */
  identityId: string
  /** Assertion over sha256(authorKeyId ‖ presetId), base64url. */
  countersig: string
  /**
   * M2-A1. Where this identity is paid, if it is supplying or changing one.
   * Absent means "keep whatever is already bound" — an author who set it once
   * does not resend it on every publish.
   */
  payoutAddress?: string
  at: number
}

export type PublishResult =
  | { ok: true; id: string; version: number }
  | { ok: false; reason: PublishFailure }

/**
 * What a countersignature commits to now lives in ./countersign.ts, which adds
 * the OPERATION to the digest. The version here bound only (key, preset), so
 * the two operations shared one payload and a countersig lifted from the public
 * log verified at the other route. Re-exported because the shape of the fact
 * belongs to publishing even though the bytes are defined next door.
 */
export { countersignPayload } from './countersign'

/**
 * TOFU across versions. The first publish in a lineage binds an author key; a
 * later version under a different key is REFUSED unless the log already carries
 * a rotation countersigned by the same identity.
 *
 * The registry doing this is a convenience, not the security boundary — per A5
 * a compromised registry can only deny. The boundary is the key each client
 * pinned at install. This catches the mistake early and makes the log mean
 * something; it is not what keeps a buyer safe, and reading it as protection is
 * the error the whole signing design exists to prevent.
 */
export function authorKeyFor(
  log: TransparencyLog,
  lineage: string,
  lineageOfRecord: (presetId: string) => string | null
): string | null {
  let key: string | null = null
  for (const record of log.all()) {
    if (lineageOfRecord(record.presetId) !== lineage) continue
    if (record.kind === 'publish' && key === null) key = record.authorKeyId
    // A rotation MOVES the binding — but only one countersigned by the identity
    // that already held it, which append-time checking enforces.
    if (record.kind === 'key-rotation') key = record.authorKeyId
  }
  return key
}

export interface PublishDeps {
  store: RegistryStore
  log: TransparencyLog
  /**
   * Verify the countersignature for a SPECIFIC operation. The operation is a
   * parameter rather than context because it is the thing being proved: a
   * verifier that cannot tell a publish from a rotation is the verifier this
   * slice replaced.
   */
  verifyCountersign: (
    operation: CountersignOperation,
    identityId: string,
    payload: Buffer,
    countersig: string
  ) => boolean
  /** Verify the manifest's own ed25519 signature. */
  verifyManifest: (manifest: PresetManifest) => boolean
  /**
   * M2-A1. Where authors are paid. Absent in a deployment that sells nothing,
   * in which case a priced manifest is refused rather than silently published
   * as if it were free.
   */
  payouts?: { addressOf: (identityId: string) => string | null; bind: (identityId: string, address: string) => boolean }
}

export function publishPreset(deps: PublishDeps, input: PublishInput): PublishResult {
  const { manifest } = input
  if (manifest.schema !== 'cookrew.preset/1') return { ok: false, reason: 'schema_unsupported' }
  if (typeof manifest.sig !== 'string' || manifest.sig.length === 0) {
    return { ok: false, reason: 'unsigned' }
  }
  if (!isAddress(manifest.id)) return { ok: false, reason: 'hash_mismatch' }

  // The bytes must be what the manifest says they are, checked here rather than
  // trusted: a registry that stores a manifest whose id does not address its
  // blob is serving a lie to every client that later verifies.
  const actual = addressOf(input.teamBytes)
  if (actual !== manifest.id || manifest.blobs[manifest.team] !== actual) {
    return { ok: false, reason: 'hash_mismatch' }
  }
  if (!deps.verifyManifest(manifest)) return { ok: false, reason: 'signature_invalid' }

  // The identity claims the key. Without this an authenticated caller could
  // publish work signed by somebody else's key and the log would record their
  // identity beside it.
  const payload = countersignPayload('publish', manifest.author.keyId, manifest.id)
  if (!deps.verifyCountersign('publish', input.identityId, payload, input.countersig)) {
    return { ok: false, reason: 'countersign_missing' }
  }

  // M2-A1: A PRICE NEEDS A PAYEE, and the check belongs here.
  //
  // The money path is buyer → author (Commander, 2026-08-22), so a priced
  // preset the registry cannot route payment for is not a preset that should
  // exist. Refusing at publish puts the failure in front of the AUTHOR, mid
  // ceremony, where it is one field away from fixed. Deferring it to the 402
  // would put it in front of a BUYER, who cannot fix it, has done nothing
  // wrong, and would meet it as a preset that simply never sells.
  //
  // Bound BEFORE the store write, so a publish that stores bytes always has a
  // payee on record for them — the two must not be able to disagree after a
  // crash between them.
  if (manifest.pricing !== undefined) {
    const bound =
      input.payoutAddress !== undefined
        ? (deps.payouts?.bind(input.identityId, input.payoutAddress) ?? false)
        : deps.payouts?.addressOf(input.identityId) !== null &&
          deps.payouts?.addressOf(input.identityId) !== undefined
    if (!bound) return { ok: false, reason: 'payout_missing' }
  } else if (input.payoutAddress !== undefined) {
    // A free preset may still carry an address: an author setting up before
    // pricing anything. Recorded, and a malformed one is still refused rather
    // than stored — a bad address is not made harmless by arriving early.
    if (!(deps.payouts?.bind(input.identityId, input.payoutAddress) ?? false)) {
      return { ok: false, reason: 'payout_missing' }
    }
  }

  const lineage = lineageOf(input.identityId, input.teamName)
  const lineageOfRecord = (presetId: string): string | null => {
    const stored = deps.store.getManifest(presetId)
    if (stored === null) return null
    const summary = deps.store.list().find((p) => p.id === presetId)
    return summary?.lineage ?? null
  }

  const held = authorKeyFor(deps.log, lineage, lineageOfRecord)
  if (held !== null && held !== manifest.author.keyId) {
    return { ok: false, reason: 'author_key_changed' }
  }

  // Versions only go forward within a lineage. A republished or lowered version
  // would make "is there a newer one" ambiguous for every client holding one.
  const highest = deps.store
    .list()
    .filter((p) => p.lineage === lineage)
    .reduce((max, p) => Math.max(max, p.version), 0)
  if (highest > 0 && manifest.version <= highest) {
    return { ok: false, reason: 'version_not_newer' }
  }

  deps.store.putBlob(input.teamBytes)
  deps.store.putManifest({
    manifest,
    teamName: input.teamName,
    visibility: input.visibility,
    identityId: input.identityId
  })
  deps.log.append({
    at: input.at,
    kind: 'publish',
    presetId: manifest.id,
    version: manifest.version,
    authorKeyId: manifest.author.keyId,
    identityId: input.identityId,
    countersig: input.countersig
  })
  return { ok: true, id: manifest.id, version: manifest.version }
}

/**
 * Record a key rotation. Countersigned by the identity that ALREADY holds the
 * lineage — an identity cannot rotate a key it never held, or rotation would be
 * a way to take a lineage over rather than to keep one.
 */
export function rotateAuthorKey(
  deps: PublishDeps,
  input: {
    // `lineage` used to be here and was never read — the check below works off
    // the log records for this preset. A parameter that looks load-bearing in a
    // security function and is not is worse than an absent one, because the
    // next reader assumes it was checked.
    presetId: string
    newAuthorKeyId: string
    identityId: string
    countersig: string
    at: number
  }
): { ok: boolean; reason?: PublishFailure } {
  const priorIdentity = deps.log
    .all()
    .filter((r) => r.presetId === input.presetId)
    .map((r) => r.identityId)
    .pop()
  if (priorIdentity !== input.identityId) return { ok: false, reason: 'author_key_changed' }
  const payload = countersignPayload('key-rotation', input.newAuthorKeyId, input.presetId)
  if (!deps.verifyCountersign('key-rotation', input.identityId, payload, input.countersig)) {
    return { ok: false, reason: 'countersign_missing' }
  }
  deps.log.append({
    at: input.at,
    kind: 'key-rotation',
    presetId: input.presetId,
    version: 0,
    authorKeyId: input.newAuthorKeyId,
    identityId: input.identityId,
    countersig: input.countersig
  })
  return { ok: true }
}

/** Canonical form of a publish request body, for the countersignature. */
export function publishRequestDigest(manifest: PresetManifest): string {
  return canonicalJson({ id: manifest.id, authorKeyId: manifest.author.keyId })
}
