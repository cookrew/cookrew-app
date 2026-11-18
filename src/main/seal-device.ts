import { deviceIdFor, signWithDevice, verifyWithDevice, type AccountFile } from './account-v2'
import type { SealDeviceDeps } from './canvas-seal-terminus'
import type { DeviceSigner, DeviceVerifier } from '../shared/seal2/handshake'
import { isDeviceKey } from '../shared/seal2/handshake'
import type { SealPinStore } from './seal-pins'
import type { SealWatchKeys } from './seal-watch-keys'

/**
 * THIS DESKTOP'S SIDE OF SEAL2 DEVICE MODE: its account device key as the
 * signer, and who may dial in.
 *
 * WHO MAY DIAL IN: a device id cookrew.dev lists as one of this account's
 * desktops (asked at most once a minute, and once more for an id it has not
 * seen), and, with the pin policy at "pinned", only one the owner pinned. An
 * id the listing cannot be asked about is refused: unknown fails closed. And a
 * watch whose key the owner confirmed here by its words (seal-watch-keys.ts),
 * with that key and no other.
 */

const LISTING_MS = 60_000

export interface SealDeviceInput {
  account(): AccountFile | null
  /** The account's desktops' device ids; null when cookrew.dev could not be asked. */
  desktops(): Promise<readonly string[] | null>
  readonly pins: SealPinStore
  /** Watches whose words the owner confirmed here (seal-watch-keys.ts). */
  readonly watchKeys?: Pick<SealWatchKeys, 'keyOf'>
  now?(): number
}

export interface SealDevice {
  readonly device: SealDeviceDeps
  self(): DeviceSigner | null
}

export const verifyDevice: DeviceVerifier = async (jwk, message, sig) => verifyWithDevice(jwk as unknown as Record<string, unknown>, message, sig)

export function createSealDevice(input: SealDeviceInput): SealDevice {
  const now = input.now ?? Date.now
  let listed: { readonly ids: ReadonlySet<string>; readonly at: number } | null = null

  const self = (): DeviceSigner | null => {
    const account = input.account()
    const { kty, crv, x } = account?.publicKeyJwk ?? {}
    const jwk = { kty, crv, x }
    // Only an Ed25519 account key, and only the one this desktop's id was made from.
    if (account === null || !isDeviceKey(jwk) || deviceIdFor({ ...jwk }) !== account.deviceId) return null
    return { deviceId: account.deviceId, jwk, sign: async (message) => signWithDevice(account, message) }
  }

  const ask = async (): Promise<ReadonlySet<string> | null> => {
    const ids = await input.desktops().catch(() => null)
    if (ids === null) return null
    listed = { ids: new Set(ids.map((id) => id.toLowerCase())), at: now() }
    return listed.ids
  }

  const isListed = async (deviceId: string): Promise<boolean> => {
    const id = deviceId.toLowerCase()
    const fresh = listed !== null && now() - listed.at < LISTING_MS ? listed.ids : null
    if (fresh?.has(id)) return true
    return (await ask())?.has(id) ?? false
  }

  return {
    self,
    device: {
      self,
      verify: verifyDevice,
      // A watch the owner confirmed by its words is the owner's own pin; any other device is the account listing's, and
      // the pins', asked again after the listing: a NOT THE SAME while cookrew.dev was being asked (a relay can stall it) counts.
      trusted: async (deviceId) =>
        self() !== null && (input.watchKeys?.keyOf(deviceId) != null || (input.pins.allows(deviceId) && (await isListed(deviceId)) && input.pins.allows(deviceId))),
      admits: (deviceId) => self() !== null && (input.watchKeys?.keyOf(deviceId) != null || input.pins.allows(deviceId)),
      keyOf: async (deviceId) => input.watchKeys?.keyOf(deviceId) ?? null
    }
  }
}
