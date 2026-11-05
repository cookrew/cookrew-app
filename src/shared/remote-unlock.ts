/**
 * UNLOCKING A MAC FROM A PHONE: what both ends agree on (owner 2026-11-05).
 *
 * A PAGE THE RELAY SERVED NEVER SEES THE PASSWORD. A seal only helps if the code
 * doing the sealing can be trusted, and whoever serves a page can change it, so
 * a page from cookrew.dev could capture what is typed before any seal. Only a
 * page the Mac served itself, on its Wi-Fi or Tailscale address, asks for it. The
 * Mac refuses the rest (use-source-routes.ts) and the page draws no field.
 *
 * On that direct path the password is still sealed to the Mac's key, which the
 * phone pins, and each message answers a one-time challenge.
 */

/** The seal's label: this key seals nothing else. */
export const UNLOCK_INFO = 'mac-unlock/1'
export const UNLOCK_PASSWORD_MAX = 128

export const UNLOCK_DIRECT_ONLY = 'A password never passes through cookrew.dev. Open Cookrew at this Mac’s Wi-Fi or Tailscale address to unlock it.'

export type UnlockOutcome = 'unlocked' | 'wrong' | 'not-locked' | 'refused' | 'resting' | 'closed' | 'busy' | 'failed'

export type UnlockBegin = { readonly ok: true; readonly key: string; readonly challenge: string } | { readonly ok: false; readonly error: string; readonly outcome?: UnlockOutcome }

export type UnlockAnswer = { readonly ok: true; readonly outcome: 'unlocked' } | { readonly ok: false; readonly error: string; readonly outcome?: UnlockOutcome }
