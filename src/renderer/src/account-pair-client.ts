import {
  ACCOUNT_PAIR_INFO,
  ACCOUNT_PAIR_PASSWORD_MAX,
  PAIR_PATHS,
  pairTranscript,
  sealedPasswordPlaintext,
  type PairAnswer,
  type PairChallenge,
  type PairMethod,
  type PairOffer,
  type PasskeyAssertionWire
} from '../../shared/account-pair'
import type { AccountDevice } from './account-device'
import { sealForMac } from './use/unlock-seal'

/**
 * THE PHONE'S HALF OF ENTERING WITH THE ACCOUNT (shared/account-pair.ts).
 *
 * One entry, in order: ask the machine for a challenge, sign the transcript
 * with this browser's account device key, bring ONE secret — the password
 * sealed to the challenge's key, or a passkey's assertion over the transcript's
 * hash — and keep the token the machine hands back. Nothing is stored before
 * the machine says yes, and the password is never kept at all.
 *
 * Everything outside the browser is injected (fetch, the device, WebAuthn), so
 * the order is tested in node against the real machine door.
 */

export interface PairClientDeps {
  /** fetch, already aimed at this machine's base (`clientBase()`). */
  readonly post: (path: string, body: unknown) => Promise<{ status: number; body: unknown }>
  readonly get: (path: string) => Promise<{ status: number; body: unknown }>
  readonly device: () => Promise<AccountDevice | null>
  /** navigator.credentials.get, or null where WebAuthn is not there. */
  readonly passkey: ((options: CredentialRequestOptions) => Promise<Credential | null>) | null
}

export type EnterResult =
  | { readonly kind: 'entered'; readonly token: string; readonly desktopId: string }
  | { readonly kind: 'no-device' }
  | { readonly kind: 'refused'; readonly message: string; readonly triesLeft?: number; readonly retryAfterMs?: number }
  | { readonly kind: 'cancelled' }

const encoder = new TextEncoder()

const b64u = (bytes: ArrayBuffer | Uint8Array): string => {
  let text = ''
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const unb64u = (text: string): Uint8Array<ArrayBuffer> => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4)
  const raw = atob(padded)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const messageOf = (body: unknown, fallback: string): string =>
  isRecord(body) && typeof body.error === 'string' ? body.error : fallback

const refusedFrom = (body: unknown, fallback: string): EnterResult => ({
  kind: 'refused',
  message: messageOf(body, fallback),
  ...(isRecord(body) && typeof body.triesLeft === 'number' ? { triesLeft: body.triesLeft } : {}),
  ...(isRecord(body) && typeof body.retryAfterMs === 'number' ? { retryAfterMs: body.retryAfterMs } : {})
})

/** May this machine be entered with the account, and how. Null when it cannot say. */
export async function pairOffer(deps: Pick<PairClientDeps, 'get'>): Promise<PairOffer | null> {
  try {
    const answer = await deps.get(PAIR_PATHS.offer)
    if (answer.status !== 200 || !isRecord(answer.body)) return null
    const body = answer.body
    const methods = Array.isArray(body.methods) ? body.methods.filter((m): m is PairMethod => m === 'password' || m === 'passkey') : []
    return {
      offered: body.offered === true && methods.length > 0,
      desktopId: typeof body.desktopId === 'string' ? body.desktopId : null,
      platform: typeof body.platform === 'string' ? body.platform : 'unknown',
      methods
    }
  } catch {
    return null
  }
}

const readChallenge = (body: unknown): PairChallenge | null => {
  if (!isRecord(body)) return null
  const { challengeId, nonce, desktopId, key, expiresAt } = body
  if (typeof challengeId !== 'string' || typeof nonce !== 'string' || typeof desktopId !== 'string') return null
  if (typeof key !== 'string' || typeof expiresAt !== 'number') return null
  return body as unknown as PairChallenge
}

const wireAssertion = (credential: Credential | null): PasskeyAssertionWire | null => {
  const held = credential as PublicKeyCredential | null
  const response = held?.response as AuthenticatorAssertionResponse | undefined
  if (!held || !response || !('authenticatorData' in response)) return null
  return {
    id: held.id,
    clientDataJSON: b64u(response.clientDataJSON),
    authenticatorData: b64u(response.authenticatorData),
    signature: b64u(response.signature)
  }
}

/**
 * ENTER. `password` for the typed way, null for the passkey. A passkey the
 * person dismissed is `cancelled`, not a refusal: nothing was asked of the
 * machine, and no try was spent.
 */
export async function enterWithAccount(deps: PairClientDeps, password: string | null): Promise<EnterResult> {
  const device = await deps.device()
  if (device === null) return { kind: 'no-device' }
  if (password !== null && (password.length === 0 || password.length > ACCOUNT_PAIR_PASSWORD_MAX)) {
    return { kind: 'refused', message: 'Type the account password.' }
  }
  const begun = await deps.post(PAIR_PATHS.begin, { deviceId: device.id })
  const challenge = begun.status === 200 ? readChallenge(begun.body) : null
  if (challenge === null) return refusedFrom(begun.body, 'This machine did not start an entry. Try again.')
  const transcript = pairTranscript({ desktopId: challenge.desktopId, challengeId: challenge.challengeId, nonce: challenge.nonce, deviceId: device.id })
  let proof: { kind: 'password'; sealed: string } | { kind: 'passkey'; credential: PasskeyAssertionWire }
  if (password !== null) {
    proof = { kind: 'password', sealed: await sealForMac(challenge.key, sealedPasswordPlaintext(challenge.challengeId, password), ACCOUNT_PAIR_INFO) }
  } else {
    if (challenge.passkey === null || deps.passkey === null) return { kind: 'refused', message: 'This account has no passkey this browser can use. Type the password instead.' }
    let credential: Credential | null
    try {
      credential = await deps.passkey({
        publicKey: {
          challenge: unb64u(challenge.passkey.challenge),
          rpId: challenge.passkey.rpId,
          allowCredentials: challenge.passkey.allow.map((id) => ({ type: 'public-key' as const, id: unb64u(id) })),
          userVerification: 'required',
          timeout: 60_000
        }
      })
    } catch {
      return { kind: 'cancelled' }
    }
    const wire = wireAssertion(credential)
    if (wire === null) return { kind: 'cancelled' }
    proof = { kind: 'passkey', credential: wire }
  }
  const sig = b64u(await device.sign(encoder.encode(transcript)))
  const finished = await deps.post(PAIR_PATHS.finish, {
    challengeId: challenge.challengeId,
    device: { deviceId: device.id, jwk: device.jwk, name: device.name },
    sig,
    proof
  })
  const answer = finished.body as PairAnswer | null
  if (finished.status === 200 && answer !== null && answer.ok === true && typeof answer.token === 'string') {
    return { kind: 'entered', token: answer.token, desktopId: answer.desktopId }
  }
  return refusedFrom(finished.body, 'This machine did not take that. Try again.')
}

/** The browser's own wiring: plain fetch at `base`, no credential on the request. */
export function browserPairDeps(base: string, device: () => Promise<AccountDevice | null>): PairClientDeps {
  const read = async (response: Response): Promise<{ status: number; body: unknown }> => {
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return { status: response.status, body }
  }
  const credentials = typeof navigator !== 'undefined' ? navigator.credentials : undefined
  return {
    get: async (path) => read(await fetch(`${base}${path}`, { cache: 'no-store', credentials: 'same-origin' })),
    post: async (path, body) =>
      read(
        await fetch(`${base}${path}`, {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
      ),
    device,
    passkey:
      credentials && typeof globalThis.PublicKeyCredential === 'function'
        ? (options) => credentials.get(options)
        : null
  }
}
