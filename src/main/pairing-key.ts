import { randomBytes as nodeRandomBytes } from 'node:crypto'

/**
 * The desktop's pairing key: six characters, rotating every two minutes, shown
 * beside the QR in the pairing popout.
 *
 * The key answers one question only — "is the person typing this looking at MY
 * screen right now" — so it is short enough to read aloud and short-lived
 * enough that reading it once buys nothing later. Authorisation is a separate
 * question, answered by the canvas token the phone carries from cookrew.dev.
 *
 * ROTATION AND THE OVERLAP. A phone that reads the key at 1:59 is typing it at
 * 2:01, by which time the popout has rotated. So the key it replaced stays
 * acceptable for exactly as long as its replacement lives: current is good
 * until it expires, previous is good until current does. Two keys are live at
 * any instant and never more.
 *
 * An expired current is NOT resurrected as previous. Rotation happens when the
 * popout asks for the key, so a closed popout leaves a key that simply dies —
 * calling `accepts` must never be able to revive it.
 */

/** No I, O, 0 or 1: the six characters get read off a screen and typed. */
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export const PAIRING_KEY_LENGTH = 6

export const PAIRING_KEY_TTL_MS = 2 * 60 * 1000

export type PairingKey = {
  readonly key: string
  readonly mintedAt: number
  readonly expiresAt: number
}

export type PairingKeyRing = {
  /** The key to show, minting or rotating first if the last one has run out. */
  readonly current: () => PairingKey
  /** True for the live key and for the one it replaced. Never mutates. */
  readonly accepts: (key: string) => boolean
  /** Forget both keys — the popout closed. */
  readonly reset: () => void
}

export type PairingKeyRingDeps = {
  readonly now?: () => number
  readonly randomBytes?: (size: number) => Uint8Array
}

/**
 * The alphabet is 32 long, so one byte masked to five bits picks a character
 * with no modulo bias at all.
 */
const keyFromBytes = (bytes: Uint8Array): string =>
  Array.from(bytes.slice(0, PAIRING_KEY_LENGTH), (b) => PAIRING_ALPHABET[b & 31]).join('')

/** Read off a screen: spaces and dashes creep in, and shift is a coin toss. */
export const normalizePairingKey = (raw: string): string =>
  raw.replace(/[\s-]+/g, '').toUpperCase()

export const createPairingKeyRing = (deps: PairingKeyRingDeps = {}): PairingKeyRing => {
  const now = deps.now ?? Date.now
  const randomBytes = deps.randomBytes ?? ((size: number) => new Uint8Array(nodeRandomBytes(size)))

  let current: PairingKey | null = null
  let previous: PairingKey | null = null

  const mint = (at: number): PairingKey => ({
    key: keyFromBytes(randomBytes(PAIRING_KEY_LENGTH)),
    mintedAt: at,
    expiresAt: at + PAIRING_KEY_TTL_MS
  })

  return {
    current: () => {
      const at = now()
      if (!current || at >= current.expiresAt) {
        previous = current
        current = mint(at)
      }
      return current
    },
    accepts: (raw: string) => {
      const at = now()
      const typed = normalizePairingKey(raw)
      if (typed.length !== PAIRING_KEY_LENGTH) return false
      if (!current || at >= current.expiresAt) {
        // An expired current is nobody's key, and it does not promote the one
        // before it either — see the rotation note above.
        return !!current && typed === current.key && at < current.expiresAt
      }
      if (typed === current.key) return true
      // THE REPLACED KEY LIVES EXACTLY AS LONG AS ITS REPLACEMENT, measured
      // from the replacement rather than from itself. Those are the same
      // instant only when rotation happened the moment the old key ran out —
      // and it does not, because rotation is lazy: a popout reopened three
      // minutes later mints then, and `previous.expiresAt + TTL` would have
      // been in the past while the docblock promised the window was open.
      return !!previous && typed === previous.key && at < current.expiresAt
    },
    reset: () => {
      current = null
      previous = null
    }
  }
}
