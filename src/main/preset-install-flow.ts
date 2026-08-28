// The download → verify → review flow (Feature A, client side).
//
// This is the bridge the install-link recogniser (registry-install-link.ts)
// leaves to main: "Main owns download, signature verification and the review
// sheet, and the user owns the decision." It composes the download client
// (preset-download.ts) with the verifier and review builder (preset-install.ts)
// into ONE outcome the renderer acts on — either a review sheet to show, or a
// gate step to resolve (enrol a passkey, take a payment, surface a refusal).
//
// INTERACTION MODEL. The gate is a loop the USER closes: a 401 sends the
// renderer to a passkey ceremony, a 402 to a wallet, and each returns here with
// a fresh credential to try again. So this function does ONE pass and returns
// where it got to; the renderer re-invokes it with the new credential. Keeping
// the loop out of here is what makes it a pure, testable step.
//
// VERIFICATION IS THE CLIENT'S (A5). A 200 from the registry is not trust — the
// signature, the content hash, and the scrub-report reconciliation are all
// checked here against the key the client pins for this preset. A compromised
// registry can therefore deny service but cannot serve a tampered preset.

import type { KeyObject } from 'node:crypto'
import type { PresetManifest } from '../shared/preset-manifest'
import { PRESET_SCHEMA } from '../shared/preset-manifest'
import type { ForbiddenReason } from '../shared/preset-manifest'
import type { PaymentTerms, GateStep, DownloadOptions } from './preset-download'
import type {
  VerifyInput,
  VerifyResult,
  VerifyFailure,
  VerifiedPreset,
  ReviewSheetPayload
} from './preset-install'

/**
 * Where one pass of the flow got to. `review` is success — the sheet can
 * render and, on the user's yes, the preset installs. The rest are the gate
 * steps and failures the renderer resolves or reports; none of them install.
 */
export type DownloadOutcome =
  | { kind: 'review'; payload: ReviewSheetPayload; verified: VerifiedPreset }
  | { kind: 'enrol'; challenge: string }
  | { kind: 'pay'; terms: PaymentTerms; retryable: boolean; reason?: string }
  | { kind: 'denied'; reason: ForbiddenReason | 'unknown'; retryable: boolean }
  | { kind: 'gone' }
  | { kind: 'verify_failed'; reason: VerifyFailure }
  | { kind: 'error'; status: number }

export interface DownloadDeps {
  registryBase: string
  /** Bearer token / payment proof accumulated so far in the gate loop. */
  credentials?: DownloadOptions
  fetchManifest: (base: string, id: string, opts: DownloadOptions) => Promise<GateStep>
  fetchBlob: (base: string, address: string, opts: DownloadOptions) => Promise<GateStep>
  /**
   * The author key this client pins for this preset, or null on first use.
   * Null means trust-on-first-use: the claimed key is accepted and the store
   * pins it, so a later key change becomes `author_key_changed` (R20).
   */
  trustedKeyFor: (presetId: string) => KeyObject | null
  verify: (input: VerifyInput) => VerifyResult
  review: (verified: VerifiedPreset) => ReviewSheetPayload
  /** `publicKeyFromId`, guarded — null when the id is not a usable key. */
  claimedKey: (keyId: string) => KeyObject | null
}

/** A gate step (never `ready`) as a flow outcome. */
function gateOutcome(step: Exclude<GateStep, { kind: 'ready' }>): DownloadOutcome {
  switch (step.kind) {
    case 'enrol':
      return { kind: 'enrol', challenge: step.challenge }
    case 'pay':
      return step.reason !== undefined
        ? { kind: 'pay', terms: step.terms, retryable: step.retryable, reason: step.reason }
        : { kind: 'pay', terms: step.terms, retryable: step.retryable }
    case 'denied':
      return { kind: 'denied', reason: step.reason, retryable: step.retryable }
    case 'gone':
      return { kind: 'gone' }
    case 'error':
      return { kind: 'error', status: step.status }
  }
}

/** Shape guard for a manifest body a hostile registry chose. */
function asManifest(body: unknown): PresetManifest | null {
  if (body === null || typeof body !== 'object') return null
  const m = body as Partial<PresetManifest>
  if (m.schema !== PRESET_SCHEMA) return null
  if (typeof m.id !== 'string' || typeof m.team !== 'string') return null
  if (typeof m.version !== 'number' || m.blobs === undefined || m.author === undefined) return null
  return body as PresetManifest
}

/**
 * Run one pass: fetch the manifest, and if it is served, fetch its team blob,
 * verify both against the pinned key, and build the review payload. Any gate
 * step short-circuits and is returned for the renderer to resolve.
 */
export async function downloadForReview(
  presetId: string,
  deps: DownloadDeps
): Promise<DownloadOutcome> {
  const creds = deps.credentials ?? {}

  const manifestStep = await deps.fetchManifest(deps.registryBase, presetId, creds)
  if (manifestStep.kind !== 'ready') return gateOutcome(manifestStep)

  const manifest = asManifest(manifestStep.body)
  if (manifest === null) return { kind: 'error', status: 200 }

  // The link named a content address; a manifest with a different id would
  // install something other than what was asked for. Treat it as the hash
  // mismatch it is, before spending a blob fetch on it.
  if (manifest.id !== presetId) return { kind: 'verify_failed', reason: 'hash_mismatch' }

  const address = manifest.blobs?.[manifest.team]
  if (typeof address !== 'string' || address.length === 0) {
    return { kind: 'verify_failed', reason: 'malformed_team' }
  }

  const blobStep = await deps.fetchBlob(deps.registryBase, address, creds)
  if (blobStep.kind !== 'ready') return gateOutcome(blobStep)
  const teamBytes = blobStep.body as Buffer

  // The key we VERIFY against: the pinned one if we have it, else the key the
  // manifest claims (trust-on-first-use). A pinned key that the manifest's
  // signature does not match is R20's author_key_changed, surfaced by verify.
  const publicKey = deps.trustedKeyFor(presetId) ?? deps.claimedKey(manifest.author.keyId)
  if (publicKey === null) return { kind: 'verify_failed', reason: 'signature_invalid' }

  const result = deps.verify({ manifest, teamBytes, publicKey })
  if (!result.ok) return { kind: 'verify_failed', reason: result.reason }

  return { kind: 'review', payload: deps.review(result), verified: result }
}
