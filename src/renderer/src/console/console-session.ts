/**
 * THE CONSOLE'S SESSION (0.6.0).
 *
 * console.cookrew.dev is a static page on its own origin: no cookie reaches
 * the registry from it, so its session is a token this page holds and sends
 * as a header. A token a page can read is a token an injected script could
 * read, so the registry makes this one SHORT (fifteen minutes) and NARROW (it
 * reads the account's machines, takes the device pass and reaches machines;
 * every sensitive act of the account is refused it and lives on the auth
 * host). What keeps the page signed in across those fifteen minutes is the
 * device key (device-key.ts), which a script can use but cannot take away.
 *
 * SIGNING IN NEVER HAPPENS ON THIS PAGE. The page opens a request with its
 * device key and a PKCE challenge of its own, the person signs in on
 * auth.cookrew.dev, and the browser comes back to /auth/complete with a
 * one-use code that only the holder of the verifier can spend. The verifier
 * waits in sessionStorage for the length of that round trip and is dropped
 * the moment it is spent.
 *
 * THE DEVICE PASS BY PASSWORD is the same round trip with another intent
 * (`grant`): a password is typed on the auth host and nowhere else (decision
 * F5). A passkey is touched in place (console-gate.ts).
 *
 * Everything outside the rule is injected (the registry, storage, the clock,
 * navigation), so the whole of it runs in node against the real registry.
 */
import { isAuthTranscript } from '../../../shared/auth-site'
import { renewMessage } from '../../../shared/session-renew'
import type { DeviceGrant } from '../../../shared/account-pair'
import type { ConsoleDevice } from './device-key'

export interface Answer {
  readonly status: number
  readonly body: unknown
}

/** One call at the registry's API origin. Never throws for an HTTP status; status 0 is "did not arrive". */
export type RegistryCall = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, headers?: Record<string, string>) => Promise<Answer>

export interface KeyValue {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type SessionState =
  | { readonly status: 'starting' }
  | { readonly status: 'signed-out' }
  | { readonly status: 'signed-in'; readonly username: string }

export type AuthIntent = 'sign-in' | 'grant'

export type CompleteResult =
  | { readonly ok: true; readonly intent: AuthIntent; readonly returnTo: string; readonly grant?: DeviceGrant }
  | { readonly ok: false; readonly intent: AuthIntent | null; readonly returnTo: string; readonly message: string }

export interface SignOutResult {
  readonly ended: boolean
}

export type StartResult = { readonly ok: true } | { readonly ok: false; readonly message: string }

export interface SessionDeps {
  readonly registry: RegistryCall
  /** Where signing in happens. The only origin this page ever sends the browser to. */
  readonly authOrigin: string
  readonly device: () => Promise<ConsoleDevice>
  /** Erase this browser's key (device-key.ts). Asked for only when a sign-out could not be made at the registry. */
  readonly forgetDevice?: () => Promise<void>
  /** Survives the tab: the session, so a reopened page is still signed in. */
  readonly kept: KeyValue
  /** Lives for the tab: the verifier of a round trip in progress. */
  readonly pending: KeyValue
  readonly navigate: (url: string) => void
  readonly now?: () => number
  readonly random?: (bytes: Uint8Array<ArrayBuffer>) => void
  readonly setTimer?: (run: () => void, ms: number) => unknown
  readonly clearTimer?: (timer: unknown) => void
}

export interface ConsoleSession {
  get(): SessionState
  subscribe(listener: () => void): () => void
  /** The session, for a request leaving now; null when there is none that the registry would still take. */
  token(): string | null
  /** Read what the page kept and make it current: renewed if it is old, dropped if the registry no longer takes it. */
  boot(): Promise<void>
  /** A token good for a while yet, renewing first if need be; null when signed out. */
  fresh(): Promise<string | null>
  /** The registry refused the token: renew it, or learn that the sign-in is over. */
  refused(): void
  /**
   * Another tab of this browser changed what is kept: take a token it renewed (a renewal closes
   * the one this tab held), and be signed out if it signed out.
   */
  reread(): void
  signIn(returnTo: string): Promise<StartResult>
  /** The device pass by password: typed on the auth host, never here. */
  passByPassword(returnTo: string): Promise<StartResult>
  /** Back from the auth host with a code. */
  complete(back: { code: string | null; state: string | null; error: string | null }): Promise<CompleteResult>
  /**
   * End the sign-in. `ended` is whether the REGISTRY ended it. When it could not be told, this
   * browser's key is erased instead: the key is what could have renewed the sign-in later.
   */
  signOut(): Promise<SignOutResult>
}

export const SESSION_KEY = 'cr_console_session'
export const PENDING_KEY = 'cr_console_auth'
/** Renewed this long before it ends: a request already on its way must not arrive with a dead token. */
export const RENEW_BEFORE_MS = 3 * 60 * 1000
/** A round trip to the auth host that took longer than this is not completed: its verifier is dropped. */
export const PENDING_TTL_MS = 15 * 60 * 1000
/** A token with less than this left is not sent: it would be dead on arrival. */
const DEAD_ON_ARRIVAL_MS = 5_000
const RETRY_RENEW_MS = 30_000
/** A refusal renews at most this often. */
export const REFUSED_EVERY_MS = 30_000

interface Held {
  readonly token: string
  readonly exp: number
  readonly username: string
  readonly deviceId: string
}

interface Pending {
  readonly state: string
  readonly verifier: string
  readonly intent: AuthIntent
  readonly returnTo: string
  readonly at: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const b64u = (bytes: ArrayBuffer | Uint8Array): string => {
  let text = ''
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const encoder = new TextEncoder()

const readHeld = (value: unknown): Held | null =>
  isRecord(value) && typeof value.token === 'string' && typeof value.exp === 'number' && typeof value.username === 'string' && typeof value.deviceId === 'string'
    ? { token: value.token, exp: value.exp, username: value.username, deviceId: value.deviceId }
    : null

const readPending = (value: unknown): Pending | null =>
  isRecord(value) &&
  typeof value.state === 'string' &&
  typeof value.verifier === 'string' &&
  (value.intent === 'sign-in' || value.intent === 'grant') &&
  typeof value.returnTo === 'string' &&
  typeof value.at === 'number'
    ? { state: value.state, verifier: value.verifier, intent: value.intent, returnTo: value.returnTo, at: value.at }
    : null

const parsed = (raw: string | null): unknown => {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/** A path of this page to come back to: same origin by construction, never a URL. */
export const safeReturn = (path: string): string => (/^\/(?!\/)[^\s\\]*$/.test(path) && !path.startsWith('/auth/') ? path : '/')

const messageOf = (answer: Answer, fallback: string): string =>
  isRecord(answer.body) && typeof answer.body.message === 'string' ? answer.body.message : fallback

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

export function createConsoleSession(deps: SessionDeps): ConsoleSession {
  const now = deps.now ?? Date.now
  const random = deps.random ?? ((bytes: Uint8Array<ArrayBuffer>): void => void crypto.getRandomValues(bytes))
  const setTimer = deps.setTimer ?? ((run: () => void, ms: number): unknown => setTimeout(run, ms))
  const clearTimer = deps.clearTimer ?? ((timer: unknown): void => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const authOrigin = deps.authOrigin.replace(/\/+$/, '')
  const listeners = new Set<() => void>()
  let held: Held | null = null
  let state: SessionState = { status: 'starting' }
  let timer: unknown = null
  let renewing: Promise<string | null> | null = null
  let refusedAt = Number.NEGATIVE_INFINITY

  const tell = (next: SessionState): void => {
    const same = next.status === state.status && (next.status !== 'signed-in' || (state.status === 'signed-in' && state.username === next.username))
    state = same ? state : next
    if (!same) for (const listener of listeners) listener()
  }

  const safely = (act: () => void): void => {
    try {
      act()
    } catch {
      // Storage that refuses keeps nothing: the page signs in again next time.
    }
  }

  const schedule = (): void => {
    if (timer !== null) clearTimer(timer)
    timer = null
    if (held === null) return
    timer = setTimer(() => {
      timer = null
      void renew()
    }, Math.max(0, held.exp - now() - RENEW_BEFORE_MS))
  }

  const keep = (next: Held): void => {
    held = next
    safely(() => deps.kept.setItem(SESSION_KEY, JSON.stringify(next)))
    tell({ status: 'signed-in', username: next.username })
    schedule()
  }

  /**
   * Signed out on this page. What the browser keeps is removed with it, unless it is no longer
   * this page's (another tab signed in again since): that is the other tab's to keep.
   */
  const drop = (always = false): void => {
    const was = held
    held = null
    if (timer !== null) clearTimer(timer)
    timer = null
    const kept = always || was === null ? null : readKept()
    if (kept === null || kept.token === was?.token || (kept.username === was?.username && kept.deviceId === was?.deviceId)) safely(() => deps.kept.removeItem(SESSION_KEY))
    tell({ status: 'signed-out' })
  }

  function readKept(): Held | null {
    try {
      return readHeld(parsed(deps.kept.getItem(SESSION_KEY)))
    } catch {
      return null
    }
  }

  /**
   * ANOTHER TAB MAY HAVE RENEWED ALREADY. Every tab of a browser is the same device, and a
   * renewal closes the device's other sessions: two tabs each renewing would keep closing each
   * other's. So before renewing, this tab looks at what the browser kept and takes a later token
   * of the same sign-in if one is there.
   */
  const adoptKept = (): string | null => {
    const kept = readKept()
    // Not older, and not the one already held: at the end of a sign-in's thirty days every token ends at the same moment.
    if (held === null || kept === null || kept.username !== held.username || kept.deviceId !== held.deviceId || kept.token === held.token || kept.exp < held.exp) return null
    held = kept
    schedule()
    return kept.token
  }

  /** One renewal asked of the registry with the device key: its answer, or status 0 when it could not be asked. */
  const askRenewal = async (username: string, device: ConsoleDevice): Promise<Answer> => {
    const asked = await deps.registry('GET', '/v2/sessions/renew-nonce')
    const nonce = isRecord(asked.body) && typeof asked.body.nonce === 'string' ? asked.body.nonce : null
    if (asked.status !== 200 || nonce === null) return { status: 0, body: null }
    const sig = b64u(await device.sign(encoder.encode(renewMessage(username, device.id, nonce))))
    return deps.registry('POST', '/v2/sessions/renew', { device: device.id, nonce, sig })
  }

  /**
   * IS THE SIGN-IN REALLY OVER AT THE REGISTRY. Its answer to "end this session" says yes whatever
   * token it was handed, and another tab may have renewed past the one this page held. The key is
   * what could bring a sign-in back, so the key is asked: refused, the sign-in is over; renewed,
   * there was one still open, and the session that renewal made is ended in turn.
   */
  const endedAtRegistry = async (username: string): Promise<boolean> => {
    let device: ConsoleDevice
    try {
      device = await deps.device()
    } catch {
      return false
    }
    for (let turn = 0; turn < 2; turn += 1) {
      const probe = await askRenewal(username, device).catch((): Answer => ({ status: 0, body: null }))
      if (probe.status === 401) return true
      const open = probe.status === 201 ? readHeld(probe.body) : null
      if (open === null) return false
      await deps.registry('DELETE', '/v2/sessions/current', undefined, bearer(open.token)).catch(() => null)
    }
    return false
  }

  /** The same sign-in, a new fifteen minutes: the device key signs the registry's nonce. */
  const renewOnce = async (): Promise<string | null> => {
    const adopted = adoptKept()
    if (adopted !== null && held !== null && held.exp - now() > RENEW_BEFORE_MS) return adopted
    const was = held
    if (was === null) return null
    let device: ConsoleDevice
    try {
      device = await deps.device()
    } catch {
      return null
    }
    // The key is this browser's; the session is that key's. A page whose key is another one has no session to renew.
    if (device.id !== was.deviceId) {
      drop()
      return null
    }
    const renewed = await askRenewal(was.username, device)
    if (renewed.status === 201) {
      const next = readHeld(renewed.body)
      if (held !== was) {
        // ANOTHER TAB'S TOKEN WAS TAKEN UP while this renewal was out. Both are the same sign-in,
        // and the registry keeps only the one it made last, which is the one that ends later: that
        // one is held. Neither is ever deleted: deleting would end the sign-in for every tab.
        if (next !== null && held !== null && held.username === next.username && held.deviceId === next.deviceId) {
          if (next.exp > held.exp) keep(next)
          return held.token
        }
        // Signed out (or signed in as someone else) meanwhile: the session this made is nobody's, and is ended.
        if (next !== null) void deps.registry('DELETE', '/v2/sessions/current', undefined, bearer(next.token)).catch(() => null)
        return held?.token ?? null
      }
      if (next !== null && next.username === was.username && next.deviceId === was.deviceId) {
        keep(next)
        return next.token
      }
      return retryLater(was)
    }
    // The registry says this sign-in is over (thirty days, a week unused, the device taken back).
    if (renewed.status === 401) {
      if (held === was) drop()
      return null
    }
    return retryLater(was)
  }

  /** The registry did not answer, or not with a yes or a no: the session stands while it lasts, and is asked for again. */
  const retryLater = (was: Held): string | null => {
    if (held !== was) return held?.token ?? null
    if (timer !== null) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      void renew()
    }, RETRY_RENEW_MS)
    return was.exp - now() > DEAD_ON_ARRIVAL_MS ? was.token : null
  }

  const renew = (): Promise<string | null> => {
    renewing ??= renewOnce()
      .catch(() => (held === null ? null : retryLater(held)))
      .finally(() => {
        renewing = null
      })
    return renewing
  }

  const usable = (): string | null => (held !== null && held.exp - now() > DEAD_ON_ARRIVAL_MS ? held.token : null)

  /** Open a request on the auth host for this device, prove the key, and go there. */
  const start = async (intent: AuthIntent, returnTo: string): Promise<StartResult> => {
    const fallback = intent === 'grant' ? 'Confirming it is you could not start. Try again in a moment.' : 'Sign-in could not start. Try again in a moment.'
    let device: ConsoleDevice
    try {
      device = await deps.device()
    } catch {
      return { ok: false, message: 'This browser cannot keep a key for Cookrew. Private browsing does this: open the console in a normal window.' }
    }
    const session = intent === 'grant' ? await fresh() : null
    if (intent === 'grant' && session === null) return { ok: false, message: 'Sign in first.' }
    const secret = new Uint8Array(32)
    random(secret)
    const nonce = new Uint8Array(16)
    random(nonce)
    const verifier = b64u(secret)
    const stateToken = b64u(nonce)
    const challenge = b64u(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)))
    const opened = await deps.registry(
      'POST',
      '/v2/auth/requests',
      { client: 'console', ...(intent === 'grant' ? { intent } : {}), device: device.payload, challenge, state: stateToken },
      session === null ? {} : bearer(session)
    )
    const body = isRecord(opened.body) ? opened.body : {}
    if (opened.status !== 201 || typeof body.request !== 'string' || typeof body.authorizeUrl !== 'string') return { ok: false, message: messageOf(opened, fallback) }
    // THE ONE PLACE THIS PAGE SENDS THE BROWSER: the auth host it was built for, whatever the answer says.
    let target: URL
    try {
      target = new URL(body.authorizeUrl)
    } catch {
      return { ok: false, message: fallback }
    }
    if (target.origin !== authOrigin) return { ok: false, message: fallback }
    // The key also says who this browser is: it signs this protocol's string, for this request, this auth host and this device, and nothing else.
    if (!isAuthTranscript(body.transcript, body.request, { audience: authOrigin, deviceId: device.id })) return { ok: false, message: fallback }
    const signature = b64u(await device.sign(encoder.encode(String(body.transcript))))
    const proved = await deps.registry('POST', `/v2/auth/requests/${encodeURIComponent(body.request)}/proof`, { signature })
    if (proved.status !== 204) return { ok: false, message: messageOf(proved, fallback) }
    const waiting: Pending = { state: stateToken, verifier, intent, returnTo: safeReturn(returnTo), at: now() }
    try {
      deps.pending.setItem(PENDING_KEY, JSON.stringify(waiting))
    } catch {
      return { ok: false, message: 'This browser keeps nothing for this page, so it could not come back signed in. Private browsing does this.' }
    }
    deps.navigate(target.toString())
    return { ok: true }
  }

  const fresh = async (): Promise<string | null> => {
    if (held === null) return null
    if (held.exp - now() > RENEW_BEFORE_MS) return held.token
    return renew()
  }

  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    token: usable,
    fresh,
    reread: () => {
      if (state.status === 'starting') return
      const kept = readKept()
      // Signed out in another tab.
      if (kept === null) return held === null ? undefined : drop()
      if (held === null) {
        // Signed in in another tab.
        held = kept
        tell({ status: 'signed-in', username: kept.username })
        return schedule()
      }
      adoptKept()
    },
    refused: () => {
      if (adoptKept() !== null) return
      // Whoever answers through the relay can say this word; it buys one renewal per while, not one per answer.
      if (now() - refusedAt < REFUSED_EVERY_MS) return
      refusedAt = now()
      void renew()
    },
    boot: async () => {
      let kept: Held | null = null
      try {
        kept = readHeld(parsed(deps.kept.getItem(SESSION_KEY)))
      } catch {
        kept = null
      }
      if (kept === null) return drop()
      held = kept
      if (kept.exp - now() > RENEW_BEFORE_MS) {
        tell({ status: 'signed-in', username: kept.username })
        return schedule()
      }
      // Old or ended: the device key says whether the sign-in still stands.
      await renew()
      if (held !== null) tell({ status: 'signed-in', username: held.username })
    },
    signIn: (returnTo) => start('sign-in', returnTo),
    passByPassword: (returnTo) => start('grant', returnTo),
    complete: async (back) => {
      let waiting: Pending | null = null
      try {
        waiting = readPending(parsed(deps.pending.getItem(PENDING_KEY)))
      } catch {
        waiting = null
      }
      // Spent or not, a round trip is over once the browser is back: its verifier does not wait for a second try.
      safely(() => deps.pending.removeItem(PENDING_KEY))
      const returnTo = waiting?.returnTo ?? '/'
      const failed = (message: string): CompleteResult => ({ ok: false, intent: waiting?.intent ?? null, returnTo, message })
      // A way back nobody on this page asked for (another tab's, a link somebody sent) is spent by nobody.
      if (waiting === null || back.state === null || back.state !== waiting.state) return failed('That sign-in was not started in this tab. Start again here.')
      if (now() - waiting.at > PENDING_TTL_MS) return failed('That took too long. Start again.')
      if (back.code === null) return failed(back.error === 'cancelled' ? 'Cancelled.' : 'That did not finish. Try again.')
      if (waiting.intent === 'grant') {
        const session = await fresh()
        if (session === null) return failed('Sign in first.')
        const spent = await deps.registry('POST', '/v2/auth/token', { code: back.code, verifier: waiting.verifier }, bearer(session))
        const body = isRecord(spent.body) ? spent.body : {}
        if (spent.status !== 201 || typeof body.grant !== 'string' || typeof body.exp !== 'number' || typeof body.deviceId !== 'string') {
          return failed(messageOf(spent, 'That did not finish. Try again.'))
        }
        return { ok: true, intent: 'grant', returnTo, grant: { grant: body.grant, exp: body.exp, deviceId: body.deviceId } }
      }
      const spent = await deps.registry('POST', '/v2/auth/token', { code: back.code, verifier: waiting.verifier })
      const signedIn = spent.status === 201 ? readHeld(spent.body) : null
      if (signedIn === null) return failed(messageOf(spent, 'Sign-in did not finish. Try again.'))
      keep(signedIn)
      return { ok: true, intent: 'sign-in', returnTo }
    },
    signOut: async () => {
      // THE SIGN-IN IS ENDED AT THE REGISTRY, not just forgotten here. The device key renews a
      // sign-in with no token at all, and is kept across a sign-out, so a page that only dropped
      // its token would leave a sign-in anyone at this browser could pick up again.
      // A renewal on its way is waited for, and a token another tab renewed is taken up first:
      // the one they replace would end nothing.
      if (renewing !== null) await renewing.catch(() => null)
      adoptKept()
      const token = await fresh().catch(() => null)
      const who = held?.username ?? null
      drop(true)
      // Renewing found the sign-in already over.
      if (who === null) return { ended: true }
      if (token !== null) await deps.registry('DELETE', '/v2/sessions/current', undefined, bearer(token)).catch(() => null)
      if (await endedAtRegistry(who)) return { ended: true }
      await deps.forgetDevice?.().catch(() => undefined)
      return { ended: false }
    }
  }
}
