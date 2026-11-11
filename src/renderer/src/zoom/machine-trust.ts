import { machineCopy } from '../../../shared/machine-words'

/**
 * THE ONE LINE THAT LETS THIS MACHINE SEE THE ACCOUNT'S OTHERS (owner
 * 2026-11-10: "no reading", without a ritual). A machine signed in with a proof
 * on it (a password, a passkey, or its second step) is trusted from that
 * sign-in and sees nothing here. One signed in without one (a provider alone,
 * a code) makes it once: on auth.cookrew.dev, as its own device, second step
 * and all (account-v2 · browserResume). A provider's trip alone is not enough
 * (security review 2026-11-10).
 *
 * IT SAYS WHAT IT ASKS, AND ONLY WHEN PRESSING IT OPENS SOMETHING (owner
 * 2026-11-11). It used to read "Sign this Mac in again", to a Mac signed in
 * minutes before, with the only other machine off. So: the proof is named (it
 * is not another sign-in to the person, it is the password or a passkey), the
 * line is there only when the registry has SAID this machine owes it (`null`
 * is "not asked yet", and says nothing), and only while another machine is
 * online and unread, which is the one case where the proof is what stands in
 * the way.
 */

export interface MachineTrustState {
  readonly trusted: boolean
}

export interface MachineTrustLine {
  readonly kind: 'button'
  readonly text: string
  /** What the press asks for, and why it is asked of a machine that is signed in. */
  readonly how: string
}

/** The button, as written for a Mac. Quoted by the sentence that points at it (machine-why.ts). */
export const TRUST_BUTTON = 'Prove it’s you on this Mac to see your other machines'
const TRUST_HOW = 'Your account password or a passkey, in the browser. The sign-in on this Mac did not include one: Google, GitHub or a code alone does not.'

/** The account's other machines the proof would open: online, and not read from here. */
export function blockedByTrust(machines: readonly { readonly local: boolean; readonly online: boolean; readonly detail: 'live' | 'connecting' | 'listed' }[]): number {
  return machines.filter((machine) => !machine.local && machine.online && machine.detail !== 'live').length
}

export function machineTrustLine(state: MachineTrustState | null, blocked: number, platform: string | undefined): MachineTrustLine | null {
  if (state === null || state.trusted || blocked === 0) return null
  return { kind: 'button', text: machineCopy(TRUST_BUTTON, platform), how: machineCopy(TRUST_HOW, platform) }
}
