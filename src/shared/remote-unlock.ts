/**
 * UNLOCKING A MAC FROM A PHONE: what both ends agree on (owner 2026-11-05).
 *
 * The password crosses a relay that can read everything else, so it is sealed
 * to the Mac's own key on the phone (relay-seal.ts). The phone pins that key the
 * first time, so a relay cannot swap it later, and each message answers a
 * one-time challenge, so a captured one cannot be sent again.
 */

/** The seal's label: this key seals nothing else. */
export const UNLOCK_INFO = 'mac-unlock/1'
export const UNLOCK_PASSWORD_MAX = 128

export type UnlockOutcome = 'unlocked' | 'wrong' | 'not-locked' | 'refused' | 'resting' | 'busy' | 'failed'

export type UnlockBegin = { readonly ok: true; readonly key: string; readonly challenge: string } | { readonly ok: false; readonly error: string; readonly outcome?: UnlockOutcome }

export type UnlockAnswer = { readonly ok: true; readonly outcome: 'unlocked' } | { readonly ok: false; readonly error: string; readonly outcome?: UnlockOutcome }
