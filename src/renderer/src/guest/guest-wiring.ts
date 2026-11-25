/**
 * THE GUEST, WIRED (shared/machine-guest.ts): another machine of the account,
 * drawn in this desktop's window as the console draws it.
 *
 * Importing this module is what makes the page the guest, exactly as importing
 * console/console-wiring.ts makes a page the console: it is the FIRST import of
 * the renderer's entry (main.tsx), so before anything else on the page asks
 * which kind of page it is, the answer is "a console page with this one machine
 * in scope". Its relay is this page's own origin, where main carries every
 * `/api/m…` down the account's relay and adds the account session there
 * (main/machine-guest.ts); the session asked for here is a stand-in main drops.
 *
 * It is the guest only on the guest's own scheme, in a page with no bridge to
 * main (the desktop's window has one), and with the boot line main wrote into
 * the page for the very machine its address names. Anywhere else it makes
 * nothing and `guestParts` is null.
 */
import { MACHINE_GUEST_SCHEME, guestEntryOf, guestMachineOf, guestThemeOf, parseGuestBoot, type GuestEntry } from '../../../shared/machine-guest'
import { configureMachineScope, enterMachine } from '../machine-scope'
import { authStore } from '../auth-gate'
import { guestBridge } from './guest-bridge'

export interface GuestParts {
  readonly machine: string
  /** Where the window asked the guest to open. */
  readonly entry: GuestEntry
  /** The theme the window wore when it opened the guest. */
  readonly theme: string | null
  /** False when this desktop held no key for the machine yet: nothing can be read there. */
  readonly keyHeld: boolean
}

/** The account session this page asks the relay with: a stand-in, dropped and replaced by main. */
export const GUEST_SESSION = 'desktop'

/** What the guest needs of its page, handed in so the boot runs in a test. */
export interface GuestPage {
  readonly protocol: string
  readonly origin: string
  readonly href: string
  readonly search: string
  /** The window's preload bridge, if this page has one (the desktop's own window). */
  readonly bridge: unknown
  /** Main's boot line (main/machine-guest.ts · guestBootScript): read once, then taken off the page. */
  takeBoot(): unknown
}

export function wireGuest(page: GuestPage): GuestParts | null {
  if (page.bridge !== undefined || page.protocol !== `${MACHINE_GUEST_SCHEME}:`) return null
  const boot = parseGuestBoot(page.takeBoot())
  if (boot === null || guestMachineOf(page.href) !== boot.machine) return null
  configureMachineScope({
    relay: {
      origin: page.origin,
      session: () => GUEST_SESSION,
      // The relay turned the account's session away: this desktop is signed out, and the window says so.
      refused: () => guestBridge()?.report({ kind: 'leave', why: 'signed-out' })
    }
  })
  enterMachine(boot.machine)
  // Before anything asks that machine anything: its key, where the store for it looks (auth-gate.ts).
  if (boot.key !== null) authStore().save(boot.key)
  return { machine: boot.machine, entry: guestEntryOf(page.search), theme: guestThemeOf(page.search), keyHeld: boot.key !== null }
}

function browserPage(): GuestPage | null {
  if (typeof window === 'undefined') return null
  const holder = window as { cookrew?: unknown; COOKREW_GUEST?: unknown }
  return {
    protocol: window.location.protocol,
    origin: window.location.origin,
    href: window.location.href,
    search: window.location.search,
    bridge: holder.cookrew,
    takeBoot: () => {
      const boot = holder.COOKREW_GUEST
      // The key is in it: nothing later on the page may read it there.
      delete holder.COOKREW_GUEST
      return boot
    }
  }
}

const page = browserPage()
export const guestParts: GuestParts | null = page === null ? null : wireGuest(page)
