import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes } from 'node:crypto'
import type {
  AccountDeviceInput,
  AccountRefusal,
  AccountResult,
  ProviderSignInAnswer,
  SignInAnswer,
} from '../shared/account-v2'
import { OAUTH_SCHEME_HOST, type OAuthIntent, type ProviderId, type ProviderOffer } from '../shared/oauth'
import type { StepUpAct } from '../shared/step-up'
import { stepFrom } from './account-ladder'
import { bodyOf, classify, plainRefusal } from './account-wire'
import type { AccountSession } from './account-v2'
import { listenForReturn, type LoopbackListener } from './oauth-loopback'

/**
 * THE APP'S HALF OF A PROVIDER SIGN-IN.
 *
 * A system browser does the part with a provider's login page in it; an
 * embedded one would ask a person to type a GitHub password into a window this
 * app controls. Everything that matters stays in main: the PKCE verifier, the
 * handoff, the ticket and the session. The renderer sees a status, a suggested
 * name, and whether to draw a ladder.
 *
 * THE VERIFIER IS THE WHOLE DEFENCE of the way back. `cookrew://` can be claimed
 * by any program on the machine, so a handoff arriving is not evidence of
 * anything. It is worth nothing until it is sent with a verifier that never
 * crossed the browser.
 *
 * ONE TRIP AT A TIME. A trip is registered before anything is awaited, so a
 * second press or a cancel always finds it. A second press ends the first: two
 * browsers finishing in either order is a question with no good answer, and only
 * the last press is what the person means.
 *
 * AN ACT CAN BE LONGER THAN A TRIP. Linking on a passwordless account is a proof,
 * a redeem and a second trip, with reads either side, and a cancel or a lock in
 * those gaps has no trip to end. So `during` scopes an act to the cancel count it
 * began under, and every step asks whether that count still stands.
 *
 * Electron-free, like the rest of the account layer: the browser and the scheme
 * check arrive through the port, so a headless caller can use all of this.
 */

/** Long enough to find a password manager; a forgotten tab must not wait for ever. */
export const TRIP_WAIT_MS = 5 * 60 * 1000

export type TripProof = { current: string } | { stepUp: string }

/** What the verb `cookrew login --github` is handed to show. */
export interface DeviceCode {
  userCode: string
  verificationUri: string
  expiresAt: number
}

/** The key a sign-in minted, carried with it so nothing else can swap it. */
export interface MintedDevice {
  deviceId: string
  name: string
  keys: { privateKeyJwk: Record<string, unknown>; publicKeyJwk: Record<string, unknown> }
}

export interface ProviderPort {
  http: (input: string, init?: RequestInit) => Promise<Response>
  origin: string
  now: () => number
  openBrowser: (url: string) => Promise<void> | void
  schemeHandled: () => boolean
  /** This Mac's device, or a key minted for this one sign-in. */
  device: () => { device: AccountDeviceInput; minted: MintedDevice | null }
  hasAccount: () => boolean
  /** A ladder opened with no password: the rungs must still find it, and the key. */
  rememberPending: (pending: string, minted: MintedDevice | null) => void
  land: (body: Record<string, unknown>, minted: MintedDevice | null) => SignInAnswer<AccountSession>
  /** One signed-in POST, read whole. */
  authed: (path: string, body: unknown) => Promise<AccountResult<{ status: number; body: Record<string, unknown> }>>
  /** The provider this account would prove itself with. */
  firstLink: () => Promise<AccountResult<ProviderId>>
}

type Returned = { handoff: string } | { error: string } | { over: 'cancelled' | 'timeout' }

interface Trip {
  state: string
  settled: boolean
  settle: (returned: Returned) => void
}

/** The one shape a return may have, or null. Never throws. */
export function parseOAuthReturn(raw: string): { handoff: string | null; error: string | null; state: string } | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'cookrew:' || url.hostname !== OAUTH_SCHEME_HOST) return null
  if (url.username || url.password || url.search.length > 0) return null
  if (url.pathname !== '' && url.pathname !== '/') return null
  return readFields(new URLSearchParams(url.hash.replace(/^#/, '')))
}

function readFields(fields: URLSearchParams): { handoff: string | null; error: string | null; state: string } | null {
  const state = fields.get('state')
  const handoff = fields.get('handoff')
  const error = fields.get('error')
  if (state === null || state === '' || (handoff === null) === (error === null)) return null
  return { handoff, error, state }
}

/** How a trip ended, as a result. */
function readReturned(returned: Returned, verifier: string): AccountResult<{ handoff: string; verifier: string }> {
  if ('handoff' in returned) return { ok: true, value: { handoff: returned.handoff, verifier } }
  if ('over' in returned) return { ok: false, reason: returned.over === 'timeout' ? 'expired' : 'cancelled' }
  return { ok: false, reason: returned.error === 'denied' ? 'cancelled' : 'provider_down' }
}

const refusedOf = (status: number, body: Record<string, unknown>): { reason: AccountRefusal; message?: string } =>
  classify(status, body as { error?: string; message?: string })

/** Only somewhere a browser should go. A bad registry answer must not reach `openExternal`. */
function safeToOpen(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  try {
    const url = new URL(raw)
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
  } catch {
    return false
  }
}

export class ProviderAccess {
  private readonly port: ProviderPort
  private trip: Trip | null = null
  /** A proven identity waiting for a name. The ticket never crosses the bridge. */
  private claimable: { ticket: string; device: AccountDeviceInput; minted: MintedDevice | null } | null = null
  /** Set while a device-flow poll is running, so it can be ended. */
  private deviceCancelled: (() => void) | null = null
  /** How many cancels there have been. An act remembers the one it began under. */
  private cancels = 0
  private readonly act = new AsyncLocalStorage<number>()

  constructor(port: ProviderPort) {
    this.port = port
  }

  /** What to draw. Silence, a 404 and an old registry all mean no button. */
  async list(): Promise<readonly ProviderOffer[]> {
    try {
      const response = await this.port.http(`${this.port.origin}/v2/oauth/providers`, { method: 'GET' })
      if (!response.ok) return []
      const body = (await response.json()) as { providers?: unknown }
      return Array.isArray(body.providers) ? (body.providers as ProviderOffer[]) : []
    } catch {
      return []
    }
  }

  /** A trip in flight ended by the person. True when there was one. */
  cancel(): boolean {
    const running = this.trip !== null || this.deviceCancelled !== null
    this.cancels += 1
    this.trip?.settle({ over: 'cancelled' })
    this.deviceCancelled?.()
    return running
  }

  /** One act, however many trips it takes. A cancel anywhere in it ends it. */
  during<T>(run: () => Promise<T>): Promise<T> {
    if (this.act.getStore() !== undefined) return run()
    this.cancel()
    return this.act.run(this.cancels, run)
  }

  /** Has the act this code is running in been cancelled? */
  private ended(): boolean {
    const began = this.act.getStore()
    return began !== undefined && began !== this.cancels
  }

  /** A browser is out. The idle clock waits for it. */
  tripping(): boolean {
    return this.trip !== null
  }

  /** The account changed some other way: nothing in flight may land on it. */
  reset(): void {
    this.cancel()
    this.claimable = null
  }

  /** A `cookrew://oauth#…` link arrived. True when it belonged to this trip. */
  arrive(raw: string): boolean {
    const fields = parseOAuthReturn(raw)
    return fields !== null && this.accept(fields)
  }

  private accept(fields: { handoff: string | null; error: string | null; state: string }): boolean {
    const trip = this.trip
    // A return this process did not start is dropped here: that is what stops
    // a stranger's link signing this Mac in to the stranger's account.
    if (trip === null || fields.state !== trip.state) return false
    trip.settle(fields.handoff !== null ? { handoff: fields.handoff } : { error: fields.error ?? 'provider' })
    return true
  }

  /** The browser round trip. Answers the handoff and the verifier that spends it. */
  private async travel(
    provider: ProviderId,
    intent: OAuthIntent,
    extra: Record<string, unknown>,
    start: (path: string, body: unknown) => Promise<AccountResult<{ status: number; body: Record<string, unknown> }>>,
  ): Promise<AccountResult<{ handoff: string; verifier: string }>> {
    if (this.ended()) return { ok: false, reason: 'cancelled' }
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const { trip, returned } = this.begin(state)
    let listener: LoopbackListener | null = null
    try {
      listener = await listenForReturn((query) => {
        const fields = readFields(query)
        return fields !== null && this.accept(fields)
      })
      const handled = this.port.schemeHandled()
      const started = await start(`/v2/oauth/${provider}/start`, {
        intent,
        state,
        challenge,
        back: { scheme: handled || listener === null, ...(listener === null ? {} : { port: listener.port }) },
        ...extra,
      })
      // Ended while the registry was being asked: the browser never opens.
      if (trip.settled) return readReturned(await returned, verifier)
      if (!started.ok) return started
      if (started.value.status !== 201) {
        return { ok: false, ...refusedOf(started.value.status, started.value.body) }
      }
      const url = started.value.body.authorizeUrl
      if (!safeToOpen(url)) return { ok: false, reason: 'unknown' }
      Promise.resolve()
        .then(() => this.port.openBrowser(url))
        .catch(() => trip.settle({ error: 'provider' }))
      return readReturned(await returned, verifier)
    } finally {
      // Every way out ends the trip; settling twice is nothing.
      trip.settle({ over: 'cancelled' })
      listener?.close()
    }
  }

  /** Registered at once, ending the one before. Its timer can only end itself. */
  private begin(state: string): { trip: Trip; returned: Promise<Returned> } {
    this.trip?.settle({ over: 'cancelled' })
    let trip: Trip | null = null
    const returned = new Promise<Returned>((resolve) => {
      const held: Trip = {
        state,
        settled: false,
        settle: (answer) => {
          if (held.settled) return
          held.settled = true
          clearTimeout(timer)
          if (this.trip === held) this.trip = null
          resolve(answer)
        },
      }
      const timer = setTimeout(() => held.settle({ over: 'timeout' }), TRIP_WAIT_MS)
      timer.unref()
      trip = held
    })
    this.trip = trip
    return { trip: trip as unknown as Trip, returned }
  }

  private post = async (
    path: string,
    body: unknown,
  ): Promise<AccountResult<{ status: number; body: Record<string, unknown> }>> => {
    try {
      const response = await this.port.http(`${this.port.origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { ok: true, value: { status: response.status, body: await bodyOf(response) } }
    } catch {
      return { ok: false, reason: 'offline' }
    }
  }

  /** The password step's replacement, for a Mac with or without an account. */
  async signIn(provider: ProviderId): Promise<ProviderSignInAnswer<AccountSession>> {
    const held = this.port.device()
    const back = await this.travel(provider, 'sign-in', {}, this.post)
    if (!back.ok) return plainRefusal(back)
    const redeemed = await this.post('/v2/oauth/redeem', { ...back.value, device: held.device })
    return redeemed.ok ? this.read(redeemed.value, held) : plainRefusal(redeemed)
  }

  /** A sign-in's answer, however the proof was reached. */
  private read(
    answer: { status: number; body: Record<string, unknown> },
    held: { device: AccountDeviceInput; minted: MintedDevice | null },
  ): ProviderSignInAnswer<AccountSession> {
    const { status, body } = answer
    if (status === 201) return this.port.land(body, held.minted)
    if (status === 200 && body.status === 'new' && typeof body.ticket === 'string') {
      // This Mac already belongs to an account, and this identity is not on it.
      // Offering a claim here would make a second account on a Mac with one.
      if (this.port.hasAccount()) return { ok: false, reason: 'wrong_identity' }
      this.claimable = { ticket: body.ticket, ...held }
      return {
        ok: false,
        reason: 'new_identity',
        provider: body.provider as ProviderId,
        suggest: typeof body.suggest === 'string' ? body.suggest : '',
        free: body.free === true,
        email: typeof body.email === 'string' ? body.email : null,
      }
    }
    if (status === 401 && body.error === 'second_factor') {
      const step = stepFrom(body)
      if (step !== null) {
        this.port.rememberPending(step.pending, held.minted)
        return {
          ok: false,
          reason: 'second_factor',
          step,
          ...(typeof body.message === 'string' ? { message: body.message } : {}),
        }
      }
    }
    // The device on this Mac is attached to another account.
    if (status === 400 && body.error === 'bad_device' && this.port.hasAccount()) {
      return { ok: false, reason: 'wrong_identity' }
    }
    return plainRefusal(refusedOf(status, body))
  }

  /** The handle, for the identity the last sign-in proved. */
  async claim(username: string): Promise<SignInAnswer<AccountSession>> {
    const held = this.claimable
    if (held === null) return { ok: false, reason: 'expired' }
    const made = await this.post('/v2/oauth/claim', { ticket: held.ticket, username: username.trim(), device: held.device })
    if (!made.ok) return plainRefusal(made)
    if (made.value.status === 201) {
      this.claimable = null
      return this.port.land(made.value.body, held.minted)
    }
    if (made.value.status === 410) this.claimable = null
    return plainRefusal(refusedOf(made.value.status, made.value.body))
  }

  /** Add an identity to the signed-in account. */
  async link(provider: ProviderId, proof: TripProof): Promise<AccountResult<void>> {
    const back = await this.travel(provider, 'link', proof, this.port.authed)
    if (!back.ok) return back
    const linked = await this.port.authed('/v2/oauth/redeem', back.value)
    if (!linked.ok) return linked
    if (linked.value.status === 200 && linked.value.body.status === 'linked') return { ok: true, value: undefined }
    return { ok: false, ...refusedOf(linked.value.status, linked.value.body) }
  }

  /** A provider round trip as a step-up proof, for one act. Answers the `stepUp` id. */
  prove(act: StepUpAct): Promise<AccountResult<string>> {
    return this.during(() => this.proveNow(act))
  }

  private async proveNow(act: StepUpAct): Promise<AccountResult<string>> {
    const provider = await this.port.firstLink()
    if (!provider.ok) return provider
    const back = await this.travel(provider.value, 'step-up', { act }, this.port.authed)
    if (!back.ok) return back
    const proved = await this.port.authed('/v2/oauth/redeem', back.value)
    if (this.ended()) return { ok: false, reason: 'cancelled' }
    if (!proved.ok) return proved
    const { status, body } = proved.value
    return status === 200 && typeof body.stepUp === 'string'
      ? { ok: true, value: body.stepUp }
      : { ok: false, ...refusedOf(status, body) }
  }

  /**
   * THE PROVIDER IS LOST: A RESCUE CODE PROVES THE LINK OF A NEW ONE.
   *
   * With no password and no provider, nothing else can step up, and nothing
   * behind a step-up (revoking a device, a join code) can ever happen again.
   * The registry already offers the recovery rung on this gate: asked with no
   * proof it opens a pending, and spending a code authorises that one act.
   */
  async rescueProof(provider: ProviderId, code: string): Promise<AccountResult<string>> {
    const challenge = createHash('sha256').update(randomBytes(32)).digest('base64url')
    const state = randomBytes(32).toString('base64url')
    const asked = await this.port.authed(`/v2/oauth/${provider}/start`, {
      intent: 'link',
      state,
      challenge,
      back: { scheme: true },
    })
    // Before the code is spent: it cannot be taken back afterwards.
    if (this.ended()) return { ok: false, reason: 'cancelled' }
    if (!asked.ok) return asked
    const { pending } = asked.value.body
    if (asked.value.body.error !== 'step_up' || typeof pending !== 'string') {
      return { ok: false, ...refusedOf(asked.value.status, asked.value.body) }
    }
    const spent = await this.port.authed(`/v2/sessions/${encodeURIComponent(pending)}/recovery`, { code })
    if (!spent.ok) return spent
    return spent.value.status === 204
      ? { ok: true, value: pending }
      : { ok: false, ...refusedOf(spent.value.status, spent.value.body) }
  }

  /**
   * THE DEVICE FLOW, for a machine with no browser.
   *
   * The seam `cookrew login --github` calls. The device code stays in the
   * registry; this holds a verifier and shows a person the short code.
   */
  async deviceSignIn(
    provider: ProviderId,
    options: { onCode: (code: DeviceCode) => void; everyMs?: number },
  ): Promise<ProviderSignInAnswer<AccountSession>> {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const started = await this.post(`/v2/oauth/${provider}/device`, { challenge })
    if (!started.ok) return plainRefusal(started)
    if (started.value.status !== 201) return plainRefusal(refusedOf(started.value.status, started.value.body))
    const { flow, userCode, verificationUri, intervalMs, expiresAt } = started.value.body as {
      flow: string
      userCode: string
      verificationUri: string
      intervalMs: number
      expiresAt: number
    }
    options.onCode({ userCode, verificationUri, expiresAt })
    const held = this.port.device()
    let cancelled = false
    let wake: (() => void) | null = null
    this.deviceCancelled = () => {
      cancelled = true
      wake?.()
    }
    try {
      for (;;) {
        if (cancelled) return { ok: false, reason: 'cancelled' }
        if (this.port.now() >= expiresAt) return { ok: false, reason: 'expired' }
        const polled = await this.post(`/v2/oauth/device/${encodeURIComponent(flow)}/poll`, {
          verifier,
          device: held.device,
        })
        // Cancelled while the poll was out: its answer must not land.
        if (cancelled) return { ok: false, reason: 'cancelled' }
        if (!polled.ok) return plainRefusal(polled)
        const { status, body } = polled.value
        if (status === 410) return { ok: false, reason: body.why === 'denied' ? 'cancelled' : 'expired' }
        if (status !== 202) return this.read(polled.value, held)
        const wait = options.everyMs ?? (typeof body.intervalMs === 'number' ? body.intervalMs : intervalMs)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, wait)
          wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
      }
    } finally {
      this.deviceCancelled = null
    }
  }
}
