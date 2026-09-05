import { Limiter } from './v2-limiter'
import { ChallengeStore } from './v2-passkeys'
import { PendingSignIns } from './v2-pending'
import { V2Factors } from './v2-factor-store'

/**
 * IDENTITY v2, PHASE 4 — THE STATE THE LADDER STANDS ON, assembled once.
 *
 * A leaf module on purpose: `createV2` needs this, the routes need this, and
 * neither should have to import the other to get it. Three pieces, and the
 * split between them is the point —
 *
 *   store       what an account HAS. On disk, because a passkey outlives a
 *               restart and a person expects it to.
 *   pending     a sign-in that is half done. In memory, because a
 *               conversation does not outlive the process it happened in.
 *   challenges  single-use WebAuthn challenges. In memory for the same
 *               reason, and because a restart invalidating them all is right.
 */

export interface FactorState {
  store: V2Factors
  pending: PendingSignIns
  challenges: ChallengeStore
  /** Per-IP on the options routes, which mint work for anyone who asks. */
  options: Limiter
}

export interface FactorOptions {
  now?: () => number
  /** Options asked for per minute per address. Thirty is a person retrying. */
  optionsPerMinute?: number
}

export function createFactorState(base: string, options: FactorOptions = {}): FactorState {
  const now = options.now
  return {
    store: new V2Factors(base, now),
    pending: new PendingSignIns(now),
    challenges: new ChallengeStore(120_000, 4, now),
    options: new Limiter(options.optionsPerMinute ?? 30, 60_000, now)
  }
}
