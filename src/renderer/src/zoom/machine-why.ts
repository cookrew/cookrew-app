import { machineCopy } from '../../../shared/machine-words'
import type { MachineBlock } from '../relay-machine-call'

/**
 * A MACHINE THE ZOOM VIEW CANNOT GO INTO, SAID AS THE ONE THING TO DO (owner
 * 2026-11-10). The account's machines trust each other, so "open it on that
 * machine" is never the answer: what is missing is a step here, and the
 * sentence names it.
 *
 *   desktop  this machine relays with a machine key; without its one proof it holds none
 *   page     a page served through cookrew.dev enters each machine with the account's pass
 *   none     a page reached by a machine's own address holds no account at all
 */

export interface WhyContext {
  readonly surface: 'desktop' | 'page' | 'none'
  /** Desktop: has this machine given its one proof (main · MACHINE_TRUSTED_FILE); null where unknown. */
  readonly trusted: boolean | null
  /** A page: what stood in the way the last time it asked (relay-machine-call.ts). */
  readonly block: MachineBlock | null
  /** This machine's platform, for the button's own words. */
  readonly platform?: string
}

export function machineWhyWords(machine: { readonly name: string; readonly online: boolean }, ctx: WhyContext): string {
  const { name } = machine
  if (!machine.online) return `${name} is offline. It opens here once it is back.`
  if (ctx.surface === 'none') return `Open cookrew.dev/me to go into ${name} from here.`
  if (ctx.surface === 'desktop' && ctx.trusted === false) {
    return `Press “${machineCopy('Sign this Mac in again to see your other machines', ctx.platform ?? 'darwin')}” above, and ${name} opens here.`
  }
  switch (ctx.block?.kind) {
    case 'needs-proof':
      return `Prove it’s you once at cookrew.dev/me (password or passkey), and ${name} opens here.`
    case 'no-device':
      return `Sign this browser in at cookrew.dev/me, and ${name} opens here.`
    case 'refused':
      return `${name}: ${ctx.block.message}`
    case 'offline':
      return `${name} isn’t answering right now. Try again in a moment.`
    default:
      return `${name} isn’t answering yet. It opens as soon as it does.`
  }
}
