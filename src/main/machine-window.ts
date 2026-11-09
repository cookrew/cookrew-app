import { pairingUrl, relayDesktopUrl } from '../shared/pairing-url'

/**
 * WORKING IN ANOTHER MACHINE FROM THIS ONE (owner 2026-11-10), and from it in
 * this one: the other machine's own page, the one a phone uses, opened here in
 * a window of its own. It is that machine's interface at that machine's version,
 * so everything a phone can do there can be done from here.
 *
 * LET IN BY THE KEY THIS MACHINE HOLDS FOR IT (machine-keys.ts), carried in the
 * fragment, which the relay never sees. The relay opens for a cookrew.dev
 * sign-in of the WINDOW'S OWN, made in it once, as on a phone, and kept in a
 * store of that machine's alone, so one machine's page never reads the key
 * this Mac holds for another (security review 2026-11-10). Never this
 * machine's own session: script
 * on the other machine's page would act as this desktop at cookrew.dev — take
 * over its relay line, use its minutes after a sign-in (security review
 * 2026-11-10). No connect code: one handed from machine to machine would cross
 * the relay and be worth nothing, so this line is the relay's, as a printed
 * pairing link's is.
 */

const MACHINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface MachineWindowInput {
  readonly registryOrigin: string
  readonly username: string
  readonly machineId: string
  /** The key this machine holds for that one. */
  readonly key: string
}

/** Where the sign-in pages of the providers live: a window signs in to cookrew.dev through them. */
const PROVIDER_HOSTS = ['github.com', 'accounts.google.com']

export interface MachineWindowPlan {
  readonly url: string
  /** Where the page keeps what it keeps: that machine's own store, apart from this app's and every other machine's. */
  readonly partition: string
  /** The relay address of that machine: the window goes nowhere outside it. */
  readonly home: string
}

export function machineWindowPlan(input: MachineWindowInput): MachineWindowPlan | null {
  const machineId = input.machineId.toLowerCase()
  if (!MACHINE_ID.test(machineId) || input.key.length === 0) return null
  const home = relayDesktopUrl({ registryOrigin: input.registryOrigin, username: input.username, deviceId: machineId })
  const url = pairingUrl({ registryOrigin: input.registryOrigin, username: input.username, deviceId: machineId, pairingToken: input.key })
  if (home === null || url === null) return null
  return { url, partition: `persist:cookrew-machine-${machineId}`, home }
}

/**
 * A place the window may go: cookrew.dev and its own hosts (the machine's page,
 * the sign-in at auth.cookrew.dev, /me), and a provider's sign-in page on the
 * way. Over https only; anything else opens in the owner's browser.
 */
export function allowedInMachineWindow(plan: Pick<MachineWindowPlan, 'home'>, target: string): boolean {
  try {
    const to = new URL(target)
    const registry = new URL(plan.home).hostname
    if (to.protocol !== 'https:') return false
    return to.hostname === registry || to.hostname.endsWith(`.${registry}`) || PROVIDER_HOSTS.includes(to.hostname)
  } catch {
    return false
  }
}
