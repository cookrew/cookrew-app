import type { LocalNetworkState } from './local-network'

/**
 * THE ONE PLACE THAT KNOWS WHETHER THE BROWSER WILL LET US IN.
 *
 * Three parties need this fact and none of them can own it: the plane switcher
 * decides whether to race on it, the badge decides which sentence to say on
 * it, and the explainer row is the only surface allowed to CHANGE it. So it is
 * the same shape as path-link.ts — a value, a set of listeners, and a
 * subscribe — and for the same reason: the thing that feeds it is not React.
 *
 * THE ASK IS AN OFFER, NOT A CAPABILITY. `offerLocalNetwork` is called by the
 * switcher's wiring once it knows a trusted name worth probing, and until then
 * the row renders nothing. A button that raises a permission prompt with no
 * address to aim it at would spend the one ask a reader will ever grant on a
 * request that cannot succeed — and a dismissed prompt is a refusal that
 * persists.
 */

/**
 * THE PRESS SPENDS THE ASK, AND THE PAGE REMEMBERS IT.
 *
 * THE INCIDENT: the owner's Android, Chrome 155, 2026-11-02. Every press sent
 * the annotated probe at the Mac's LAN name, the name timed out from that
 * phone, Chrome never reached an address it could ask about, and the
 * permission read 'prompt' again — so the row stayed, its button greyed for
 * the ask's whole deadline and then lit again, a control that visibly did
 * nothing. A press is the reader's answer whatever the browser makes of it:
 * granted hides the row anyway, denied has its own sentence, and a 'prompt'
 * that raised no dialog has nothing left to offer.
 *
 * Kept in localStorage because the companion reloads often and a dead button
 * that returns on every load is the same complaint. It expires after a month:
 * a browser update resets the permission (Chrome 143 → 155 did), and a network
 * that changed may let the next press raise a real dialog.
 */
export const LOCAL_NETWORK_ASKED_KEY = 'cookrew.localNetwork.askedAt'
export const LOCAL_NETWORK_ASK_AGAIN_MS = 30 * 24 * 60 * 60 * 1000

const storage = (): Storage | null => {
  try {
    const store = (globalThis as { localStorage?: Storage }).localStorage
    return store && typeof store.getItem === 'function' ? store : null
  } catch {
    // Storage can throw on access (private modes, sandboxed frames).
    return null
  }
}

const readAsked = (): boolean => {
  try {
    const at = Number(storage()?.getItem(LOCAL_NETWORK_ASKED_KEY) ?? NaN)
    return Number.isFinite(at) && Date.now() - at < LOCAL_NETWORK_ASK_AGAIN_MS
  } catch {
    return false
  }
}

const writeAsked = (): void => {
  try {
    storage()?.setItem(LOCAL_NETWORK_ASKED_KEY, String(Date.now()))
  } catch {
    // Remembered for the life of the page only; the press still counts.
  }
}

let state: LocalNetworkState = 'unsupported'
let ask: (() => Promise<void>) | null = null
let asked = readAsked()
const listeners = new Set<(next: LocalNetworkState) => void>()

const tell = (): void => {
  for (const listener of listeners) listener(state)
}

export const localNetworkGate = (): LocalNetworkState => state

/** True once the switcher has somewhere to point the ask. */
export const localNetworkOffered = (): boolean => ask !== null

export const setLocalNetwork = (next: LocalNetworkState): void => {
  if (state === next) return
  state = next
  tell()
}

/** True once the reader pressed ALLOW (this page, or within the last month). */
export const localNetworkAsked = (): boolean => asked

/** Register the ask for the life of the switcher; call the result to drop it. */
export const offerLocalNetwork = (handler: () => Promise<void>): (() => void) => {
  ask = handler
  tell()
  return () => {
    if (ask === handler) ask = null
  }
}

/**
 * The reader pressed ALLOW. Exactly one attempt, and never a retry.
 *
 * The press is recorded BEFORE the probe, so the row is gone on the press and
 * not after a deadline that, on a name the phone cannot reach, is 30 s.
 *
 * A rejection is swallowed on purpose: the handler's whole job is to update
 * this store, so a failure has already been recorded as whatever the
 * permission store now says, and there is nothing a caller could usefully do.
 */
export const acceptLocalNetwork = async (): Promise<void> => {
  const handler = ask
  if (!handler) return
  asked = true
  writeAsked()
  tell()
  try {
    await handler()
  } catch {
    // Left as whatever the permission store last said.
  }
}

export const subscribeLocalNetwork = (
  listener: (next: LocalNetworkState) => void
): (() => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Test seam: the module is a singleton and a test needs a clean one. */
export const resetLocalNetworkGate = (): void => {
  state = 'unsupported'
  ask = null
  asked = false
  try {
    storage()?.removeItem(LOCAL_NETWORK_ASKED_KEY)
  } catch {
    // Nothing stored, or nowhere to store it.
  }
  listeners.clear()
}
