import type { KeyObject } from 'node:crypto'
import {
  PRESET_SCHEMA,
  type PresetAuthor,
  type PresetManifest,
  type PresetPricing,
  type ScrubReport
} from '../shared/preset-manifest'
import { blobId, verifyManifest } from './preset-publish'
import { commandsOf, countSurfaces } from './preset-scrub'
import { planPresetImport, type ImportOptions, type PresetImportPlan } from './preset-import'
import type { TeamSnapshot } from './teams'

/**
 * INSTALL (marketplace §2 client move, §5 review sheet, §8 placement).
 *
 * The order is verify → review → paste, and it is enforced by types rather than
 * by convention: a review payload can only be built from a VerifiedPreset, and
 * an install can only be planned from one. There is no arrangement of these
 * functions that renders a sheet for content nobody checked.
 */

/** Why an install was refused. Machine-readable; the UI owns the wording. */
export type VerifyFailure =
  | 'schema_unsupported'
  | 'unsigned'
  | 'signature_invalid'
  | 'hash_mismatch'
  | 'malformed_team'
  | 'report_mismatch'

export interface VerifiedPreset {
  ok: true
  manifest: PresetManifest
  snapshot: TeamSnapshot
}

export type VerifyResult = VerifiedPreset | { ok: false; reason: VerifyFailure }

export interface VerifyInput {
  manifest: PresetManifest
  /** The team.json blob exactly as downloaded. */
  teamBytes: Buffer
  /** The author key the client trusts for this preset. */
  publicKey: KeyObject
}

function parseSnapshot(bytes: Buffer): TeamSnapshot | null {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as TeamSnapshot
    if (typeof value !== 'object' || value === null) return null
    if (typeof value.name !== 'string' || !Array.isArray(value.nodes)) return null
    return value
  } catch {
    return null
  }
}

/**
 * Verify a downloaded preset. The client does this ITSELF (A5) — that is what
 * makes a compromised registry a denial of service rather than a way to serve
 * tampered presets.
 *
 * Six checks, in the order that fails cheapest first. The last one is the
 * interesting one: the signed manifest carries BOTH a scrub report and the team
 * hash, so a valid signature still leaves room for an author to sign a report
 * that understates what the team contains — "0 shell cards" over a team with
 * five. The review sheet is the buyer's only defence before first run, so a
 * report that disagrees with the file it describes is treated as a forgery,
 * not a rounding error. Publisher and installer count with the same function,
 * or this check would prove nothing.
 */
export function verifyPreset(input: VerifyInput): VerifyResult {
  const { manifest, teamBytes, publicKey } = input
  if (manifest.schema !== PRESET_SCHEMA) return { ok: false, reason: 'schema_unsupported' }
  if (typeof manifest.sig !== 'string' || manifest.sig.length === 0) {
    return { ok: false, reason: 'unsigned' }
  }
  if (!verifyManifest(manifest, publicKey)) return { ok: false, reason: 'signature_invalid' }

  const actual = blobId(teamBytes)
  if (manifest.blobs[manifest.team] !== actual || manifest.id !== actual) {
    return { ok: false, reason: 'hash_mismatch' }
  }

  const snapshot = parseSnapshot(teamBytes)
  if (snapshot === null) return { ok: false, reason: 'malformed_team' }

  const counted = countSurfaces(snapshot.nodes)
  if (
    counted.commands !== manifest.scrub.commands ||
    counted.notes !== manifest.scrub.notes ||
    counted.urls !== manifest.scrub.urls
  ) {
    return { ok: false, reason: 'report_mismatch' }
  }

  return { ok: true, manifest, snapshot }
}

/**
 * What the install review sheet renders. R14: every field is a spec token, a
 * count, a boolean, or verbatim user content — no prose, no pre-formatted
 * strings. The UI owns wording and Magpie builds fixtures from this shape, so a
 * friendly string baked in here would become an assertion in someone else's
 * test and freeze the copy.
 */
export interface ReviewSheetPayload {
  schema: typeof PRESET_SCHEMA
  id: string
  version: number
  author: PresetAuthor
  scrub: ScrubReport
  /**
   * EVERY terminal's command, verbatim and in canvas order — not just the ones
   * whose preset is 'Shell'. The paste engine feeds `command` to a PTY
   * regardless of preset, so filtering by preset here rendered an empty list
   * over a team whose every node ran something.
   */
  commands: string[]
  /**
   * ONE representation of "free": the key is ABSENT. Never null, never a
   * present-but-undefined key. A payload that spelled free as null would lock
   * a free preset in any renderer that tests `pricing === undefined`, and both
   * spellings existing at once means every consumer has to guess which it got.
   */
  pricing?: PresetPricing
}

export function reviewSheetPayload(verified: VerifiedPreset): ReviewSheetPayload {
  const commands = commandsOf(verified.snapshot.nodes)
  return {
    schema: PRESET_SCHEMA,
    id: verified.manifest.id,
    version: verified.manifest.version,
    author: verified.manifest.author,
    // Safe to pass through: verify has already reconciled it against the file.
    scrub: verified.manifest.scrub,
    commands,
    // Spread-if-present, never `pricing: undefined` — the key must not exist
    // for a free preset, so `'pricing' in payload` and `payload.pricing !==
    // undefined` give the same answer to every consumer.
    ...(verified.manifest.pricing !== undefined ? { pricing: verified.manifest.pricing } : {})
  }
}

/**
 * Plan the placement of a verified preset: a plain terminal for a single agent,
 * a copyTeam snapshot source for a team, and in both cases idle and unbound.
 * The version pin records the manifest it came from, so a later HEAD can tell
 * the buyer which version they are actually holding.
 */
export function planInstall(
  verified: VerifiedPreset,
  options: Omit<ImportOptions, 'manifestId'>
): PresetImportPlan {
  return planPresetImport(verified.snapshot, { ...options, manifestId: verified.manifest.id })
}
