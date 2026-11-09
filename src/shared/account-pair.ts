/**
 * ENTERING A MACHINE WITH THE ACCOUNT, NOT A TOKEN — what both ends agree on.
 *
 * Owner's rulings, 2026-11-09 (docs/auth-ux-2026-11-09.html, the green box):
 * entering a device takes the account password or a passkey; ONE verification
 * lets this phone or browser into EVERY machine of the account for twelve
 * hours; a provider-only account sets an account password first.
 *
 * TWO STEPS, TWO PARTIES.
 *
 *   1. cookrew.dev (registry/src/v2-device-grant.ts) checks the password or
 *      passkey and issues a GRANT: a token signed with its key naming the
 *      account, the device and the device's KEY (RFC 7638 thumbprint), good for
 *      twelve hours. The password goes to cookrew.dev over TLS — never through
 *      the relay to a machine.
 *   2. Each machine checks the grant OFFLINE (/v2/keys and the revoked list,
 *      src/main/v2-call-token.ts), hands out a one-use challenge, and admits
 *      the device only on a fresh signature from THAT key over its own
 *      challenge. The admission lasts as long as the grant.
 *
 * WHAT THIS TRUSTS cookrew.dev FOR, said plainly: its signature that the
 * account verified this key. A registry that lied, or anyone with its signing
 * key, could grant a key of its own and enter every machine of the account for
 * twelve hours. WHAT STILL STOPS A STOLEN SESSION: no grant without the password
 * or a passkey; a grant only for the session's own device key; and a browser's
 * key cannot be exported, so a lifted cookie can sign no machine's challenge.
 *
 * Both halves import this file, so the transcript cannot be spelled two ways.
 */

/** The label every signature in this ceremony carries. */
export const ACCOUNT_PAIR_CONTEXT = 'cookrew-pair/2'

/** How long the challenge a machine hands out stays good. */
export const ACCOUNT_PAIR_CHALLENGE_MS = 120_000

/** A grant this close to its end is fetched again rather than spent. */
export const GRANT_MARGIN_MS = 60_000

export const PAIR_PATHS = {
  offer: '/api/pair',
  begin: '/api/pair/begin',
  finish: '/api/pair'
} as const

export const GRANT_PATHS = {
  options: '/v2/me/device-grant/options',
  grant: '/v2/me/device-grant'
} as const

/**
 * Exactly the bytes the device signs: values the MACHINE chose (its id, the
 * challenge) and the device's own id.
 */
export const pairTranscript = (input: {
  readonly desktopId: string
  readonly challengeId: string
  readonly nonce: string
  readonly deviceId: string
}): string =>
  `${ACCOUNT_PAIR_CONTEXT} ${input.desktopId} ${input.challengeId} ${input.nonce} ${input.deviceId}`

/** GET /api/pair — may this machine be entered with the account. */
export interface PairOffer {
  readonly offered: boolean
  readonly desktopId: string | null
  /** process.platform of the machine, so the page can say "this machine" rightly. */
  readonly platform: string
}

/** POST /api/pair/begin { deviceId, jwk, grant } → one challenge, for one device key, used once. */
export interface PairChallenge {
  readonly challengeId: string
  readonly nonce: string
  readonly desktopId: string
  readonly expiresAt: number
}

export interface PairDevice {
  readonly deviceId: string
  readonly jwk: Record<string, unknown>
  readonly name?: string
}

/** POST /api/pair. `sig` is the device key's signature over the transcript. */
export interface PairFinish {
  readonly challengeId: string
  readonly device: PairDevice
  readonly grant: string
  readonly sig: string
}

export type PairOutcome = 'admitted' | 'regrant' | 'resting' | 'refused' | 'unavailable'

export type PairAnswer =
  | {
      readonly ok: true
      readonly outcome: 'admitted'
      readonly deviceId: string
      readonly desktopId: string
      readonly token: string
      /** When this machine stops remembering the device: the grant's own end. */
      readonly until: number
      readonly name?: string
    }
  | {
      readonly ok: false
      /** `regrant`: the grant is no good here (expired, revoked, another key) — get a new one. */
      readonly outcome: Exclude<PairOutcome, 'admitted'>
      readonly error: string
      readonly retryAfterMs?: number
    }

/** What cookrew.dev answers for a grant. */
export interface DeviceGrant {
  readonly grant: string
  readonly exp: number
  readonly deviceId: string
}

/** GRANT_PATHS.options: how this account can prove itself for a grant. */
export interface GrantOptions {
  readonly methods: { readonly password: boolean; readonly passkey: boolean }
  /** A provider-only account with no passkey: it sets an account password first. */
  readonly needsPassword: boolean
  readonly passkey: {
    readonly challenge: string
    readonly rpId: string
    readonly timeout: number
    readonly userVerification: 'required'
    readonly allowCredentials: readonly { readonly type: 'public-key'; readonly id: string }[]
  } | null
}
