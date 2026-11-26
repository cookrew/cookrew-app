import type { GuestLeave } from '../../../shared/machine-guest'

/**
 * Why this window came out of another machine without being asked to
 * (MachineGuestView.tsx · the guest's leave), as the one thing to know or do.
 */
export function leftWords(name: string, why: Exclude<GuestLeave, 'devices'>): string {
  if (why === 'no-key') return `${name} can’t be opened yet: this Mac is still fetching its key there. Try again in a moment.`
  if (why === 'key-refused') return `${name} no longer takes this Mac’s key. A new one is fetched on its own; open it again in a moment.`
  return `This Mac’s sign-in has ended, so ${name} can’t be reached. Sign in again from your avatar.`
}
