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
import type { CodeRefusal } from './path/seal-plane'
import { CROSS_ORIGIN_NO_COOKIE, isAbsolute } from './data-plane'
import { heldScope, machineLeft, machineScope, relayFetch, relayHeadersForUrl, type MachineScope } from './machine-scope'

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

/** What a machine's relay line answers a plain request from a device it takes only sealed (main/seal-marks.ts · SEALED_ONLY_ERROR). */
const SEALED_ONLY = 'sealed-only'

const isSealedOnly = (body: unknown): boolean => isRecord(body) && body.error === SEALED_ONLY

/**
 * Why a refused request could not go again sealed, as far as this page knows:
 *
 *   no-code          it holds no connect code for the machine
 *   code-replaced    the machine PROVED, with the held code, that it replaced it, and
 *                    no successor it vouched for waits here (seal-client.ts · checkReplaced)
 *   code-unverified  the held code was refused with no proof: a bare "no such code",
 *                    which anybody on the line could have said; nothing is asserted
 *   unopened         it holds one and no sealed session opened on it just now
 *
 * None of them takes, drops or unpins a code.
 */
export type SealUnavailable = 'no-code' | 'code-replaced' | 'code-unverified' | 'unopened'

/**
 * Said when a machine takes only sealed connections and the request could not
 * go sealed: the code word means nothing to anyone, and "did not start an
 * entry" hides the one thing that ends it. Each says only what the page knows.
 */
export const SEALED_ONLY_COPY = {
  noCode:
    'This machine takes only sealed connections, and this browser has none with it yet. Pair this browser with it once (on the machine: your avatar → Devices → Pair a phone), then try again.',
  unopened:
    'This machine takes only sealed connections, and the sealed connection to it could not be opened just now. Try again in a moment.',
  // The Mac's own word, proved with the held code. Its new code, scanned, waits beside the held one, and the
  // next refusal vouches for exactly that code (path/seal-next-code.ts): scanning is what ends this.
  codeReplaced:
    'This machine takes only sealed connections, and it proved it changed its connect code; this browser does not have the new one yet. Scan the code on the machine’s screen (your avatar → Devices → Pair a phone), then try again.',
  // Not proved: it may not be the machine's word at all. So nothing is said about the machine, nothing this
  // browser holds was taken, dropped or replaced on the strength of it, and nothing is promised of waiting:
  // a code the machine really lost needs this machine set up again on this browser, by a person, on purpose.
  codeUnverified:
    'This machine takes only sealed connections, and the sealed connection turned down the connect code this browser holds, with no proof that the answer came from the machine. This browser changed nothing, and cannot replace that code on an unproven answer.',
  unknown:
    'This machine takes only sealed connections, and this browser could not reach it sealed. Try again in a moment; if this browser was never paired with it, pair it once (on the machine: your avatar → Devices → Pair a phone).'
} as const

const SENTENCES: Readonly<Record<SealUnavailable, string>> = {
  'no-code': SEALED_ONLY_COPY.noCode,
  'code-replaced': SEALED_ONLY_COPY.codeReplaced,
  'code-unverified': SEALED_ONLY_COPY.codeUnverified,
  unopened: SEALED_ONLY_COPY.unopened
}

/** The plane's word for how a held code was refused, as the reason this page gives. */
const reasonOf = (refusal: CodeRefusal): SealUnavailable => (refusal === 'replaced' ? 'code-replaced' : 'code-unverified')

/**
 * A machine's refusal as this page reports it. A sealed-only one is said in the
 * page's OWN words (`failed`: the page knows why, the machine said only a code
 * word), so no caller puts it in the machine's mouth or cuts it to a machine's
 * length; any other is the machine's (`refused`), or the fallback.
 */
const refusalOf = (
  answer: { status: number; body: unknown },
  fallback: string
): { readonly kind: 'failed'; readonly message: string } | { readonly kind: 'refused'; readonly message: string; readonly retryAfterMs?: number } => {
  if (answer.status === 403 && isRecord(answer.body) && isSealedOnly(answer.body)) {
    const why = answer.body.seal
    return { kind: 'failed', message: typeof why === 'string' && why in SENTENCES ? SENTENCES[why as SealUnavailable] : SEALED_ONLY_COPY.unknown }
  }
  return { kind: 'refused', message: messageOf(answer.body, fallback), ...waits(answer.body) }
}

type Send = (input: string, init: RequestInit) => Promise<Response>

/**
 * The refused request on this page's sealed session with its machine, or why
 * there is none. `sameMachine` is the scope it was first asked in: false once
 * the page has left it, and nothing more may be sent then.
 */
export type SealedAgain = (input: string, init: RequestInit, sameMachine: () => boolean) => Promise<Response | SealUnavailable>

/** What the door asks of the sealed plane (path/seal-plane.ts), each part replaceable in tests. */
export interface SealedWay {
  /** Loaded before the first request leaves: until it is, relayFetch has no sealed route and would send a pinned machine's request plain. */
  ready(): Promise<unknown>
  /** A person asked: the machine's sealed session is tried now, not after a failed try's wait (seal-plane.ts · askNow, bounded there). */
  askNow(input: string): Promise<void>
  again: SealedAgain
  /**
   * Is this answer the plane's OWN re-pair answer, and for which refusal? Known
   * by identity (seal-plane.ts · ownRefusalOf), never by status or words: a
   * Mac's 401, a regrant, or a relay's look-alike is never taken for it.
   */
  planeRefusal(answer: Response): Promise<CodeRefusal | null>
  /** The machine scope as it is now; the function it returns says whether that is still so. */
  held(): () => boolean
}

const plane = (): Promise<typeof import('./path/seal-plane')> => import('./path/seal-plane')

/**
 * As plane-fetch.ts does for the page's own calls, with more. The try at the
 * sealed session is STARTED before the wait (sealOutcome asks viaSeal, which
 * starts one when due). Two rounds: a held code the Mac proved replaced is
 * followed to the successor it vouched for, whose try starts as the first ends
 * (seal-plane.ts · probe). After that, sealed or nothing. Why there is nothing
 * is read from the plane's own handshakes and its own answers, never from what
 * came back from the line.
 */
const sealedAgain: SealedAgain = async (input, init, sameMachine) => {
  const loaded = await plane()
  for (let round = 0; round < 2; round += 1) {
    if (!sameMachine()) throw machineLeft()
    if (loaded.sealOutcome(input) === 'no-code') return 'no-code'
    await loaded.probeSettled(input)
  }
  if (!sameMachine()) throw machineLeft()
  // sealedFetchFor never sends in the clear.
  const sealed = await loaded.sealedFetchFor(input, init)
  if (sealed === null) {
    const refused = loaded.codeRefusal(input)
    return refused === null ? 'unopened' : reasonOf(refused)
  }
  const own = loaded.ownRefusalOf(sealed)
  return own === null ? sealed : reasonOf(own)
}

const PLANE_WAY: SealedWay = {
  ready: plane,
  askNow: async (input) => (await plane()).askNow(input),
  again: sealedAgain,
  planeRefusal: async (answer) => (await plane()).ownRefusalOf(answer),
  held: heldScope
}

/** The refusal, saying why it stands; the page's own words, so no relay or machine can choose them. */
const sealedOnlyAnswer = (seal: SealUnavailable): Response =>
  new Response(JSON.stringify({ error: SEALED_ONLY, seal }), { status: 403, headers: { 'content-type': 'application/json' } })

/**
 * A PLAIN REQUEST REFUSED BECAUSE THE MACHINE TAKES THIS DEVICE ONLY SEALED
 * goes again ONCE, on the sealed session, and never plain again. With no sealed
 * session to go on, or one that failed, the refusal stands and says why
 * (SEALED_ONLY_COPY). All of it is bound to the machine scope the request was
 * asked in: once the page has left that machine nothing more is sent, and what
 * comes back is nobody's (an abort, as plane-fetch.ts ends such work).
 *
 * WHAT THIS REPLAYS, AND WHY THAT IS SAFE HERE ONLY. It sends a POST a second
 * time. The Mac refuses a sealed-only request before any route runs
 * (main/mobile-server.ts), so on an honest line the first was never carried out.
 * But the refusal travels the relay in the clear and carries no proof: a relay
 * could forge it for a request the Mac did carry out, and the replay would then
 * run twice. For the pair door that is harmless (a second begin is a second
 * challenge; a replayed finish meets a spent challenge and is refused), and the
 * relay saw the plain request whole anyway: sealing the replay does not take
 * back what the first attempt exposed. So wrap only requests that may run twice.
 *
 * NEVER PLAIN TO A PINNED MACHINE: the plane is loaded before the first request
 * leaves (it sets relayFetch's sealed route), and a plane that cannot load
 * sends nothing at all.
 *
 * `explicit`: a person asked for this door (or a code they scanned has just
 * landed), so a failed try's wait is cut short before the first request. Doors
 * asked on their own (a fleet read, a re-ask after a refused key) wait their turn.
 */
export function sealedRetrying(send: Send, parts: Partial<SealedWay> & { readonly explicit?: boolean } = {}): Send {
  const way: SealedWay = { ...PLANE_WAY, ...parts }
  return async (input, init) => {
    const sameMachine = way.held()
    await way.ready()
    if (!sameMachine()) throw machineLeft()
    if (parts.explicit === true) await way.askNow(input)
    if (!sameMachine()) throw machineLeft()
    const response = await send(input, init)
    // The plane's own re-pair answer (a pinned machine's held code refused): said in the page's words, as
    // proven or not. Known by identity only, so the Mac's own 401 or regrant passes through as the Mac's.
    const own = await way.planeRefusal(response)
    if (own !== null) {
      if (!sameMachine()) throw machineLeft()
      void response.body?.cancel().catch(() => undefined)
      return sealedOnlyAnswer(reasonOf(own))
    }
    if (response.status !== 403) return response
    // Read from a copy, so the caller still has the whole answer.
    const said: unknown = await response
      .clone()
      .json()
      .catch(() => null)
    if (!isSealedOnly(said)) return response
    if (!sameMachine()) throw machineLeft()
    let sealed: Response | SealUnavailable
    try {
      sealed = await way.again(input, init, sameMachine)
    } catch {
      if (!sameMachine()) throw machineLeft()
      // Not a plain resend, ever: said as a sealed connection that could not open.
      sealed = 'unopened'
    }
    if (!sameMachine()) throw machineLeft()
    void response.body?.cancel().catch(() => undefined)
    return typeof sealed === 'string' ? sealedOnlyAnswer(sealed) : sealed
  }
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
    return refusalOf(begun, 'This machine did not start an entry. Try again.')
  }
  if (challenge.desktopId !== desktopId) return { kind: 'failed', message: 'This is not the machine this page was opened for.' }
  let sig: string
  try {
    const transcript = pairTranscript({ desktopId, challengeId: challenge.challengeId, nonce: challenge.nonce, deviceId: device.id })
    sig = b64u(await device.sign(encoder.encode(transcript)))
  } catch {
    return { kind: 'failed', message: 'This browser could not sign with its Cookrew key. Sign out and in again.' }
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
  // The finish's refusal is the machine's sentence as before, with no wait: only a begin is told to wait.
  const said = refusalOf(finished, 'This machine did not take that. Try again.')
  return said.kind === 'failed' ? said : { kind: 'refused', message: said.message }
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

/**
 * HTTP at one base. Same-origin when the base is a path on this page's origin
 * (a machine's own page); another origin with no cookie when it is the relay
 * or the registry's API (the console), where what admits a call is a header
 * read at each request (`headers`), never a cookie.
 */
const httpAt = (
  base: string,
  headers: () => Record<string, string> = () => ({}),
  send: (input: string, init: RequestInit) => Promise<Response> = (input, init) => fetch(input, init)
): Http => {
  // Across origins no `cache: 'no-store'`: it would cost a preflight on every call (data-plane.ts ·
  // CROSS_ORIGIN_NO_COOKIE), and the registry and the relay mark every answer no-store themselves.
  const mode: RequestInit = isAbsolute(base) ? CROSS_ORIGIN_NO_COOKIE : { credentials: 'same-origin', cache: 'no-store' }
  return {
    get: async (path) => reader(await send(`${base}${path}`, { ...mode, headers: headers() })),
    post: async (path, body) =>
      reader(
        await send(`${base}${path}`, {
          method: 'POST',
          ...mode,
          headers: { 'content-type': 'application/json', ...headers() },
          body: JSON.stringify(body)
        })
      )
  }
}

/**
 * The browser's own wiring. `base` is the machine's: '' on its own page, its address on the relay from
 * the console. On the console the machine's door is reached with the account
 * session in the relay's header, and the registry (the device pass) at its API
 * origin with the session as a bearer.
 */
export function browserPairDeps(
  base: string,
  device: () => Promise<AccountDevice | null>,
  scope: MachineScope = machineScope(),
  /**
   * `explicit`: a person asked for this door (sealedRetrying). Left out, the door waits its turn like any automatic ask.
   * `held`: what ends a sealed retry's wait. Left out, the machine in scope (heldScope); the fleet's reads, keyed by
   * a machine's own id, pass the relay instead (heldRelay), so entering another machine does not end them.
   */
  options: { readonly explicit?: boolean; readonly held?: () => () => boolean } = {}
): PairClientDeps {
  const credentials = typeof navigator !== 'undefined' ? navigator.credentials : undefined
  let storage: Storage | null = null
  try {
    storage = globalThis.localStorage ?? null
  } catch {
    storage = null
  }
  return {
    // The account session rides only an address under the relay's machine prefix (machine-scope.ts),
    // and a relayed call leaves at the relay's one address (relayFetch); one a sealed-only machine
    // refused in the clear goes again sealed when this page has a session with it (sealedRetrying).
    machine: httpAt(base, () => relayHeadersForUrl(`${base}/`, scope), sealedRetrying(relayFetch(undefined, () => scope), {
      explicit: options.explicit === true,
      ...(options.held ? { held: options.held } : {})
    })),
    registry:
      scope.relay === null
        ? httpAt('')
        : httpAt(scope.relay.origin, (): Record<string, string> => {
            const session = scope.relay?.session() ?? null
            return session ? { authorization: `Bearer ${session}` } : {}
          }),
    device,
    passkey: credentials && typeof globalThis.PublicKeyCredential === 'function' ? (options) => credentials.get(options) : null,
    grants: storageGrants(storage)
  }
}
