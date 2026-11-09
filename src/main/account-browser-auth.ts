import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto'
import type { AccountDeviceInput, AccountRefusal, AccountResult, SignInAnswer } from '../shared/account-v2'
import type { PasskeySummary } from '../shared/account-approvals'
import {
  AUTH_CODE_TTL_MS,
  AUTH_POLL_MS,
  AUTH_REQUEST_TTL_MS,
  AUTH_TRANSCRIPT_CONTEXT,
  isAuthTranscript,
  type AuthIntent,
  type AuthRequestBody,
  type AuthRequestCreated
} from '../shared/auth-site'
import type { ProviderId } from '../shared/oauth'
import type { AccountSession } from './account-v2'
import type { MintedDevice, TripProof } from './account-oauth'
import { safeToOpen, type Returned, type Trips } from './account-trip'
import { classify, plainRefusal } from './account-wire'

/**
 * THE APP'S HALF OF THE ONE SIGN-IN PAGE (auth.cookrew.dev).
 *
 * The person signs in on a real browser page, where the ladder, the passkey and
 * the providers all live; this app only opens a request naming the device the
 * session will belong to, proves it holds that key, and spends the one-use code
 * that comes back. The verifier never leaves main and the page never sees a
 * session, exactly as a provider trip (account-oauth.ts), whose way back and
 * whose one-trip-at-a-time slot this shares (account-trip.ts).
 *
 * NO PASSWORD IS EVER IN HAND HERE, even when one was typed on the page. So a
 * landing goes through the same `land` a provider's does, and this Mac unlocks
 * with its own passcode or Touch ID.
 *
 * AN OLDER REGISTRY HAS NO SUCH ROUTE, and a new app must keep working against
 * it. Its 404 (or anything that is not this wire's answer) is 'unsupported',
 * said before anything is proved or opened, and every caller then goes the old
 * way: the sheet's own forms, a provider trip, a password prompt.
 */

/** The screens a sign-in may open on. `link` and `passkey` are signed-in acts with their own calls. */
export type BrowserIntent = Exclude<AuthIntent, 'link' | 'passkey'>

const BROWSER_INTENTS: readonly BrowserIntent[] = ['sign-in', 'create', 'github', 'google']

export const isBrowserIntent = (value: unknown): value is BrowserIntent =>
  typeof value === 'string' && (BROWSER_INTENTS as readonly string[]).includes(value)

/** The transcript guard lives in the contract; re-exported for the account tests. */
export { AUTH_TRANSCRIPT_CONTEXT, isAuthTranscript }

/** An Ed25519 signature over the transcript's UTF-8 bytes, base64url. */
export function signTranscript(privateKeyJwk: Record<string, unknown>, transcript: string): string {
  const key = createPrivateKey({ key: privateKeyJwk as never, format: 'jwk' })
  return sign(null, Buffer.from(transcript, 'utf8'), key).toString('base64url')
}

/** What `cookrew login` is handed to show. */
export interface BrowserCode {
  userCode: string
  verificationUri: string
  verificationUriComplete: string | null
  expiresAt: number
}

/** The device a request names, and the key that proves it. Read once per attempt. */
export interface OfferedDevice {
  device: AccountDeviceInput
  /** The key minted for this attempt, or null for this Mac's own. */
  minted: MintedDevice | null
  privateKeyJwk: Record<string, unknown>
}

type Answer = { status: number; body: Record<string, unknown>; json: boolean }
type Send = (path: string, body: unknown) => Promise<AccountResult<Answer>>

export interface BrowserAuthPort {
  http: (input: string, init?: RequestInit) => Promise<Response>
  origin: string
  now: () => number
  openBrowser: (url: string) => Promise<void> | void
  /** This Mac's device when it has an account, else a key minted for the attempt. */
  device: () => OfferedDevice
  /** The account file's username, or null with no account. */
  username: () => string | null
  land: (body: Record<string, unknown>, minted: MintedDevice | null) => SignInAnswer<AccountSession>
  /** One signed-in POST, read whole. */
  authed: (path: string, body: unknown) => Promise<AccountResult<{ status: number; body: Record<string, unknown> }>>
}

export type BrowserSignInAnswer = SignInAnswer<AccountSession>

/** A registry without the route says so with one of these, or with an answer that is not JSON. */
const NO_ROUTE: ReadonlySet<number> = new Set([404, 405, 501])

/** A page trip waits as long as a request and its code can live. */
const PAGE_TRIP_WAIT_MS = AUTH_REQUEST_TTL_MS + AUTH_CODE_TTL_MS

/** What the transcript must name: the origin the page is on, and the device this Mac offered. */
function expectedOf(created: AuthRequestCreated, offered: OfferedDevice): { audience?: string; deviceId: string } {
  let audience: string | undefined
  try {
    audience = new URL(created.authorizeUrl).origin
  } catch {
    audience = undefined
  }
  return { ...(audience === undefined ? {} : { audience }), deviceId: String(offered.device.id) }
}

function unsupported(answer: Answer): boolean {
  if (NO_ROUTE.has(answer.status)) return true
  // A gateway's HTML 502 during a deploy is a registry that is down for a
  // moment, not one without the page: falling back would stick for the run.
  if (answer.status >= 500) return false
  // 401 and 429 say enough with their status alone, body or not.
  if (answer.status === 401 || answer.status === 429) return false
  if (!answer.json) return true
  // A 2xx that is not this wire's 201 is some other page answering.
  return answer.status >= 200 && answer.status < 300 && answer.status !== 201
}

const refusedOf = (status: number, body: Record<string, unknown>): { reason: AccountRefusal; message?: string } =>
  classify(status, body as { error?: string; message?: string })

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)

function createdFrom(body: Record<string, unknown>): AuthRequestCreated | null {
  const request = str(body.request)
  const transcript = str(body.transcript)
  const authorizeUrl = str(body.authorizeUrl)
  if (request === null || transcript === null || authorizeUrl === null || typeof body.expiresAt !== 'number') return null
  return {
    request,
    transcript,
    authorizeUrl,
    expiresAt: body.expiresAt,
    ...(str(body.userCode) === null ? {} : { userCode: body.userCode as string }),
    ...(str(body.verificationUri) === null ? {} : { verificationUri: body.verificationUri as string }),
    ...(str(body.verificationUriComplete) === null ? {} : { verificationUriComplete: body.verificationUriComplete as string }),
    ...(typeof body.intervalMs === 'number' ? { intervalMs: body.intervalMs } : {}),
  }
}

/** How the page's trip ended, as the code to spend or the reason there is none. */
function codeOf(returned: Returned): AccountResult<string> {
  if ('code' in returned) return { ok: true, value: returned.code }
  if ('over' in returned) return { ok: false, reason: returned.over === 'timeout' ? 'expired' : 'cancelled' }
  if ('error' in returned) {
    if (returned.error === 'denied') return { ok: false, reason: 'cancelled' }
    return { ok: false, reason: returned.error === 'expired' ? 'expired' : 'provider_down' }
  }
  // A provider's handoff is not this trip's answer.
  return { ok: false, reason: 'unknown' }
}

const pkce = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

const sleep = (ms: number, wake: (stop: () => void) => void): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    wake(() => {
      clearTimeout(timer)
      resolve()
    })
  })

export class BrowserAuth {
  private readonly port: BrowserAuthPort
  private readonly trips: Trips

  constructor(port: BrowserAuthPort, trips: Trips) {
    this.port = port
    this.trips = trips
  }

  /** A plain POST, with whether the answer was JSON at all. */
  private send: Send = async (path, body) => {
    let response: Response
    try {
      response = await this.port.http(`${this.port.origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      return { ok: false, reason: 'offline' }
    }
    let parsed: unknown = null
    try {
      const text = await response.text()
      parsed = text === '' ? null : JSON.parse(text)
    } catch {
      parsed = null
    }
    const json = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    return { ok: true, value: { status: response.status, body: json ? (parsed as Record<string, unknown>) : {}, json } }
  }

  /** The same, under the session. A body with nothing in it reads as no JSON. */
  private sendAuthed: Send = async (path, body) => {
    const sent = await this.port.authed(path, body)
    if (!sent.ok) return sent
    return { ok: true, value: { ...sent.value, json: Object.keys(sent.value.body).length > 0 } }
  }

  /** Open a request and prove the key it names. Answers what the page needs. */
  private async open(body: AuthRequestBody, offered: OfferedDevice, send: Send): Promise<AccountResult<AuthRequestCreated>> {
    const made = await send('/v2/auth/requests', body)
    if (!made.ok) return made
    if (unsupported(made.value)) return { ok: false, reason: 'unsupported' }
    if (made.value.status !== 201) return { ok: false, ...refusedOf(made.value.status, made.value.body) }
    const created = createdFrom(made.value.body)
    if (created === null || !isAuthTranscript(created.transcript, created.request, expectedOf(created, offered))) {
      return { ok: false, reason: 'unknown' }
    }
    let signature: string
    try {
      signature = signTranscript(offered.privateKeyJwk, created.transcript)
    } catch {
      return { ok: false, reason: 'unknown' }
    }
    // The proof needs no session: the signature is the credential.
    const proved = await this.send(`/v2/auth/requests/${encodeURIComponent(created.request)}/proof`, { signature })
    if (!proved.ok) return proved
    if (proved.value.status !== 204) return { ok: false, ...refusedOf(proved.value.status, proved.value.body) }
    return { ok: true, value: created }
  }

  /** The page's round trip, from the request to the code it sends back. */
  private async trip(
    body: (state: string, back: { scheme: boolean; port?: number }) => AuthRequestBody,
    offered: OfferedDevice,
    send: Send,
  ): Promise<AccountResult<string>> {
    // As long as the page can run: a person saving recovery codes before the
    // handoff must not come back to an app that stopped listening.
    const back = await this.trips.travel(async (state, way) => {
      const opened = await this.open(body(state, way), offered, send)
      return opened.ok ? { ok: true, value: opened.value.authorizeUrl } : opened
    }, PAGE_TRIP_WAIT_MS)
    return back.ok ? codeOf(back.value) : back
  }

  /**
   * SIGN IN OR CREATE, on the page. On a Mac with an account it is that
   * account's device that is offered, so a landing for anybody else is refused
   * where every landing is (`land`).
   */
  async signIn(intent: BrowserIntent, options: { username?: string } = {}): Promise<BrowserSignInAnswer> {
    return this.signInAs(intent, options.username ?? null, null)
  }

  /**
   * THE SESSION ENDED on a Mac that has an account: the same page, its name
   * prefilled, its own device offered. A session for any other name is refused
   * here and nothing in the file changes.
   */
  async resume(): Promise<BrowserSignInAnswer> {
    const username = this.port.username()
    if (username === null) return { ok: false, reason: 'no_account' }
    return this.signInAs('sign-in', username, username)
  }

  private async signInAs(intent: BrowserIntent, prefill: string | null, expected: string | null): Promise<BrowserSignInAnswer> {
    const offered = this.port.device()
    const { verifier, challenge } = pkce()
    const code = await this.trip(
      (state, back) => ({
        client: 'desktop',
        intent,
        device: offered.device,
        challenge,
        state,
        back,
        ...(prefill === null ? {} : { username: prefill }),
      }),
      offered,
      this.send,
    )
    if (!code.ok) return plainRefusal(code)
    const spent = await this.send('/v2/auth/token', { code: code.value, verifier })
    if (!spent.ok) return plainRefusal(spent)
    return this.read(spent.value, offered, expected)
  }

  /** A redeem's answer, as a landing or a refusal. */
  private read(answer: Answer, offered: OfferedDevice, expected: string | null): BrowserSignInAnswer {
    const { status, body } = answer
    if (status === 201) {
      if (expected !== null && body.username !== expected) return { ok: false, reason: 'wrong_identity' }
      return this.port.land(body, offered.minted)
    }
    if (status === 410) return { ok: false, reason: body.why === 'denied' ? 'cancelled' : 'expired' }
    // The device on this Mac is attached to another account.
    if (status === 400 && body.error === 'bad_device' && this.port.username() !== null) {
      return { ok: false, reason: 'wrong_identity' }
    }
    return plainRefusal(refusedOf(status, body))
  }

  /** ADD A PROVIDER to the signed-in account, on the page, under a fresh proof. */
  async link(provider: ProviderId, proof: TripProof): Promise<AccountResult<void>> {
    if (this.port.username() === null) return { ok: false, reason: 'no_account' }
    const offered = this.port.device()
    const { verifier, challenge } = pkce()
    const code = await this.trip(
      (state, back) => ({ client: 'desktop', intent: 'link', provider, device: offered.device, challenge, state, back, ...proof }),
      offered,
      this.sendAuthed,
    )
    if (!code.ok) return code
    const linked = await this.sendAuthed('/v2/auth/token', { code: code.value, verifier })
    if (!linked.ok) return linked
    const { status, body } = linked.value
    if (status === 200 && body.status === 'linked') return { ok: true, value: undefined }
    if (status === 410) return { ok: false, reason: body.why === 'denied' ? 'cancelled' : 'expired' }
    return { ok: false, ...refusedOf(status, body) }
  }

  /**
   * ADD A PASSKEY to the signed-in account, on the page: this Electron has no
   * platform authenticator, a real browser does. The page asks an account with
   * no password to prove it with its provider there; the passkey it makes is
   * written when this app spends the code with its own session, so nothing is
   * added until it arrives here.
   */
  async addPasskey(): Promise<AccountResult<PasskeySummary>> {
    if (this.port.username() === null) return { ok: false, reason: 'no_account' }
    const offered = this.port.device()
    const { verifier, challenge } = pkce()
    const code = await this.trip(
      (state, back) => ({ client: 'desktop', intent: 'passkey', device: offered.device, challenge, state, back }),
      offered,
      this.sendAuthed,
    )
    if (!code.ok) return code
    const spent = await this.sendAuthed('/v2/auth/token', { code: code.value, verifier })
    if (!spent.ok) return spent
    const { status, body } = spent.value
    const passkey = body.passkey as Partial<PasskeySummary> | undefined
    if (status === 201 && body.status === 'passkey' && typeof passkey?.id === 'string') {
      return { ok: true, value: { id: passkey.id, name: String(passkey.name ?? ''), addedAt: Number(passkey.addedAt ?? 0) } }
    }
    if (status === 410) return { ok: false, reason: body.why === 'denied' ? 'cancelled' : 'expired' }
    return { ok: false, ...refusedOf(status, body) }
  }

  /**
   * `cookrew login`: A CODE TO TYPE, AND A POLL.
   *
   * Nothing comes back to a terminal, so it asks the registry until the page has
   * finished, on the registry's pace. A browser is tried on this machine and its
   * failure ignored: a box with no screen has none, and the person opens the
   * address on any device. A 410 says denied or expired, each in its own words.
   */
  async terminalSignIn(options: {
    onCode: (code: BrowserCode) => void
    signal?: AbortSignal
    everyMs?: number
    username?: string
  }): Promise<BrowserSignInAnswer> {
    const offered = this.port.device()
    const { verifier, challenge } = pkce()
    const body: AuthRequestBody = {
      client: 'cli',
      intent: 'sign-in',
      device: offered.device,
      challenge,
      ...(options.username === undefined ? {} : { username: options.username }),
    }
    const opened = await this.open(body, offered, this.send)
    if (!opened.ok) return plainRefusal(opened)
    const created = opened.value
    if (created.userCode === undefined || created.verificationUri === undefined) return { ok: false, reason: 'unknown' }
    // The code is TYPED at the page, never carried in the link: the registry
    // no longer sends a link with the code in it, so nothing here can either.
    const page = created.verificationUri
    options.onCode({
      userCode: created.userCode,
      verificationUri: page,
      verificationUriComplete: null,
      expiresAt: created.expiresAt,
    })
    if (safeToOpen(page)) {
      Promise.resolve()
        .then(() => this.port.openBrowser(page))
        .catch(() => undefined)
    }
    // How long the page can run, counted on this machine's clock: the
    // registry's absolute time and ours need not agree.
    const deadline = this.port.now() + AUTH_REQUEST_TTL_MS + AUTH_CODE_TTL_MS
    return this.poll({ ...created, expiresAt: deadline }, verifier, offered, options)
  }

  private async poll(
    created: AuthRequestCreated,
    verifier: string,
    offered: OfferedDevice,
    options: { signal?: AbortSignal; everyMs?: number },
  ): Promise<BrowserSignInAnswer> {
    let cancelled = options.signal?.aborted === true
    let wake: (() => void) | null = null
    const stop = (): void => {
      cancelled = true
      wake?.()
    }
    const release = this.trips.hold(stop)
    options.signal?.addEventListener('abort', stop, { once: true })
    let wait = options.everyMs ?? created.intervalMs ?? AUTH_POLL_MS
    try {
      for (;;) {
        if (cancelled) return { ok: false, reason: 'cancelled' }
        if (this.port.now() >= created.expiresAt) return { ok: false, reason: 'expired' }
        const polled = await this.send('/v2/auth/token', { request: created.request, verifier })
        // A session minted for this device cannot be thrown away: the account
        // would hold a key no file on this machine has.
        if (cancelled && !(polled.ok && polled.value.status === 201)) return { ok: false, reason: 'cancelled' }
        const answered = polled.ok ? polled.value : null
        if (answered?.status === 410) {
          return { ok: false, reason: answered.body.why === 'denied' ? 'denied' : 'expired' }
        }
        // A dropped network, a restarting registry or a slow-down is no reason to
        // make a person start again: the request stands until it expires.
        const keepGoing = answered === null || answered.status === 202 || answered.status === 429 || answered.status >= 500
        if (!polled.ok && polled.reason !== 'offline') return plainRefusal(polled)
        if (answered !== null && !keepGoing) return this.read(answered, offered, null)
        const paced = answered?.status === 202 ? answered.body.intervalMs : undefined
        if (options.everyMs === undefined && typeof paced === 'number' && paced > 0) wait = paced
        await sleep(answered?.status === 429 ? wait * 2 : wait, (stopNow) => {
          wake = stopNow
        })
      }
    } finally {
      options.signal?.removeEventListener('abort', stop)
      release()
    }
  }
}
