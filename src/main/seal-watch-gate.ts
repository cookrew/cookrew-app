import { keyWords, type DeviceKey, type DeviceSigner } from '../shared/seal2/handshake'
import type { SealMarks } from './seal-marks'
import type { SealWatchKeys } from './seal-watch-keys'
import type { WatchSealReply } from './watch-routes'

/**
 * WHERE A WATCH'S SEALED SESSION MEETS THE REST OF THIS MAC: the decisions
 * index.ts makes about it, here so each one is tested (Relay round 4, C).
 */

/**
 * May a device-mode session reach this route (canvas-seal-terminus.ts · deviceHttp)? Only a watch whose
 * key the owner confirmed here, and only its own routes. Owner ruling 2026-11-19: no route for a desktop
 * peer by default, so any other device, a desktop of the account included, reaches none.
 */
export const watchDeviceHttp =
  (keys: Pick<SealWatchKeys, 'keyOf'>, allowed: (method: string, path: string) => boolean) =>
  (deviceId: string, method: string, path: string): boolean =>
    keys.keyOf(deviceId) !== null && allowed(method, path)

/** The watch was forgotten on this Mac: its keys go, and so do their sealed-only marks, so a watch paired again is not refused in the clear before it seals again. */
export function forgetWatchSeal(keys: Pick<SealWatchKeys, 'forgetAll'>, marks: Pick<SealMarks, 'unmark'>): string[] {
  const ids = keys.forgetAll()
  for (const id of ids) marks.unmark(id)
  return ids
}

export interface WatchSealOfferDeps {
  /** This Mac's account device key; null with no account. */
  self(): Pick<DeviceSigner, 'deviceId' | 'jwk'> | null
  /** Is this id one of the account's desktops? Null when the listing could not be asked (seal-device.ts · listed). */
  listed(deviceId: string): Promise<boolean | null>
  readonly keys: Pick<SealWatchKeys, 'offer'>
}

/**
 * A claim brought a watch's key (watch-routes.ts · handleWatchClaim): keep it pending, and answer this
 * Mac's key, the claim's nonce and the words. A watch's id is never a desktop's: a claim naming this Mac,
 * a desktop of the account, or an id the listing could not be asked about keeps the old way. Unknown
 * fails closed.
 */
export async function offerWatchSeal(deviceId: string, jwk: DeviceKey, deps: WatchSealOfferDeps): Promise<WatchSealReply | null> {
  const self = deps.self()
  if (self === null) return null
  const id = deviceId.toLowerCase()
  if (id === self.deviceId.toLowerCase() || (await deps.listed(id)) !== false) return null
  const nonce = deps.keys.offer(id, jwk)
  if (nonce === null) return null
  // The words go along for an older reader only: the watch computes its own from the keys and the nonce.
  return { deviceId: self.deviceId, jwk: self.jwk, nonce: Buffer.from(nonce).toString('base64url'), words: (await keyWords(jwk, self.jwk, nonce)).words }
}
