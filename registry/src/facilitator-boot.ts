import type { Facilitator } from './facilitator'
import { devFacilitator } from './facilitator-dev'

/**
 * WHICH FACILITATOR A BOOT GETS, and outside --dev the answer is none.
 *
 * Null is a real state, not a missing dependency: the registry still serves
 * everything free, and a priced preset is refused before any quote exists
 * (authorize.ts). A real facilitator is wired here when one exists. Until then
 * no deployment can settle anything, which is the point: the money moves buyer
 * to author, so a registry that cannot check a transfer must not invite one.
 *
 * --dev on a public origin refuses to boot. The dev stand-in settles any
 * non-empty tx, so one stray flag on the deployed command line would otherwise
 * mint entitlements for free, exactly the fault this file exists to end.
 */

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

export type FacilitatorBoot =
  | { ok: true; facilitator: Facilitator | null }
  | { ok: false; reason: string }

export function facilitatorFor(mode: { dev: boolean; origin: string }): FacilitatorBoot {
  if (!mode.dev) return { ok: true, facilitator: null }
  if (!LOOPBACK_HOSTS.includes(new URL(mode.origin).hostname)) {
    return { ok: false, reason: `--dev settles any payment, so it only runs on a loopback origin, not ${mode.origin}` }
  }
  return { ok: true, facilitator: devFacilitator() }
}
