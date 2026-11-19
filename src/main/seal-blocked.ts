import type { SealTerminus } from './canvas-seal-terminus'
import type { MachineKeyStore, MachineRow } from './machine-keys'
import type { SealMarks } from './seal-marks'
import type { SealPeers } from './seal-peers'
import type { SealPinStore } from './seal-pins'

/**
 * WHAT THE OWNER'S ANSWER TO ANOTHER DESKTOP'S SIX WORDS DOES (seal-pins.ts),
 * here rather than in index.ts so each part of it is tested.
 *
 * SAME pins that desktop; LATER puts the question off until the next launch and
 * pins nothing; NOT THE SAME blocks it, and a blocked desktop is refused on
 * EVERY lane, not only the sealed one (Relay, round 4, A):
 *
 *   sealed      its sessions both ways end; it is never dialled (seal-peers.ts)
 *               nor let in (seal-device.ts · trusted), as the pins already say.
 *   the door    turns away EVERY pass it brings, a machine pass or the account
 *               pass a password or passkey earns (account-pair.ts ·
 *               refusedDevice), and it is also a forgotten machine
 *               (machine-keys.ts · RefusedMachines), so its machine pass stays
 *               out even if the pins file is lost. The admission it holds goes,
 *               so its key for this Mac stops working on every road; one left
 *               from before (a block made on an older build) goes at launch.
 *   relay line  its plain requests are refused, as a sealed-only device's are.
 *   from here   this Mac uses no key for it, sends it no pass to enter with,
 *               and does not ask cookrew.dev for one each time it is read.
 *
 * Not cut: a plain stream it already holds open ends when it next asks, as with
 * Devices → Forget.
 */

type Blocks = Pick<SealPinStore, 'blocks'>

export type PeerAnswer = 'same' | 'later' | 'not-same'

export interface PeerAnswerDeps {
  readonly pins: Pick<SealPinStore, 'pin' | 'later' | 'block'>
  /** Its sealed session from this desktop. */
  readonly peers: Pick<SealPeers, 'closePeer'>
  /** Its sealed sessions into this desktop. */
  readonly terminus: Pick<SealTerminus, 'endPeer'>
  /** Its admission here (and whatever hangs off it). False when the admission could not be dropped. */
  forgetAdmission(deviceId: string): boolean
  /** The key this desktop holds for it, and what it answered with that key. */
  forgetKey(deviceId: string): void
  /** Kept out as a forgotten machine as well (machine-keys.ts · RefusedMachines). */
  refuseMachine(deviceId: string): void
}

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** One of the writes: a write that throws (a full disk) is one that did not happen, and keeps none of the others from running. */
function tried(write: () => boolean | void): boolean {
  try {
    return write() !== false
  } catch {
    return false
  }
}

/**
 * The IPC answer `seal:peer-answer`. False for anything that is not a device id and one of the three answers,
 * and for a NOT THE SAME one of whose writes failed (the block itself stands; the launch sweep tries again).
 */
export function answerPeer(deviceId: unknown, answer: unknown, deps: PeerAnswerDeps): boolean {
  if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return false
  if (answer === 'same') deps.pins.pin(deviceId)
  else if (answer === 'later') deps.pins.later(deviceId)
  else if (answer === 'not-same') {
    // Not this owner's desktop, whatever the listing says: refused from now on, and every way it is in ends.
    deps.pins.block(deviceId)
    // In memory, first: every open session ends whatever a write below does.
    deps.peers.closePeer(deviceId)
    deps.terminus.endPeer(deviceId, 'a desktop the owner did not recognise')
    const written = [tried(() => deps.forgetAdmission(deviceId)), tried(() => deps.forgetKey(deviceId)), tried(() => deps.refuseMachine(deviceId))]
    return written.every(Boolean)
  } else return false
  return true
}

/** At launch: a blocked desktop's admission and key, left from a block made before they went with it, go now. */
export function forgetBlocked(pins: Pick<SealPinStore, 'blocked'>, deps: Pick<PeerAnswerDeps, 'forgetAdmission' | 'forgetKey'>): string[] {
  const ids = pins.blocked()
  for (const id of ids) {
    tried(() => deps.forgetAdmission(id))
    tried(() => deps.forgetKey(id))
  }
  return ids
}

/** No key held for a machine: ask cookrew.dev for a round, unless it is blocked, for which no round brings one. */
export const askForKey =
  (pins: Blocks, collect: () => void) =>
  (machineId: string): void => {
    if (!pins.blocks(machineId)) collect()
  }

/** The relay line answers a blocked desktop nothing in the clear, whatever the marks say of it. */
export function marksWithBlocked(marks: SealMarks, pins: Blocks): SealMarks {
  return { ...marks, refuses: (deviceId) => marks.refuses(deviceId) || (deviceId !== null && pins.blocks(deviceId)) }
}

/** The keys held for other machines, as if none were held for a blocked one, and none kept for it either. */
export function keysWithoutBlocked(store: MachineKeyStore, pins: Blocks): MachineKeyStore {
  return {
    ...store,
    token: (desktopId) => (pins.blocks(desktopId) ? null : store.token(desktopId)),
    keep: (desktopId, name, token) => {
      if (!pins.blocks(desktopId)) store.keep(desktopId, name, token)
    }
  }
}

/** The account's desktops this one would enter: a blocked one is never sent this desktop's pass. */
export const desktopsWithoutBlocked = (rows: readonly MachineRow[] | null, pins: Blocks): MachineRow[] | null =>
  rows === null ? null : rows.filter((row) => !pins.blocks(row.id))
