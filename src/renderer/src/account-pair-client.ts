import {
  GRANT_MARGIN_MS,
  GRANT_PATHS,
  PAIR_PATHS,
  pairTranscript,
  type DeviceGrant,
  type GrantOptions,
  type PairAnswer,
  type PairOffer
} from '../../shared/account-pair'
import type { AccountDevice } from './account-device'

/**
 * THE PHONE'S HALF OF ENTERING WITH THE ACCOUNT (shared/account-pair.ts).
 *
 * Two steps. PROVE once to cookrew.dev — a passkey, or the account password,
 * sent to the registry itself over TLS (this page IS cookrew.dev; the relay is
 * not involved) — and keep the twelve-hour pass it answers with. Then ENTER
 * any machine of the account: hand it the pass, take its challenge, sign the
 * challenge with this browser's own cookrew.dev key. Within the twelve hours a
 * second machine asks nothing at all.
 *
 * Everything outside the browser is injected (fetch, the device, WebAuthn, the
 * storage), so the order is tested in node against the real machine door.
 */

export interface Http {
  readonly get: (path: string) => Promise<{ status: number; body: unknown }>
  readonly post: (path: string, body: unknown) => Promise<{ status: number; body: unknown }>
}

export interface GrantStore {
  read(): DeviceGrant | null
  write(grant: DeviceGrant): void
  clear(): void
}

export interface PairClientDeps {
  /** fetch at this machine's base (`clientBase()`): through the relay on cookrew.dev. */
  readonly machine: Http
  /** fetch at cookrew.dev itself, with the session cookie. */
  readonly registry: Http
  readonly device: () => Promise<AccountDevice | null>
  /** navigator.credentials.get, or null where WebAuthn is not there. */
  readonly passkey: ((options: CredentialRequestOptions) => Promise<Credential | null>) | null
  readonly grants: GrantStore
  readonly now?: () => number
}

export type ProveResult =
  | { readonly kind: 'granted' }
  | { readonly kind: 'refused'; readonly message: string; readonly triesLeft?: number; readonly retryAfterMs?: number }
  | { readonly kind: 'needs-password' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string }

export type EnterResult =
  | { readonly kind: 'entered'; readonly token: string; readonly desktopId: string; readonly until: number }
  | { readonly kind: 'no-device' }
  /** No pass, or the machine refused it: prove again. */
  | { readonly kind: 'needs-proof' }
  | { readonly kind: 'refused'; readonly message: string; readonly retryAfterMs?: number }
  | { readonly kind: 'failed'; readonly message: string }

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

/** The sentence an answer carries: the registry's `message`, or a machine's `error` sentence. */
const messageOf = (body: unknown, fallback: string): string => {
  if (!isRecord(body)) return fallback
  if (typeof body.message === 'string') return body.message
  return typeof body.error === 'string' && body.error.includes(' ') ? body.error : fallback
}

const numberOf = (body: unknown, key: string): number | undefined =>
  isRecord(body) && typeof body[key] === 'number' ? (body[key] as number) : undefined

const waits = (body: unknown): { retryAfterMs?: number } => {
  const ms = numberOf(body, 'retryAfterMs')
  return ms === undefined ? {} : { retryAfterMs: ms }
}

/** May this machine be entered with the account. Null when it cannot say. */
export async function pairOffer(machine: Http): Promise<PairOffer | null> {
  try {
    const answer = await machine.get(PAIR_PATHS.offer)
    if (answer.status !== 200 || !isRecord(answer.body)) return null
    const body = answer.body
    return {
      offered: body.offered === true,
      desktopId: typeof body.desktopId === 'string' ? body.desktopId : null,
      platform: typeof body.platform === 'string' ? body.platform : 'unknown'
    }
  } catch {
    return null
  }
}

/** A pass still good for more than the margin, for THIS device. */
export function heldGrant(deps: Pick<PairClientDeps, 'grants' | 'now'>, deviceId: string): DeviceGrant | null {
  const held = deps.grants.read()
  const now = (deps.now ?? Date.now)()
  return held !== null && held.deviceId === deviceId && held.exp - now > GRANT_MARGIN_MS ? held : null
}

/** How this account can prove itself for a pass. Null when cookrew.dev cannot be asked. */
export async function grantOptions(registry: Http): Promise<GrantOptions | null> {
  try {
    const answer = await registry.post(GRANT_PATHS.options, {})
    return answer.status === 200 && isRecord(answer.body) ? (answer.body as unknown as GrantOptions) : null
  } catch {
    return null
  }
}

const readGrant = (body: unknown): DeviceGrant | null =>
  isRecord(body) && typeof body.grant === 'string' && typeof body.exp === 'number' && typeof body.deviceId === 'string'
    ? { grant: body.grant, exp: body.exp, deviceId: body.deviceId }
    : null

const wireAssertion = (credential: Credential | null): Record<string, unknown> | null => {
  const held = credential as PublicKeyCredential | null
  const response = held?.response as AuthenticatorAssertionResponse | undefined
  if (!held || !response || !('authenticatorData' in response)) return null
  return {
    id: held.id,
    response: {
      clientDataJSON: b64u(response.clientDataJSON),
      authenticatorData: b64u(response.authenticatorData),
      signature: b64u(response.signature)
    }
  }
}

/** The passkey's answer to cookrew.dev's challenge, or why there is none. */
async function passkeyBody(deps: PairClientDeps, options: GrantOptions): Promise<{ credential: Record<string, unknown> } | ProveResult> {
  const asked = options.passkey
  if (asked === null || deps.passkey === null) return { kind: 'failed', message: 'This browser cannot use a passkey here. Type the account password.' }
  let request: CredentialRequestOptions
  try {
    request = {
      publicKey: {
        challenge: unb64u(asked.challenge),
        rpId: asked.rpId,
        timeout: asked.timeout,
        userVerification: 'required',
        allowCredentials: asked.allowCredentials.map((c) => ({ type: 'public-key' as const, id: unb64u(c.id) }))
      }
    }
  } catch {
    return { kind: 'failed', message: 'cookrew.dev sent a passkey request this browser cannot read.' }
  }
  let credential: Credential | null
  try {
    credential = await deps.passkey(request)
  } catch {
    return { kind: 'cancelled' }
  }
  const wire = wireAssertion(credential)
  return wire === null ? { kind: 'cancelled' } : { credential: wire }
}

/**
 * PROVE IT IS YOU, ONCE: `password` typed, or null for the passkey. The pass is
 * stored only when cookrew.dev issued it; the password is never kept.
 */
export async function proveForGrant(deps: PairClientDeps, password: string | null, options: GrantOptions): Promise<ProveResult> {
  if (options.needsPassword) return { kind: 'needs-password' }
  let body: Record<string, unknown>
  if (password !== null) {
    if (password.length === 0) return { kind: 'refused', message: 'Type the account password.' }
    body = { password }
  } else {
    const made = await passkeyBody(deps, options)
    if ('kind' in made) return made
    body = made
  }
  const answer = await deps.registry.post(GRANT_PATHS.grant, body)
  const grant = answer.status === 201 ? readGrant(answer.body) : null
  if (grant !== null) {
    deps.grants.write(grant)
    return { kind: 'granted' }
  }
  if (answer.status === 409) return { kind: 'needs-password' }
  const left = numberOf(answer.body, 'triesLeft')
  return {
    kind: 'refused',
    message: messageOf(answer.body, 'cookrew.dev did not take that. Try again.'),
    ...(left === undefined ? {} : { triesLeft: left }),
    ...waits(answer.body)
  }
}

/** ENTER this machine with the held pass: its challenge, signed with this browser's key. */
export async function enterWithGrant(deps: PairClientDeps, desktopId: string): Promise<EnterResult> {
  const device = await deps.device()
  if (device === null) return { kind: 'no-device' }
  const grant = heldGrant(deps, device.id)
  if (grant === null) return { kind: 'needs-proof' }
  const asking = { deviceId: device.id, jwk: device.jwk, name: device.name }
  const begun = await deps.machine.post(PAIR_PATHS.begin, { device: asking, grant: grant.grant })
  const challenge = isRecord(begun.body) ? begun.body : null
  if (challenge?.outcome === 'regrant') {
    deps.grants.clear()
    return { kind: 'needs-proof' }
  }
  if (begun.status !== 200 || challenge === null || typeof challenge.challengeId !== 'string' || typeof challenge.nonce !== 'string') {
    return { kind: 'refused', message: messageOf(begun.body, 'This machine did not start an entry. Try again.'), ...waits(begun.body) }
  }
  if (challenge.desktopId !== desktopId) return { kind: 'failed', message: 'This is not the machine this page was opened for.' }
  let sig: string
  try {
    const transcript = pairTranscript({ desktopId, challengeId: challenge.challengeId, nonce: challenge.nonce, deviceId: device.id })
    sig = b64u(await device.sign(encoder.encode(transcript)))
  } catch {
    return { kind: 'failed', message: 'This browser could not sign with its cookrew.dev key. Sign in at cookrew.dev/me again.' }
  }
  const finished = await deps.machine.post(PAIR_PATHS.finish, { challengeId: challenge.challengeId, device: asking, grant: grant.grant, sig })
  const answer = finished.body as PairAnswer | null
  if (finished.status === 200 && answer?.ok === true && typeof answer.token === 'string' && answer.desktopId === desktopId) {
    return { kind: 'entered', token: answer.token, desktopId, until: answer.until }
  }
  if (isRecord(finished.body) && finished.body.outcome === 'regrant') {
    deps.grants.clear()
    return { kind: 'needs-proof' }
  }
  return { kind: 'refused', message: messageOf(finished.body, 'This machine did not take that. Try again.') }
}

const GRANT_KEY = 'cr_grant'

/** The pass, in this origin's storage: one browser, one device key, one pass. */
export function storageGrants(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null): GrantStore {
  return {
    read: () => {
      try {
        const raw = storage?.getItem(GRANT_KEY)
        return raw ? readGrant(JSON.parse(raw)) : null
      } catch {
        return null
      }
    },
    write: (grant) => {
      try {
        storage?.setItem(GRANT_KEY, JSON.stringify(grant))
      } catch {
        // A browser that will not store it asks again next time.
      }
    },
    clear: () => {
      try {
        storage?.removeItem(GRANT_KEY)
      } catch {
        // Nothing held.
      }
    }
  }
}

const reader = async (response: Response): Promise<{ status: number; body: unknown }> => {
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body }
}

const httpAt = (base: string): Http => ({
  get: async (path) => reader(await fetch(`${base}${path}`, { cache: 'no-store', credentials: 'same-origin' })),
  post: async (path, body) =>
    reader(
      await fetch(`${base}${path}`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    )
})

/** The browser's own wiring. */
export function browserPairDeps(base: string, device: () => Promise<AccountDevice | null>): PairClientDeps {
  const credentials = typeof navigator !== 'undefined' ? navigator.credentials : undefined
  let storage: Storage | null = null
  try {
    storage = globalThis.localStorage ?? null
  } catch {
    storage = null
  }
  return {
    machine: httpAt(base),
    registry: httpAt(''),
    device,
    passkey: credentials && typeof globalThis.PublicKeyCredential === 'function' ? (options) => credentials.get(options) : null,
    grants: storageGrants(storage)
  }
}
