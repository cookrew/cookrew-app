// The author journey, as ONE owner action.
//
// Every primitive this needs already existed — scrubForPublish, buildManifest,
// signManifest, a payout check — and nothing connected them. That is the whole
// of Magpie's give-up #1: publishing was possible and unshipped, so she wrote
// ~140 lines by hand to walk a path the product had all the pieces for.
//
// THE ORDER IS THE SAFETY PROPERTY, and it is why this is a module rather than
// a handler:
//
//   host    → we must know WHERE before we build anything. A signed manifest
//             carries the author's payout address, and building one before
//             knowing its recipient is how a signed artifact ends up looking
//             for a home. Also the cheapest refusal, so the author is not made
//             to wait for a scrub to be told the setting is missing.
//   scrub   → a gate, not a report. A blocked scrub carries no snapshot, so
//             nothing downstream can be handed the pieces and continue.
//   payout  → R27, at publish. The registry never holds funds, so payTo is the
//             author's own address and nothing downstream will ever question
//             it. A priced publish without a VERIFIED address is refused here
//             or it is never refused at all.
//   sign    → last thing before it leaves. Signing is the irreversible act:
//             it binds this author's key to these bytes.
//   push    → its own step, so "the registry said no" is never confused with
//             "your snapshot was rejected".
//
// The transport is INJECTED rather than imported. The registry's HTTP contract
// lives on the M2 branch, which is not merged; wiring a real POST against a
// route this branch cannot see would be inventing a contract. The seam means
// that wiring is a small change later rather than a rewrite, and the order
// above is testable now.

import type { PresetManifest, PresetPricing } from '../shared/preset-manifest'
import { checkPayoutAddress } from '../shared/eip55'

/** Where an author is paid, and on which network. */
export interface PayoutBinding {
  address: string
  /**
   * The chain the address is on. Kept in the terms and required for a priced
   * publish: the right address on the wrong chain is money gone WITH a
   * successful receipt, which is the one failure no refund path can reach.
   */
  chain: string
}

export interface PublishInput {
  snapshot: unknown
  handle: string
  version?: number
  pricing?: PresetPricing
  payout?: PayoutBinding
}

/** Which step refused, so the author knows what to change. */
export type PublishStep = 'host' | 'scrub' | 'payout' | 'manifest' | 'sign' | 'push'

export type PublishOutcome =
  | { ok: true; presetId: string; installUrl: string; host: string }
  | {
      ok: false
      step: PublishStep
      reason: string
      /** The value the author probably meant, when it is computable. */
      suggestion?: string
    }

export interface PublishDeps {
  /** Recognised registry hosts (shared/registry-host). */
  hosts: () => string[]
  /** What to say when there are none — names the setting and the reason. */
  hostHelp: () => string
  scrub: (snapshot: unknown) => { ok: boolean; snapshot?: unknown; report: unknown }
  manifest: (input: {
    scrub: unknown
    version: number
    author: { handle: string }
    pricing?: PresetPricing
  }) => { ok: boolean; manifest?: PresetManifest; teamBytes?: Buffer; reason?: string }
  sign: (manifest: PresetManifest) => PresetManifest
  push: (input: {
    manifest: PresetManifest
    teamBytes: Buffer
    host: string
  }) => Promise<{ presetId: string }>
}

/**
 * Is this preset actually charging?
 *
 * `amount` is a decimal STRING on the manifest, so the check is on its value
 * and not its presence: a pricing block of '0' collects nothing, and demanding
 * a payout address for it would be a gate with no risk behind it. A
 * non-numeric amount counts as PRICED — it is a malformed charge rather than a
 * free preset, and the payout gate refusing it is the safer read.
 */
function isPriced(pricing: PresetPricing | undefined): boolean {
  if (pricing === undefined) return false
  const amount = Number(pricing.amount)
  return Number.isFinite(amount) ? amount > 0 : true
}

const refuse = (step: PublishStep, reason: string, suggestion?: string): PublishOutcome => ({
  ok: false,
  step,
  reason,
  ...(suggestion !== undefined ? { suggestion } : {})
})

export async function publishPreset(
  deps: PublishDeps,
  input: PublishInput
): Promise<PublishOutcome> {
  // 1 — WHERE. Before any work, and before anything is signed.
  const hosts = deps.hosts()
  const host = hosts[0]
  if (host === undefined) return refuse('host', deps.hostHelp())

  // 2 — WHAT LEAVES. The scrub's verdict travels with its snapshot, so a
  // refusal cannot be bypassed by a caller that keeps the pieces.
  const scrubbed = deps.scrub(input.snapshot)
  if (!scrubbed.ok) {
    return refuse(
      'scrub',
      'This team still contains things that must not be published. Resolve the scrub findings and try again.'
    )
  }

  // 3 — WHO IS PAID. Only a PRICED publish needs this; a free preset collects
  // nothing, so demanding an address would be a gate with no risk behind it.
  if (isPriced(input.pricing)) {
    const payout = input.payout
    if (payout === undefined) {
      return refuse(
        'payout',
        'A priced preset needs a payout address. The registry never holds funds — buyers pay you ' +
          'directly — so without an address there is nobody for the money to reach.'
      )
    }
    if (payout.chain.trim().length === 0) {
      return refuse(
        'payout',
        'A priced preset needs the chain its payout address is on. The right address on the wrong ' +
          'network is money gone, and the receipt still says success.'
      )
    }
    const checked = checkPayoutAddress(payout.address)
    if (!checked.ok) return refuse('payout', checked.message, checked.suggestion)
  }

  // 4 — THE ARTIFACT.
  const built = deps.manifest({
    scrub: scrubbed,
    version: input.version ?? 1,
    author: { handle: input.handle },
    ...(input.pricing !== undefined ? { pricing: input.pricing } : {})
  })
  if (!built.ok || !built.manifest || !built.teamBytes) {
    return refuse('manifest', built.reason ?? 'The manifest could not be built from this team.')
  }

  // 5 — SIGN, the irreversible act, once everything above has agreed.
  let signed: PresetManifest
  try {
    signed = deps.sign(built.manifest)
  } catch (error) {
    return refuse('sign', error instanceof Error ? error.message : String(error))
  }

  // 6 — PUSH. Its own step so a registry refusal is never read as a problem
  // with the author's team.
  try {
    const receipt = await deps.push({ manifest: signed, teamBytes: built.teamBytes, host })
    return {
      ok: true,
      presetId: receipt.presetId,
      host,
      installUrl: `https://${host}/install/${receipt.presetId}`
    }
  } catch (error) {
    return refuse('push', error instanceof Error ? error.message : String(error))
  }
}
