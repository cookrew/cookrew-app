import type { PairingHandout } from './account-v2'

/**
 * WHAT THE POPOUT PUTS ON THE SCREEN — ONE QR, AND NO SIX CHARACTERS.
 *
 * v2 drew a QR of `cookrew-pair:<deviceId>:<KEY>` beside a six-character key
 * that rotated every two minutes. The key answered "is somebody standing at
 * this Mac", and the phone's authority came from a canvas token cookrew.dev
 * minted for it. That is three moving credentials for one act, and the phone
 * had to be signed in at cookrew.dev before any of it worked.
 *
 * v2.1 has ONE credential — the pairing token the Mac already persists and
 * `cookrew mobile` already prints — and ONE address: the relay URL, with the
 * token in the fragment so cookrew.dev never receives it. So the popout is a
 * QR of exactly the string the terminal prints, and nothing else. Nothing
 * rotates on a clock any more; the token changes only when the owner rotates
 * it, which unpairs every phone at once and is worth saying on the sheet.
 *
 * THE FALLBACK IS THE DIRECT URL, for a Mac with no account: it has nothing to
 * publish and the phone has nothing to sign in to, so the `?token=` address on
 * this Wi-Fi is the only door. It says which one it is showing rather than
 * degrading silently — a QR that quietly stops working off the LAN is the
 * failure the address deck exists to make visible.
 */

/** Enough of the device id to tell two Macs apart, and no more. */
export const deviceIdPrefix = (deviceId: string): string => `${deviceId.slice(0, 8)}…`

export const PAIRING_COPY = {
  RELAY: 'Scan on the phone — this works from any network.',
  DIRECT:
    'Claim a username to pair from anywhere; this QR pairs on this Wi-Fi only.',
  NONE: 'No address to show yet — the phone server is still starting.',
  /** The same sentence `cookrew mobile` ends with, for the same reason. */
  ROTATE:
    'This QR carries the pairing token. `cookrew mobile --rotate` replaces it and unpairs every phone.'
} as const

export type PairingPopoutView = {
  readonly mode: 'relay' | 'direct' | 'none'
  /** The exact string to encode, or null when there is nothing to show. */
  readonly qr: string | null
  readonly sentence: string
  readonly rotateNote: string
  readonly desktopName: string
  /** Only the relay URL names a device; a Mac with no account has no id. */
  readonly deviceIdPrefix: string | null
}

export const pairingPopoutView = (handout: PairingHandout | null): PairingPopoutView => {
  if (!handout) {
    return {
      mode: 'none',
      qr: null,
      sentence: PAIRING_COPY.NONE,
      rotateNote: PAIRING_COPY.ROTATE,
      desktopName: 'This Mac',
      deviceIdPrefix: null
    }
  }
  const relay = handout.via === 'relay'
  return {
    mode: relay ? 'relay' : 'direct',
    qr: handout.url,
    sentence: relay ? PAIRING_COPY.RELAY : PAIRING_COPY.DIRECT,
    rotateNote: PAIRING_COPY.ROTATE,
    desktopName: handout.desktopName,
    deviceIdPrefix: handout.deviceId ? deviceIdPrefix(handout.deviceId) : null
  }
}
