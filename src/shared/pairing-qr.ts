/**
 * WHAT THE POPOUT PUTS ON THE SCREEN.
 *
 * The v2 QR carries the desktop's device id and a rotating six-character key,
 * and NOTHING ELSE — no address, no token, no URL. The phone is already signed
 * in on cookrew.dev when it scans; where this Mac lives is the registry's
 * answer to give, not a string on a screen. That is the whole point of the
 * change: a photograph of this window is worth two minutes of standing in the
 * same room, instead of a permanent credential and a route to the house.
 *
 * The legacy shape is kept for a Mac with no account, because such a Mac has
 * nowhere to publish itself and the phone has nothing to sign in to. There the
 * popout still shows the old URL-with-token QR, and says so plainly.
 */

export const PAIRING_QR_SCHEME = 'cookrew-pair'

export type PairingQrPayload = {
  readonly deviceId: string
  readonly key: string
}

export const pairingQrPayload = ({ deviceId, key }: PairingQrPayload): string =>
  `${PAIRING_QR_SCHEME}:${deviceId}:${key}`

/** The inverse, for the registry page and for tests. Null if it is not ours. */
export const parsePairingQr = (raw: string): PairingQrPayload | null => {
  const parts = raw.trim().split(':')
  if (parts.length !== 3) return null
  const [scheme, deviceId, key] = parts
  if (scheme !== PAIRING_QR_SCHEME) return null
  if (deviceId.length === 0 || key.length === 0) return null
  return { deviceId, key }
}

/** "renews in 1:42" — the countdown beside the key. */
export const renewsIn = (expiresAt: number, now: number): string => {
  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

/** Enough of the device id to tell two Macs apart, and no more. */
export const deviceIdPrefix = (deviceId: string): string => `${deviceId.slice(0, 8)}…`

export const PAIRING_COPY = {
  NO_ACCOUNT:
    'Claim a username to pair through cookrew.dev; this QR pairs on this Wi-Fi only.',
  WRONG_KEY: "Not this Mac's key — it changes every two minutes.",
  NAMED_THE_MAC: 'That link named the Mac, not the phone — open it again from cookrew.dev.',
  ALREADY_USED: 'That link was already used — open it again from cookrew.dev.',
  INSECURE: 'Pair over the secure address — open it again from cookrew.dev.',
  NOT_THIS_MAC: 'This sign-in is not for this Mac — open it again from cookrew.dev.',
  TYPED_KEY: 'Six characters, valid two minutes.'
} as const

export type PairingPopoutView =
  | {
      readonly mode: 'key'
      readonly qr: string
      readonly key: string
      readonly renewsIn: string
      readonly desktopName: string
      readonly deviceIdPrefix: string
    }
  | {
      readonly mode: 'legacy'
      readonly qr: string | null
      readonly sentence: string
      readonly desktopName: string
    }

export type PairingPopoutInput = {
  readonly desktopName: string
  /** Absent when the Mac has no account: there is no device id to name. */
  readonly key: { deviceId: string; key: string; expiresAt: number } | null
  /** The old URL-with-token endpoint, used only in the legacy shape. */
  readonly legacyUrl?: string | null
  readonly now: number
}

export const pairingPopoutView = (input: PairingPopoutInput): PairingPopoutView => {
  if (!input.key) {
    return {
      mode: 'legacy',
      qr: input.legacyUrl ?? null,
      sentence: PAIRING_COPY.NO_ACCOUNT,
      desktopName: input.desktopName
    }
  }
  return {
    mode: 'key',
    qr: pairingQrPayload(input.key),
    key: input.key.key,
    renewsIn: renewsIn(input.key.expiresAt, input.now),
    desktopName: input.desktopName,
    deviceIdPrefix: deviceIdPrefix(input.key.deviceId)
  }
}
