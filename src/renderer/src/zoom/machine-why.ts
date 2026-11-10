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

/**
 * Is the view resting on the devices stop (zoom-path.ts · v −2), where the
 * machines and the button the sentence points "above" at are? Past the midway
 * to the workspaces stop, or in a full view, the sentence is not said
 * (owner screenshot 2026-11-10: it followed into an agent's chat).
 */
export function machineWhyShows(v: number, full: boolean): boolean {
  return !full && v < -1.5
}

export function machineWhyWords(machine: { readonly name: string; readonly online: boolean }, ctx: WhyContext): string {
  const { name } = machine
  if (!machine.online) return `${name} is offline. It opens here once it is back.`
  if (ctx.surface === 'none') return `Open console.cookrew.dev to go into ${name} from here.`
  if (ctx.surface === 'desktop' && ctx.trusted === false) {
    return `Press “${machineCopy('Sign this Mac in again to see your other machines', ctx.platform ?? 'darwin')}” below, and ${name} opens here.`
  }
  switch (ctx.block?.kind) {
    case 'needs-proof':
      return `Prove it’s you once on the console (a passkey, or the account password), and ${name} opens here.`
    case 'no-device':
      return `Sign this browser in on the console, and ${name} opens here.`
    case 'refused':
      return `${name}: ${ctx.block.message}`
    case 'offline':
      return `${name} isn’t answering right now. Try again in a moment.`
    default:
      return `${name} isn’t answering yet. It opens as soon as it does.`
  }
}

/**
 * UNDER A MACHINE'S NAME ON THE DEVICES STOP, when it cannot be read: the one
 * thing to do, in a few words (0.6.0: no machine is ever "listed only"). Null
 * for a machine that is read; its counts stand there instead. The full
 * sentence, with what a press would find, is `machineWhyWords`.
 */
export function machineSays(
  machine: { readonly name: string; readonly online: boolean; readonly detail: 'live' | 'connecting' | 'listed' },
  ctx: Pick<WhyContext, 'surface' | 'trusted' | 'platform'> & { readonly block?: MachineBlock | null }
): string | null {
  if (!machine.online) return `Open Cookrew on ${machine.name}.`
  if (machine.detail === 'live') return null
  if (machine.detail === 'connecting') return 'Reading…'
  // The button is at the foot of the view (ZoomView · zv-trust-bar), under the machines.
  if (ctx.surface === 'desktop' && ctx.trusted === false) return machineCopy('Sign this Mac in again, below, to read it.', ctx.platform ?? 'darwin')
  if (ctx.surface === 'none') return 'Open console.cookrew.dev to read it.'
  // A page that enters machines with the account's pass knows what stood in the way the last time it asked.
  switch (ctx.block?.kind) {
    case 'needs-proof':
      return 'Prove it’s you on the console to read it.'
    case 'no-device':
      return 'Sign this browser in on the console to read it.'
    case 'refused':
      return `${machine.name} says: ${ctx.block.message.slice(0, 120)}`
    default:
      return 'Not answering yet.'
  }
}
