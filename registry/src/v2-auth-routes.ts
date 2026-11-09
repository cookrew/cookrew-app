import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AUTH_BINDING_COOKIE,
  AUTH_POLL_MS,
  AUTH_REQUEST_HEADER,
  AUTH_WEB_COOKIE,
  clientLabelOf,
  isAuthClient,
  isAuthIntent,
  safeReturnPath,
  type AuthClient,
  type AuthDevice,
  type AuthRequestSummary
} from '../../src/shared/auth-site'
import { PROVIDER_LABEL, isProviderId, type OAuthBack, type ProviderId } from '../../src/shared/oauth'
import { readJsonBody } from './http'
import type { AuthOpener, AuthRequest } from './auth-requests'
import { handoffFor, productOrigin } from './auth-finish'
import { cookie, refuse, signedIn, v2Json, asking, type V2Context, type V2Identity } from './v2-http'
import { deviceShape } from './v2-factor-http'
import { factorError } from './v2-factor-copy'
import { stepUpHeld } from './v2-step-up'
import { continueRequest } from './v2-oauth-routes'
import { enrolmentOf, passkeyOnPage, passkeyOptionsOnPage, writeHeldPasskey } from './auth-passkey'

/**
 * AUTH.COOKREW.DEV — THE REQUEST ROUTES.
 *
 * On the product origin, a client opens a request, proves its key and spends
 * the code it gets back. On the auth origin, the page claims a request for
 * its browser, continues a provider trip and cancels. Everything the page
 * does in between is the ladder's own /v2 routes, reached through auth-host.ts
 * with the request bound.
 */

const SMALL_BODY = 16 * 1024
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/
const CLIENT_STATE = /^[A-Za-z0-9_-]{16,128}$/
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
const PORT_MIN = 1024
const PORT_MAX = 65535
const BINDING_MAX_AGE_S = 60 * 60
const WEB_COOKIE_MAX_AGE_S = 15 * 60

const SENTENCES = {
  bad_flow: 'That sign-in request could not be read. Start again.',
  flow_over: 'That sign-in is over. Start again.',
  bad_proof: 'This device could not prove its key. Start again.',
  expired: 'This sign-in timed out. Start again from the app that asked.',
  claimed: 'This sign-in was opened in another browser. Start again from the app that asked.',
  no_code: 'That code is not one we know. Check it against your terminal.',
  oauth_off: 'This sign-in is not available here.',
  use_code: 'Type the code from your terminal at the device page instead.',
  signed_out: 'Sign in first, then add the passkey from Security.',
  other_device: 'Add the passkey from the device you are signed in on. If this is that device, sign out and sign in again here first.'
} as const

type Sentence = keyof typeof SENTENCES

const refuseAuth = (response: ServerResponse, code: number, error: Sentence, extra: Record<string, unknown> = {}): void =>
  v2Json(response, code, { error, message: SENTENCES[error], ...extra })

const token = (): string => randomBytes(32).toString('base64url')
const s256 = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url')

/** One cookie by name, or null; two of the same name read as none. */
export function cookieOf(request: IncomingMessage, name: string): string | null {
  const found = (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
  if (found.length !== 1) return null
  const value = found[0].slice(name.length + 1)
  return /^[A-Za-z0-9._-]{1,200}$/.test(value) ? value : null
}

function readBack(value: unknown): OAuthBack | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { scheme, port } = value as { scheme?: unknown; port?: unknown }
  const portOk = typeof port === 'number' && Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX
  if (port !== undefined && !portOk) return null
  if (scheme !== true && !portOk) return null
  return { scheme: scheme === true, ...(portOk ? { port: port as number } : {}) }
}

/** The kinds of device each client may bind. A terminal is the machine it runs on. */
function kindFits(client: AuthClient, kind: string): boolean {
  return client === 'web' ? kind === 'browser' || kind === 'phone' : kind === 'desktop'
}

// ── the product origin ──────────────────────────────────────────────────────

/** Run a route; a throw is a 500 with a sentence, never a request left hanging. */
function run(ctx: V2Context, work: () => Promise<void>): void {
  void work().catch(() => {
    if (!ctx.response.headersSent) refuse(ctx.response, 500, 'malformed')
    else ctx.response.end()
  })
}

/** Answers true when it claimed the request. Mounted first in v2-routes. */
export function handleAuthRoute(ctx: V2Context, rest: readonly string[]): boolean {
  if (rest[0] !== 'auth') return false
  const { method, response } = ctx
  // OFF, OR ASKED ON THE AUTH ORIGIN: exactly what an older registry answers,
  // which is how a new client knows to fall back to its own sheet.
  if (ctx.v2.auth === null || ctx.auth !== undefined) {
    refuse(response, 404, 'not_found')
    return true
  }
  if (rest.length === 2 && rest[1] === 'requests' && method === 'POST') {
    run(ctx, () => openRequest(ctx))
    return true
  }
  if (rest.length === 4 && rest[1] === 'requests' && rest[3] === 'proof' && method === 'POST') {
    run(ctx, () => proveRequest(ctx, ctx.decode(rest[2]) ?? ''))
    return true
  }
  if (rest.length === 2 && rest[1] === 'token' && method === 'POST') {
    run(ctx, () => spend(ctx))
    return true
  }
  refuse(response, 404, 'not_found')
  return true
}

interface Parsed {
  client: AuthClient
  intent: AuthRequest['intent']
  provider: ProviderId | null
  device: AuthDevice
}

/** The shape of a request body, or the refusal already written. */
function parse(ctx: V2Context, body: Record<string, unknown>): Parsed | null {
  const providers = ctx.v2.oauth.providers
  const client = body.client
  const intent = body.intent === undefined ? 'sign-in' : body.intent
  if (!isAuthClient(client) || !isAuthIntent(intent)) {
    refuseAuth(ctx.response, 400, 'bad_flow')
    return null
  }
  if ((intent === 'github' || intent === 'google') && !providers.has(intent)) {
    refuseAuth(ctx.response, 404, 'oauth_off')
    return null
  }
  let provider: ProviderId | null = null
  if (intent === 'link') {
    // Only a desktop links through the page: its code comes back to a client
    // that holds the opener's session. The web has no such client.
    if (client !== 'desktop' || !isProviderId(body.provider) || !providers.has(body.provider)) {
      refuseAuth(ctx.response, 400, 'bad_flow')
      return null
    }
    provider = body.provider
  }
  // A passkey is added from a client holding a session that can spend the
  // code: the app or cookrew.dev. A terminal has no browser to come back to.
  if (intent === 'passkey' && client === 'cli') {
    refuseAuth(ctx.response, 400, 'bad_flow')
    return null
  }
  const shape = deviceShape(body.device)
  if (shape === null || !kindFits(client, shape.kind)) {
    refuse(ctx.response, 400, 'bad_device')
    return null
  }
  return { client, intent, provider, device: body.device as AuthDevice }
}

/** POST /v2/auth/requests */
async function openRequest(ctx: V2Context): Promise<void> {
  const { v2, response } = ctx
  const auth = v2.auth
  if (auth === null) return
  if (!v2.limits.oauth.take(`auth|${asking(ctx)}`)) {
    refuse(response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
    return
  }
  const read = await readJsonBody(ctx.request, SMALL_BODY)
  if (!read.ok) {
    refuse(response, read.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const body = read.value
  const parsed = parse(ctx, body)
  if (parsed === null) return
  const { client } = parsed

  let challenge: string
  let clientState: string | null = null
  let back: OAuthBack | null = null
  let verifier: string | null = null
  if (client === 'web') {
    // THE WEB'S VERIFIER IS THE SERVER'S OWN. It lives in an HttpOnly cookie on
    // the product origin and never reaches a script; the page that comes back
    // with the code cannot spend it without the browser that started.
    verifier = token()
    challenge = s256(verifier)
    clientState = token()
  } else {
    if (typeof body.challenge !== 'string' || !CHALLENGE.test(body.challenge)) {
      refuseAuth(response, 400, 'bad_flow')
      return
    }
    challenge = body.challenge
    if (client === 'desktop') {
      back = readBack(body.back)
      if (typeof body.state !== 'string' || !CLIENT_STATE.test(body.state) || back === null) {
        refuseAuth(response, 400, 'bad_flow')
        return
      }
      clientState = body.state
    }
  }

  // A LINK IS A SIGNED-IN ACT, proven before the trip like the app's own link:
  // the session that asks, on the device it asks from, with a fresh proof.
  let opener: AuthOpener | null = null
  if (parsed.intent === 'link') {
    const signed = signedIn(ctx.request, v2)
    if (signed === null) {
      refuse(response, 401, 'unauthenticated')
      return
    }
    if (shapeId(parsed.device) !== signed.claims.dev) {
      refuse(response, 403, 'not_this_device')
      return
    }
    if (!(await stepUpHeld(ctx, signed, 'link-provider', body))) return
    opener = { username: signed.account.username, jti: signed.claims.jti, device: signed.claims.dev }
  }
  /**
   * A PASSKEY IS ALSO A SIGNED-IN ACT, and its proof comes on the page rather
   * than here: the one proof an account with no password has is a provider
   * round trip, and the page is where a browser can make one. Nothing about
   * the session is carried to the page but who opened it.
   */
  if (parsed.intent === 'passkey') {
    const signed = signedIn(ctx.request, v2)
    if (signed === null) {
      refuseAuth(response, 401, 'signed_out', { error: 'unauthenticated' })
      return
    }
    if (shapeId(parsed.device) !== signed.claims.dev) {
      refuseAuth(response, 403, 'other_device', { error: 'not_this_device' })
      return
    }
    if (v2.factors.store.mustChangePassword(signed.account.username)) {
      v2Json(response, 403, factorError('password_change_required'))
      return
    }
    opener = { username: signed.account.username, jti: signed.claims.jti, device: signed.claims.dev }
  }

  const hint = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
  const opened = auth.requests.open({
    client,
    intent: parsed.intent,
    provider: parsed.provider,
    device: parsed.device,
    challenge,
    clientState,
    back,
    returnPath: client === 'web' ? (safeReturnPath(body.return) ?? '/me') : null,
    usernameHint: opener?.username ?? (USERNAME.test(hint) ? hint : null),
    opener,
    address: asking(ctx)
  })
  if (opened === 'invalid') {
    refuse(response, 400, 'bad_device')
    return
  }
  if (opened === 'capacity') {
    refuse(response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
    return
  }
  // ONE LINE PER WAY IN, and nothing in it that names a person or opens
  // anything: which client, which screen, and for the web where it returns.
  const resume = client === 'desktop' && parsed.intent === 'sign-in' && opener === null && USERNAME.test(hint) ? ' resume' : ''
  const landing = opened.returnPath === null ? '' : ` return=${opened.returnPath}`
  auth.log(`auth request opened: client=${client} intent=${parsed.intent}${resume}${landing}`)
  const verification = `${auth.origin}/device`
  const created: Record<string, unknown> = {
    request: opened.id,
    transcript: opened.transcript,
    expiresAt: opened.expiresAt,
    // A TERMINAL'S CODE IS TYPED, never carried in a link: a link with the
    // code in it is a link an attacker can send, and the person would only
    // have to press Continue to sign the attacker's terminal in.
    authorizeUrl: opened.userCode === null ? `${auth.origin}/?request=${encodeURIComponent(opened.id)}` : verification,
    ...(opened.userCode === null
      ? {}
      : { userCode: opened.userCode, verificationUri: verification, intervalMs: AUTH_POLL_MS })
  }
  v2Json(
    response,
    201,
    created,
    verifier === null
      ? {}
      : {
          'set-cookie': `${AUTH_WEB_COOKIE}=${opened.id}.${verifier}; Path=/; Max-Age=${WEB_COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax; Secure`
        }
  )
}

const shapeId = (device: AuthDevice): string => String(device.id).toLowerCase()

/** POST /v2/auth/requests/:request/proof */
async function proveRequest(ctx: V2Context, id: string): Promise<void> {
  const { v2, response } = ctx
  if (!v2.limits.oauth.take(`proof|${asking(ctx)}`)) {
    refuse(response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
    return
  }
  const read = await readJsonBody(ctx.request, SMALL_BODY)
  if (!read.ok) {
    refuse(response, read.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const proved = v2.auth?.requests.prove(id, read.value.signature) ?? 'gone'
  if (proved === 'ok') {
    response.writeHead(204, { 'cache-control': 'private, no-store' })
    response.end()
    return
  }
  if (proved === 'bad_proof') refuseAuth(response, 403, 'bad_proof')
  else refuseAuth(response, 410, 'flow_over')
}

/** POST /v2/auth/token — a desktop's code, or a terminal's poll. */
async function spend(ctx: V2Context): Promise<void> {
  const { v2, response } = ctx
  const auth = v2.auth
  if (auth === null) return
  const read = await readJsonBody(ctx.request, SMALL_BODY)
  if (!read.ok) {
    refuse(response, read.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const body = read.value
  if (body.code !== undefined) {
    if (!v2.limits.oauth.take(`token|${asking(ctx)}`)) {
      refuse(response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
      return
    }
    const spent = auth.requests.redeem(body.code, 'desktop', body.verifier)
    if (spent === null) {
      refuse(response, 401, 'bad_credentials')
      return
    }
    if (spent.request.intent === 'link') {
      spendLink(ctx, spent.request)
      return
    }
    if (spent.request.intent === 'passkey') {
      const written = writeHeldPasskey(ctx, spent.request, signedIn(ctx.request, v2, 'bearer'))
      if (written.ok) v2Json(response, 201, { status: 'passkey', passkey: written.passkey })
      else v2Json(response, written.status, written.body)
      return
    }
    v2Json(response, spent.result.status, spent.result.body)
    return
  }
  // A terminal polls on its own pace, enforced in the store; the limiter only
  // stops a caller asking about many requests at once.
  if (!v2.limits.lookups.take(`poll|${asking(ctx)}`)) {
    refuse(response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
    return
  }
  const polled = auth.requests.poll(body.request, body.verifier)
  if (polled.state === 'pending' || polled.state === 'slow') {
    v2Json(response, 202, { status: 'pending', intervalMs: polled.intervalMs })
    return
  }
  if (polled.state === 'done') {
    v2Json(response, polled.result.status, polled.result.body)
    return
  }
  if (polled.state === 'over') {
    v2Json(response, 410, { error: 'flow_over', message: SENTENCES.flow_over, why: polled.why })
    return
  }
  refuse(response, 401, 'bad_credentials')
}

/**
 * THE LINK IS WRITTEN HERE AND ONLY HERE: by the client that opened the
 * request, holding its verifier (checked by the redeem) and the very session
 * that proved itself when the request was opened. A browser that got hold of
 * a link request's URL can finish the page and link nothing.
 */
function spendLink(ctx: V2Context, request: AuthRequest): void {
  const { v2, response } = ctx
  const signed = signedIn(ctx.request, v2, 'bearer')
  const proof = request.linkProof
  if (signed === null || request.opener === null || proof === null || signed.claims.jti !== request.opener.jti) {
    refuse(response, 401, 'unauthenticated')
    return
  }
  const added = v2.links.add(signed.account.username, proof)
  if (!added.ok) {
    v2Json(response, 409, { error: added.reason, message: LINK_REFUSED[added.reason] })
    return
  }
  v2.events.append(signed.account.username, { kind: 'linked', device: PROVIDER_LABEL[proof.provider] })
  v2Json(response, 200, { status: 'linked', provider: proof.provider })
}

const LINK_REFUSED: Record<string, string> = {
  link_taken: 'That account is already linked to another Cookrew account.',
  link_exists: 'A different account from this provider is linked here. Remove it first.'
}

/**
 * GET /auth/complete?code&state — THE WEB'S WAY BACK, redeemed here and only
 * here, with the verifier the browser never saw. The session cookie is the
 * product origin's own; nothing is shared with the auth origin.
 */
export function completeWeb(v2: V2Identity, request: IncomingMessage, response: ServerResponse, url: URL): void {
  const auth = v2.auth
  const cleared = `${AUTH_WEB_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`
  const held = cookieOf(request, AUTH_WEB_COOKIE)
  const [id, verifier] = held === null ? [null, null] : held.split('.', 2)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  // CANCELLED on the page: back where the person started, signed out as they were.
  if (code === null && url.searchParams.get('error') !== null) {
    const asked = auth?.requests.peek(id) ?? null
    const back = asked !== null && asked.client === 'web' && asked.clientState === state ? (asked.returnPath ?? '/') : '/'
    response.writeHead(303, { location: back, 'cache-control': 'private, no-store', 'content-length': '0', 'set-cookie': cleared })
    response.end()
    return
  }
  const spent = auth === null || code === null ? null : auth.requests.redeem(code, 'web', verifier)
  const matches = spent !== null && spent.request.id === id && spent.request.clientState === state
  if (spent !== null && matches && spent.request.intent === 'passkey') {
    // The passkey is written by this browser's own session, the one that opened it.
    const written = writeHeldPasskey({ v2 }, spent.request, signedIn(request, v2))
    if (!written.ok) {
      failPage(response, cleared, written.body.message)
      return
    }
    const back = spent.request.returnPath ?? '/me'
    response.writeHead(303, {
      location: `${back}?passkey=added#security`,
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
      'content-length': '0',
      'set-cookie': cleared
    })
    response.end()
    return
  }
  if (spent === null || !matches || spent.result.status !== 201) {
    const words = url.searchParams.get('error') === null ? 'That sign-in did not finish.' : 'Sign-in was cancelled.'
    failPage(response, cleared, words)
    return
  }
  const sessionToken = String(spent.result.body.token)
  response.writeHead(303, {
    location: spent.request.returnPath ?? '/me',
    'cache-control': 'private, no-store',
    'referrer-policy': 'no-referrer',
    'content-length': '0',
    'set-cookie': [cookie(sessionToken), cleared]
  })
  response.end()
}

const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** The web's way back, when there is nothing to land on: what happened, and the way on. */
function failPage(response: ServerResponse, cleared: string, words: string): void {
  const payload = Buffer.from(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cookrew</title>' +
      '<style>body{font:15px -apple-system,sans-serif;margin:18vh auto;max-width:30em;text-align:center;padding:0 16px}</style></head><body>' +
      `<p>${escapeHtml(words)}</p><p><a href="/me">Back to cookrew.dev</a></p></body></html>`,
    'utf8'
  )
  response.writeHead(400, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(payload.byteLength),
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'cache-control': 'private, no-store',
    'referrer-policy': 'no-referrer',
    'set-cookie': cleared
  })
  response.end(payload)
}

// ── the auth origin: the page's own calls ───────────────────────────────────

/** What the page shows above every screen: who is asking, before anyone signs in. */
export function summaryOf(v2: V2Identity, request: AuthRequest): AuthRequestSummary {
  return {
    request: request.id,
    client: request.client,
    clientLabel: clientLabelOf(request.client),
    device: { name: request.payload.name ?? request.device.name, kind: request.device.kind },
    intent: request.intent,
    provider: request.provider,
    username: request.usernameHint,
    userCode: request.userCode,
    returnHost: request.client === 'web' ? new URL(productOrigin(v2)).host : null,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    providers: [...v2.oauth.providers.values()].map((p) => ({ id: p.id, label: PROVIDER_LABEL[p.id] })),
    stage: request.stage,
    enrol: enrolmentOf(v2, request)
  }
}

/** The bound request this page call names, or null with the refusal written. */
export function boundRequest(ctx: V2Context): AuthRequest | null {
  const auth = ctx.v2.auth
  const id = ctx.request.headers[AUTH_REQUEST_HEADER]
  const request = auth === null || typeof id !== 'string' ? null : auth.requests.bound(id, cookieOf(ctx.request, AUTH_BINDING_COOKIE))
  if (request === null) {
    refuseAuth(ctx.response, 410, 'expired')
    return null
  }
  return request
}

/** Bind a request to this browser and answer its summary. */
function bindAndAnswer(ctx: V2Context, request: AuthRequest): void {
  const auth = ctx.v2.auth
  if (auth === null) return
  const held = cookieOf(ctx.request, AUTH_BINDING_COOKIE)
  const secret = held ?? token()
  if (!auth.requests.claim(request, secret)) {
    refuseAuth(ctx.response, 409, 'claimed')
    return
  }
  v2Json(
    ctx.response,
    200,
    summaryOf(ctx.v2, request),
    held === null
      ? { 'set-cookie': `${AUTH_BINDING_COOKIE}=${secret}; Path=/; Max-Age=${BINDING_MAX_AGE_S}; HttpOnly; SameSite=Strict; Secure` }
      : {}
  )
}

/**
 * /auth/api/* on the auth origin. Answers true when it claimed the path.
 * `ctx.auth` is set for every call but claim and device, which are how a
 * browser comes to hold a request in the first place.
 */
export async function handleAuthApi(ctx: V2Context, path: string): Promise<boolean> {
  const { v2, response, method } = ctx
  const auth = v2.auth
  if (auth === null || !path.startsWith('/auth/api/')) return false
  const name = path.slice('/auth/api/'.length)
  if (name === 'request' && method === 'GET') {
    if (!v2.limits.lookups.take(`authpage|${asking(ctx)}`)) {
      refuse(response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
      return true
    }
    const request = boundRequest(ctx)
    if (request !== null) v2Json(response, 200, summaryOf(v2, request))
    return true
  }
  if (method !== 'POST' || !['claim', 'device', 'continue', 'cancel', 'passkey/options', 'passkey'].includes(name)) {
    refuse(response, 404, 'not_found')
    return true
  }
  if (!v2.limits.lookups.take(`authpage|${asking(ctx)}`)) {
    refuse(response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
    return true
  }
  // The ceremony reads its own body: an attestation is larger than a page call.
  if (name === 'passkey') {
    const request = boundRequest(ctx)
    if (request !== null) await passkeyOnPage({ ...ctx, auth: { request } }, request)
    return true
  }
  const read = await readJsonBody(ctx.request, SMALL_BODY)
  if (!read.ok) {
    refuse(response, read.reason === 'too_large' ? 413 : 400, 'malformed')
    return true
  }
  if (name === 'claim') {
    const request = auth.requests.get(read.value.request)
    if (request === null) refuseAuth(response, 410, 'expired')
    // A terminal's request is claimed by typing its code at /device and in no
    // other way, so the warning beside the code box is never skipped.
    else if (request.client === 'cli' && auth.requests.bound(request.id, cookieOf(ctx.request, AUTH_BINDING_COOKIE)) === null) {
      refuseAuth(response, 403, 'use_code')
    }
    else bindAndAnswer(ctx, request)
    return true
  }
  if (name === 'device') {
    // A short code is guessable in a way a request id is not, so asking for
    // one has a budget of its own on top of the page's.
    if (!v2.limits.join.take(`usercode|${asking(ctx)}`)) {
      refuse(response, 429, 'rate_limited', undefined, { 'retry-after': '60' })
      return true
    }
    const request = auth.requests.byUser(read.value.code)
    if (request === null || request.stage !== 'open') refuseAuth(response, 404, 'no_code')
    else bindAndAnswer(ctx, request)
    return true
  }
  const request = boundRequest(ctx)
  if (request === null) return true
  if (name === 'continue') {
    continueRequest({ ...ctx, auth: { request } }, request)
    return true
  }
  if (name === 'passkey/options') {
    passkeyOptionsOnPage({ ...ctx, auth: { request } }, request)
    return true
  }
  // Over is over: a finished request keeps its code, a cancelled one is not
  // cancelled again (which would keep pushing its ending back).
  if (!auth.requests.isOpen(request)) {
    refuseAuth(response, 410, 'expired')
    return true
  }
  auth.requests.deny(request, 'denied')
  auth.log(`auth request cancelled: client=${request.client} intent=${request.intent}`)
  v2Json(response, 200, { status: 'cancelled', handoff: handoffFor(v2, request, { error: 'denied' }) })
  return true
}
