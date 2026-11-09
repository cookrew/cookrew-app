import type { ProviderId } from './oauth'

/**
 * AUTH.COOKREW.DEV — THE ONE SIGN-IN PAGE, and the facts its three clients and
 * the registry must agree on.
 *
 * Every client (the cookrew.dev pages, the desktop app, `cookrew login`) signs
 * in the same way: it opens an AUTH REQUEST on the product origin naming the
 * device key the session will belong to, proves it holds that key, and sends a
 * real browser to the auth origin. The person authenticates there; the ladder
 * (passkey, two-step, device approval, recovery) runs there; and what comes
 * back is a short-lived ONE-USE CODE that only the client holding the PKCE
 * verifier can spend. A session token never reaches the auth page's script.
 *
 * WIRE, product origin (https://cookrew.dev):
 *
 *   POST /v2/auth/requests                     AuthRequestBody → 201 AuthRequestCreated
 *        404 means a registry without this feature: fall back to the old sheet.
 *   POST /v2/auth/requests/:request/proof      { signature } → 204
 *        `signature` is the device key's signature over `transcript`, base64url:
 *        Ed25519 raw (64 bytes) or ECDSA P-256 r‖s (64 bytes, WebCrypto's form).
 *   POST /v2/auth/token                        desktop { code, verifier }
 *                                              cli     { request, verifier }
 *        201 AuthSignedIn · 200 { status: 'linked', provider } (a link request)
 *        202 { status: 'pending', intervalMs } (cli, not finished yet)
 *        410 { error: 'flow_over', why: 'denied' | 'expired' } · 401 bad_credentials
 *   GET  /auth/complete?code&state             the web return: redeemed server-side
 *        with the verifier in __Host-cr_auth_web, then 303 to the request's path.
 *
 * THE WAY BACK TO THE DESKTOP is the legacy return with `code` in place of
 * `handoff`: cookrew://oauth#code=…&state=… or #error=denied|expired&state=…,
 * or the same fields as a query on http://127.0.0.1:<port>/oauth/return.
 */

export type AuthClient = 'web' | 'desktop' | 'cli'

export const AUTH_CLIENTS: readonly AuthClient[] = ['web', 'desktop', 'cli']

export const isAuthClient = (value: unknown): value is AuthClient =>
  typeof value === 'string' && (AUTH_CLIENTS as readonly string[]).includes(value)

/**
 * WHICH SCREEN THE PAGE OPENS ON. It is a hint about the first screen and
 * nothing else: every intent can reach every way in, except the two signed-in
 * acts. `link` is only ever a provider trip; `passkey` adds a passkey to the
 * account that opened it, after the account's own step-up on the page.
 */
export type AuthIntent = 'sign-in' | 'create' | 'github' | 'google' | 'link' | 'passkey'

export const AUTH_INTENTS: readonly AuthIntent[] = ['sign-in', 'create', 'github', 'google', 'link', 'passkey']

/** The intents a signed-in client opens for its own account; nobody signs in on them. */
export const SIGNED_IN_INTENTS: readonly AuthIntent[] = ['link', 'passkey']

/**
 * ADDING A PASSKEY, as the page reads it. `needs` is what stands between the
 * person and the ceremony: `provider` (an account with no password proves it
 * is them with a provider it already linked, once, for this one passkey) or
 * `ready`. `providers` names the ones this account can prove itself with.
 */
export interface AuthEnrolment {
  needs: 'provider' | 'ready'
  providers: readonly ProviderId[]
}

/**
 * What the spending client gets back for a `passkey` request: the passkey, as
 * /v2/me/factors lists it. The web never sees this; /auth/complete writes it
 * and lands on `/me?passkey=added`.
 */
export interface AuthPasskeyAdded {
  status: 'passkey'
  passkey: { id: string; name: string; addedAt: number }
}

export const isAuthIntent = (value: unknown): value is AuthIntent =>
  typeof value === 'string' && (AUTH_INTENTS as readonly string[]).includes(value)

/** A request lives as long as a pending sign-in does. */
export const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000
/** A code is a moment: long enough to switch windows. */
export const AUTH_CODE_TTL_MS = 2 * 60 * 1000
/** How often `cookrew login` may ask whether the browser has finished. */
export const AUTH_POLL_MS = 5000

/** The short code a terminal prints: two blocks of four, no vowels, no look-alikes. */
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
export const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/

/** As a person types it: case, spaces and a missing dash forgiven. */
export function normaliseUserCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const letters = raw.toUpperCase().replace(/[^A-Z]/g, '')
  if (letters.length !== 8) return null
  const code = `${letters.slice(0, 4)}-${letters.slice(4)}`
  return USER_CODE.test(code) ? code : null
}

/** The device a session will belong to — the same shape every /v2 sign-in sends. */
export interface AuthDevice {
  id: string
  kind: 'desktop' | 'phone' | 'browser'
  name: string
  jwk: Record<string, unknown>
}

export interface AuthRequestBody {
  client: AuthClient
  intent?: AuthIntent
  /** `link` only: the provider to add. */
  provider?: ProviderId
  device: AuthDevice
  /** desktop and cli: base64url SHA-256 of the client's verifier (43 chars). The web's is the server's own. */
  challenge?: string
  /** desktop: the client's own CSRF token, echoed on the way back. 16–128 base64url chars. */
  state?: string
  /** desktop: where the browser goes back to. No URL field, on purpose. */
  back?: { scheme: boolean; port?: number }
  /** web: the same-site path to land on afterwards, e.g. `/me`. */
  return?: string
  /** A prefill for the username field (a resume). Never trusted for anything. */
  username?: string
  /** `link` only, with a session: the fresh proof (`current` password or a `stepUp` id). */
  current?: string
  stepUp?: string
}

export interface AuthRequestCreated {
  request: string
  /** The exact UTF-8 string the device must sign. */
  transcript: string
  expiresAt: number
  /** Open this in a real browser once the proof is accepted. */
  authorizeUrl: string
  /** cli only. */
  userCode?: string
  verificationUri?: string
  verificationUriComplete?: string
  intervalMs?: number
}

/** A finished sign-in, as the client that holds the verifier receives it. */
export interface AuthSignedIn {
  token: string
  exp: number
  deviceId: string
  username: string
  hasPassword: boolean
}

/**
 * WHAT THE PAGE DOES WHEN THE PERSON IS THROUGH.
 *
 *   web — navigate to `url` (cookrew.dev/auth/complete with the code).
 *   app — open `url` (cookrew://…); `fallback` is the loopback link when the
 *         desktop listens on one.
 *   cli — nothing travels: the terminal collects it. Say so.
 */
export type AuthHandoff =
  | { kind: 'web'; url: string }
  | { kind: 'app'; url: string; fallback: string | null }
  | { kind: 'cli' }

/** The page's own reading of a request: who is asking, before anyone authenticates. */
export interface AuthRequestSummary {
  request: string
  client: AuthClient
  /** 'cookrew.dev', 'Cookrew desktop app', 'cookrew login'. */
  clientLabel: string
  /** What the asking device calls itself. Shown in quotes: it is the asker's word. */
  device: { name: string; kind: AuthDevice['kind'] }
  intent: AuthIntent
  provider: ProviderId | null
  /** A prefill, or for a link the account being added to. */
  username: string | null
  userCode: string | null
  /** The host the person lands on afterwards, for the web: `cookrew.dev`. */
  returnHost: string | null
  createdAt: number
  expiresAt: number
  providers: readonly { id: ProviderId; label: string }[]
  /** 'provider' when a provider trip came back and `continue` should be called. */
  stage: 'open' | 'provider' | 'done' | 'denied'
  /** A `passkey` request only: what the ceremony still needs. */
  enrol: AuthEnrolment | null
}

/** The header every page call on the auth origin carries. */
export const AUTH_REQUEST_HEADER = 'x-cookrew-auth-request'
/** The auth origin's one cookie: this browser's random binding secret. */
export const AUTH_BINDING_COOKIE = '__Host-cr_auth'
/** The product origin's web-return cookie: `<request>.<verifier>`. */
export const AUTH_WEB_COOKIE = '__Host-cr_auth_web'

/** Who is asking, in words the page puts above every screen. */
export function clientLabelOf(client: AuthClient): string {
  if (client === 'web') return 'cookrew.dev'
  if (client === 'desktop') return 'Cookrew desktop app'
  return 'cookrew login'
}

/**
 * A SAME-SITE PATH, or null. The only thing about the web return a request may
 * choose; the host and the route are the server's own.
 */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return null
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null
  return /^\/[A-Za-z0-9/_@.~-]*$/.test(raw) ? raw : null
}

/**
 * THE FIRST TWO LINES OF EVERY AUTH TRANSCRIPT, one copy for the registry
 * that writes them and the clients that sign them. A device key also signs
 * hellos, reach cards and renewals, so a client signs a registry's string only
 * when it is this protocol's, for the request it opened: a key that signed
 * whatever it was sent would be a signing service for anything else it vouches for.
 */
export const AUTH_TRANSCRIPT_CONTEXT = 'cookrew-auth/device-transaction/v1'
export const AUTH_TRANSCRIPT_PURPOSE = 'authenticate-device'

/**
 * Is this an auth transcript naming this request — and, when the client knows
 * them, the auth origin it opens and the device it offered? A registry that
 * slipped another audience or another key into the string gets no signature.
 */
export function isAuthTranscript(
  transcript: unknown,
  request: string,
  expect: { audience?: string; deviceId?: string } = {}
): boolean {
  if (typeof transcript !== 'string') return false
  const lines = transcript.split('\n')
  return (
    lines[0] === AUTH_TRANSCRIPT_CONTEXT &&
    lines[1] === `purpose:${AUTH_TRANSCRIPT_PURPOSE}` &&
    lines.includes(`transaction:${request}`) &&
    (expect.audience === undefined || lines.includes(`audience:${expect.audience}`)) &&
    (expect.deviceId === undefined || lines.includes(`device:${expect.deviceId}`))
  )
}
