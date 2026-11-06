/**
 * UNLOCKING A MAC FROM A PHONE: what both ends agree on (owner 2026-11-05).
 *
 * IT WORKS FROM ANY NETWORK (owner 2026-11-06). A password reaches the Mac in one of
 * two ways: from a page the Mac served itself, or inside the sealed session, whose
 * keys rest on a connect code the relay has never seen. A plain relayed request is
 * refused (use-source-routes.ts), so the relay cannot read a password in passing.
 *
 * THE LIMIT, ACCEPTED BY THE OWNER: a page from cookrew.dev is still written by whoever
 * serves it, and an altered page could read what is typed before any seal. Sealing
 * stops a relay that reads, not one that rewrites its pages. A native client ends that.
 *
 * Either way the password is also sealed to the Mac's key, which the phone pins, and
 * each message answers a one-time challenge.
 */

const OPERATOR_DOMAIN = 'cookrew.dev'

/**
 * A host cookrew.dev could answer for. It runs the d.cookrew.dev DNS and orders
 * those certificates, so a page on such a name is not proof it came from the Mac.
 * A bare address or a tailnet name is. Over-refusing here only costs a fallback,
 * so a suffix match is safe, and a missing host counts as outside.
 */
export function hostOutsideTheMac(host: string | undefined): boolean {
  if (!host) return true
  const name = host.toLowerCase().replace(/:\d+$/, '')
  return name === OPERATOR_DOMAIN || name.endsWith(`.${OPERATOR_DOMAIN}`)
}

/** Written over whatever came in on a door's way to this server (relay-serving.ts). */
export const DOOR_MARKER = 'x-cookrew-door'

/** Carries the terminus's proof (main/seal-proof.ts). The value is the point, not the name. */
export const SEALED_MARKER = 'x-cookrew-sealed'

/** The seal's label: this key seals nothing else. */
export const UNLOCK_INFO = 'mac-unlock/1'
export const UNLOCK_PASSWORD_MAX = 128

export const UNLOCK_NEEDS_SEAL = 'A password only reaches this Mac inside its sealed session.'

export type UnlockOutcome = 'unlocked' | 'wrong' | 'not-locked' | 'refused' | 'resting' | 'closed' | 'busy' | 'failed'

export type UnlockBegin = { readonly ok: true; readonly key: string; readonly challenge: string } | { readonly ok: false; readonly error: string; readonly outcome?: UnlockOutcome }

export type UnlockAnswer = { readonly ok: true; readonly outcome: 'unlocked' } | { readonly ok: false; readonly error: string; readonly outcome?: UnlockOutcome }
