import { machineCopy } from '../../../shared/machine-words'

/**
 * THE ONE LINE THAT LETS THIS MACHINE SEE THE ACCOUNT'S OTHERS (owner
 * 2026-11-10: "no reading", without a ritual). A machine signed in with a proof
 * on it (a password, a passkey, or its second step) is trusted from that
 * sign-in and sees nothing here. One signed in before machines trusted each
 * other proves itself once: signed in again on auth.cookrew.dev, as its own
 * device, second step and all (account-v2 · browserResume). A provider's trip
 * alone is not enough (security review 2026-11-10).
 */

export interface MachineTrustState {
  readonly trusted: boolean
}

export type MachineTrustLine = { readonly kind: 'button'; readonly text: string }

export function machineTrustLine(state: MachineTrustState | null, others: number, platform: string | undefined): MachineTrustLine | null {
  if (state === null || state.trusted || others === 0) return null
  return { kind: 'button', text: machineCopy('Sign this Mac in again to see your other machines', platform) }
}
