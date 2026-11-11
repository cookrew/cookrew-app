/**
 * WHAT THE PHONE CAN SAY ABOUT ITS OWN NETWORK, AND WHEN IT MOVED.
 *
 * Owner 2026-11-11, Android on 5G: the console should settle on the relay at
 * once. It raced the Mac's LAN instead, every probe timed out, the badge sat
 * on PROBING, and a direct link opened on the Wi-Fi went on carrying every
 * request after the phone left that Wi-Fi.
 *
 * Android Chrome names the network type (`navigator.connection.type`); Safari
 * and desktop Chrome name none, and there the switcher races as it always did.
 * A move from Wi-Fi to a radio changes the type and fires no `online`; the
 * connection's 'change' also fires for every new bandwidth estimate, which is
 * not a move, so only a change of TYPE counts.
 */

import type { DataPlane } from '../data-plane'

/** The part of `navigator.connection` this reads. */
export interface ConnectionLike {
  type?: string
  addEventListener?: (event: string, listener: () => void) => void
  removeEventListener?: (event: string, listener: () => void) => void
}

/** This browser's connection, where it has one. */
export const browserConnection = (): ConnectionLike | undefined => {
  try {
    return (navigator as Navigator & { connection?: ConnectionLike }).connection
  } catch {
    return undefined
  }
}

/** On a radio no LAN is in reach: the Mac's LAN names and its WebRTC host candidates are not tried. */
export const onCellular = (connection: ConnectionLike | undefined = browserConnection()): boolean =>
  connection?.type === 'cellular'

export interface NetworkMoveSources {
  readonly connection: ConnectionLike | undefined
  /** window's events, as `listen` elsewhere. */
  readonly on: (event: string, listener: () => void) => () => void
}

/** Call `moved` when the phone changed networks: a new connection type, or online/offline. */
export const watchNetworkMoves = (moved: () => void, sources: NetworkMoveSources): (() => void) => {
  const { connection } = sources
  let type = connection?.type
  const changed = (): void => {
    const next = connection?.type
    if (next === type) return
    type = next
    moved()
  }
  connection?.addEventListener?.('change', changed)
  const offs = [sources.on('online', moved), sources.on('offline', moved)]
  return () => {
    connection?.removeEventListener?.('change', changed)
    offs.forEach((off) => off())
  }
}

export interface LeaveDeps {
  readonly plane: () => DataPlane
  readonly link: () => { close: (reason?: string) => void } | null
  readonly fallBack: () => void
}

/**
 * A direct plane is let go the moment the network moves: it was proved on the
 * last one. The relay never went away, so this costs nothing, and a race right
 * after puts the phone back on a direct path in about a second where one is
 * still there. Waiting for the heartbeat instead was 5-15 s of every request
 * going down a path that no longer exists. No hold: the plane did not fail.
 */
export const leaveDirectPlane = (deps: LeaveDeps, reason: string): boolean => {
  if (deps.plane().kind === 'relay') return false
  deps.link()?.close(reason)
  if (deps.plane().kind !== 'relay') deps.fallBack()
  return true
}
