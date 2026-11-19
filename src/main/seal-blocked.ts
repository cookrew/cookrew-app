import type { SealTerminus } from './canvas-seal-terminus'
import type { PairDoorDeps } from './account-pair'
import type { MachineKeyStore, MachineRow, RefusedMachines } from './machine-keys'
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
 * Devices → Forget. Info (Relay round 4, F4/F5): a forgotten machine is never
 * taken off RefusedMachines (there is no removal), so a block, once also written
 * there, outlives a later SAME for its machine pass; and the relay line's refusal
 * keys on the device the RELAY names, so it is defence in depth only: the door,
 * the dropped admission and the sealed lane are what hold.
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
    // Not this owner's desktop, whatever the listing says: every open session ends first, in memory, whatever a
    // write below does; then it is refused from now on, each write tried on its own (Relay round 4, F2).
    deps.peers.closePeer(deviceId)
    deps.terminus.endPeer(deviceId, 'a desktop the owner did not recognise')
    const written = [
      tried(() => deps.pins.block(deviceId)),
      tried(() => deps.forgetAdmission(deviceId)),
      tried(() => deps.forgetKey(deviceId)),
      tried(() => deps.refuseMachine(deviceId))
    ]
    return written.every(Boolean)
  } else return false
  return true
}

/**
 * At launch: a blocked desktop's admission and key, left from a block made before they went with it (an older
 * build, or a write that failed), go now, and it is a forgotten machine too, so the pins file is not its only record.
 */
export function forgetBlocked(pins: Pick<SealPinStore, 'blocked'>, deps: Pick<PeerAnswerDeps, 'forgetAdmission' | 'forgetKey' | 'refuseMachine'>): string[] {
  const ids = pins.blocked()
  for (const id of ids) {
    tried(() => deps.forgetAdmission(id))
    tried(() => deps.forgetKey(id))
    tried(() => deps.refuseMachine(id))
  }
  return ids
}

export interface DesktopHoldingsDeps {
  readonly admitted: { forget(deviceId: string): boolean }
  /** The remote desk's grants, by viewer key. */
  readonly desk: { forgetDevice(key: string): void }
  /** Passwords remembered for it on a console (unlock-remembered.ts). */
  readonly remembered: { forgetWho(who: string): void }
  forgetKey(deviceId: string): void
}

/**
 * What a desktop the owner said is NOT THE SAME holds here, as answerPeer and the launch sweep take it: its admission,
 * the remote-desk grants on it and the passwords remembered for it (forgetAdmission), and the key held for it
 * (forgetKey). The shape other lanes hook (magpie-remote/blocked.ts) stays these two.
 */
export function blockedDesktopHoldings(deps: DesktopHoldingsDeps): Pick<PeerAnswerDeps, 'forgetAdmission' | 'forgetKey'> {
  return {
    forgetAdmission: (deviceId) => {
      const gone = deps.admitted.forget(deviceId)
      deps.desk.forgetDevice(`device:${deviceId}`)
      const idsDropped = tried(() => deps.remembered.forgetWho(`device:${deviceId}`))
      return gone && idsDropped
    },
    forgetKey: (deviceId) => deps.forgetKey(deviceId)
  }
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

export interface BlockedLaneStores {
  readonly pins: Pick<SealPinStore, 'blocks'>
  readonly marks: SealMarks
  readonly keys: MachineKeyStore
  /** Machines forgotten here (machine-keys.ts · RefusedMachines). */
  readonly forgotten: Pick<RefusedMachines, 'has'>
}

export interface BlockedLanes {
  /** The relay line's marks, a blocked desktop refused in the clear. */
  readonly marks: SealMarks
  /** The machine keys, none used or kept for a blocked desktop. */
  readonly keys: MachineKeyStore
  /** The door's two refusals (account-pair.ts): a forgotten machine's machine pass, and a blocked desktop's every pass. */
  readonly door: Required<Pick<PairDoorDeps, 'refusedMachine' | 'refusedDevice'>>
  /** The account's desktops, a blocked one never sent a pass. */
  desktops(rows: readonly MachineRow[] | null): MachineRow[] | null
  /** A key round for a machine with none, never for a blocked one. */
  askForKey(collect: () => void): (machineId: string) => void
}

/**
 * EVERY PLAIN LANE, WITH A BLOCKED DESKTOP KEPT OFF IT, built once: index.ts makes one call and uses what this
 * returns, so a regression in the wiring is one here, where it is tested (Relay round 4, S11-S13).
 */
export function createBlockedLanes(stores: BlockedLaneStores): BlockedLanes {
  const { pins } = stores
  return {
    marks: marksWithBlocked(stores.marks, pins),
    keys: keysWithoutBlocked(stores.keys, pins),
    door: { refusedMachine: (deviceId) => stores.forgotten.has(deviceId), refusedDevice: (deviceId) => pins.blocks(deviceId) },
    desktops: (rows) => desktopsWithoutBlocked(rows, pins),
    askForKey: (collect) => askForKey(pins, collect)
  }
}
