/**
 * ENTERING A MACHINE WITH THE ACCOUNT, NOT A TOKEN — what both ends agree on.
 *
 * Owner 2026-11-09: "use password/passkey to replace pair token." A phone or
 * browser signed in to the account opens a machine of that account by proving
 * the account's password or one of its passkeys, once per device. The machine
 * then holds that device in its admitted list and every later open is one tap.
 *
 * WHO DECIDES IS THE MACHINE. cookrew.dev's word is never enough: a session
 * cookie, a relay stamp or a registry answer opens nothing on its own. The
 * machine hands out a one-use challenge, the device signs a transcript that
 * names that challenge, its own key and the proof it brings, and the secret is
 * checked HERE, against anchors THE MACHINE holds:
 *
 *   password  sealed to a key the machine made for this challenge alone
 *             (X25519 → HKDF → AES-GCM, the remote unlock's construction), and
 *             checked against the machine's OWN verifier of the account
 *             password (account.json, written when the password was typed on
 *             this machine). cookrew.dev never supplies a password record, so
 *             it cannot hand the machine one it chose.
 *   passkey   a WebAuthn assertion whose challenge is sha256(transcript), so it
 *             is bound to this machine, this challenge and this device's key;
 *             checked against the account's passkeys AS THIS MACHINE PINNED
 *             THEM the first time it read them (account-pair-pins.ts). One the
 *             registry adds later opens nothing until somebody at the machine
 *             runs `cookrew mobile --repin`; one it removes stops opening.
 *
 * WHAT THE REGISTRY IS STILL TRUSTED FOR, said plainly: the first read of the
 * passkeys (pinned on first use), which device keys are the account's (a key
 * alone opens nothing), and the page the phone types into (an altered page is
 * the accepted limit since the remote unlock). It sees the account password at
 * its own sign-in, so a registry that kept one could enter by password; it can
 * never make a passkey answer. The seal key is not signed by the machine: a
 * relay that only READS carries bytes it cannot open; one that ACTS can swap it,
 * which is the same altered-page limit.
 *
 * Both halves import this file, so the transcript cannot be spelled two ways.
 */

/** The label every signature and passkey challenge in this ceremony carries. */
export const ACCOUNT_PAIR_CONTEXT = 'cookrew-pair/1'

/** The seal's label: the per-challenge key seals nothing else. */
export const ACCOUNT_PAIR_INFO = 'account-pair/1'

/** The registry's own ceiling on a password (registry/src/v2-secrets.ts). */
export const ACCOUNT_PAIR_PASSWORD_MAX = 256

/** Three wrong tries for one device, then a rest — the remote unlock's numbers. */
export const ACCOUNT_PAIR_TRIES = 3
export const ACCOUNT_PAIR_REST_MS = 60_000

/**
 * Nine wrong in a row across every device and the whole door rests longer.
 * It never closes for good: a headless machine has nobody to reopen it.
 */
export const ACCOUNT_PAIR_STOP_AFTER = 9
export const ACCOUNT_PAIR_STOP_MS = 15 * 60_000
/** Each stop after the first, with no entry between, lasts twice the last — up to this. */
export const ACCOUNT_PAIR_STOP_MAX_MS = 4 * 60 * 60_000

/** Long enough to type a password on a phone, short enough to be fresh. */
export const ACCOUNT_PAIR_CHALLENGE_MS = 120_000

export type PairMethod = 'password' | 'passkey'

export const PAIR_PATHS = {
  offer: '/api/pair',
  begin: '/api/pair/begin',
  finish: '/api/pair'
} as const

/**
 * Exactly the bytes the device signs, and the bytes whose sha256 a passkey
 * signs. Built from values the MACHINE chose (its id, the challenge) and the
 * one the device claims (its id), which the machine checks against the key.
 */
export const pairTranscript = (input: {
  readonly desktopId: string
  readonly challengeId: string
  readonly nonce: string
  readonly deviceId: string
}): string =>
  `${ACCOUNT_PAIR_CONTEXT} ${input.desktopId} ${input.challengeId} ${input.nonce} ${input.deviceId}`

/**
 * BEGIN IS SIGNED TOO, so only the device itself can open (and so replace) its
 * challenge: a stranger naming somebody's device id changes nothing.
 */
export const pairBeginMessage = (desktopId: string, deviceId: string, atMs: number): string =>
  `${ACCOUNT_PAIR_CONTEXT} begin ${desktopId} ${deviceId} ${atMs}`

/** GET /api/pair — may this machine be entered with the account, and how. */
export interface PairOffer {
  readonly offered: boolean
  /** False when the machine could not read the account just now: not "no secret". */
  readonly reachable: boolean
  readonly desktopId: string | null
  /** process.platform of the machine, so the page can say "this machine" rightly. */
  readonly platform: string
  readonly methods: readonly PairMethod[]
}

/** POST /api/pair/begin → one challenge, for one device, used once. */
export interface PairChallenge {
  readonly challengeId: string
  readonly nonce: string
  readonly desktopId: string
  /** The machine's one-use X25519 public key (SPKI, base64url) for the sealed password. */
  readonly key: string
  readonly expiresAt: number
  readonly methods: readonly PairMethod[]
  /** Null when the account has no passkey the machine can check. */
  readonly passkey: {
    readonly rpId: string
    /** base64url(sha256(transcript)). */
    readonly challenge: string
    /** Credential ids, base64url: only the account's own passkeys are offered. */
    readonly allow: readonly string[]
  } | null
}

export interface PairDevice {
  readonly deviceId: string
  readonly jwk: Record<string, unknown>
  readonly name?: string
}

export interface PasskeyAssertionWire {
  readonly id: string
  readonly clientDataJSON: string
  readonly authenticatorData: string
  readonly signature: string
}

export type PairProof =
  | { readonly kind: 'password'; readonly sealed: string }
  | { readonly kind: 'passkey'; readonly credential: PasskeyAssertionWire }

/**
 * THE PROOF IS SIGNED TOO. The device signs `<transcript> <sha256(proof)>`, so
 * nobody between the phone and the machine can put a guess of their own under
 * the device's signature.
 */
export const pairProofDigestInput = (proof: PairProof): string =>
  proof.kind === 'password'
    ? `password ${proof.sealed}`
    : `passkey ${proof.credential.id} ${proof.credential.clientDataJSON} ${proof.credential.authenticatorData} ${proof.credential.signature}`

export const pairDeviceMessage = (transcript: string, proofDigest: string): string => `${transcript} ${proofDigest}`

/** POST /api/pair. `sig` is the device key's signature over pairDeviceMessage. */
export interface PairFinish {
  readonly challengeId: string
  readonly device: PairDevice
  readonly sig: string
  readonly proof: PairProof
}

export type PairOutcome = 'admitted' | 'wrong' | 'resting' | 'refused' | 'unavailable'

export type PairAnswer =
  | {
      readonly ok: true
      readonly outcome: 'admitted'
      readonly deviceId: string
      readonly desktopId: string
      readonly token: string
      readonly name?: string
    }
  | {
      readonly ok: false
      readonly outcome: Exclude<PairOutcome, 'admitted'>
      readonly error: string
      readonly triesLeft?: number
      readonly retryAfterMs?: number
    }

/**
 * THE MACHINE ASKS THE REGISTRY FOR THE ACCOUNT'S ANCHORS WITH ITS KEY, not its
 * bearer alone. The answer holds the password's scrypt record, so a bearer that
 * leaked into a log must not be enough to read it: the request also carries a
 * signature by the desktop's device key over this line, fresh within the skew.
 */
export const ANCHORS_PATH = '/v2/me/pair-anchors'
export const ANCHORS_PROOF_HEADER = 'x-cookrew-proof'
export const ANCHORS_SKEW_MS = 120_000
export const anchorsProofMessage = (deviceId: string, atMs: number): string =>
  `cookrew-anchors/1 ${deviceId} ${atMs}`

/** The padded size of what is sealed, in bytes: above the longest password, escaped. */
const SEALED_BYTES = 6 * ACCOUNT_PAIR_PASSWORD_MAX + 128

/**
 * What is sealed: the challenge it answers, the password, and padding to one
 * size IN BYTES after JSON escaping, so the ciphertext says nothing about the
 * password's length.
 */
export const sealedPasswordPlaintext = (challengeId: string, password: string): string => {
  const bare = JSON.stringify({ c: challengeId, p: password, z: '' })
  const used = new TextEncoder().encode(bare).length
  return JSON.stringify({ c: challengeId, p: password, z: '0'.repeat(Math.max(0, SEALED_BYTES - used)) })
}
