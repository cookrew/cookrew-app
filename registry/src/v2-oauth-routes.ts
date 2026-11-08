import type { ServerResponse } from 'node:http'
import { readJsonBody } from './http'
import { emailFrom } from './v2-links'
import { afterFirstFactor } from './v2-factor-routes'
import { completeSignIn, deviceFor, json, noContent, refuse, refuseFactor, relyingParty } from './v2-factor-http'
import { authorizeSession, finishRequest, productOrigin } from './auth-finish'
import type { AuthRequest } from './auth-requests'
import { asking, signedIn, type Signed, type V2Context } from './v2-http'
import { legacyHolds, refuseIfLegacy } from './v2-migrate-routes'
import { challengeFor, challengeMatches, type Flow } from './v2-oauth-flows'
import type { OAuthProvider, ProviderProof } from './v2-oauth-providers'
import { readAndStepUp, stepUpHeld } from './v2-step-up'
import {
  OAUTH_LOOPBACK_PATH,
  OAUTH_SCHEME_HOST,
  PROVIDER_LABEL,
  isOAuthIntent,
  isProviderId,
  suggestHandle,
  type OAuthBack
} from '../../src/shared/oauth'
import { isStepUpAct } from '../../src/shared/step-up'

/**
 * THIRD-PARTY SIGN-IN, OVER HTTP.
 *
 * A provider stands where the password stood. `afterFirstFactor` is the same
 * function the password route ends in, so the ladder, the device attach and the
 * session have one implementation and this file has none of them.
 *
 * WHAT THE BROWSER CARRIES IS WORTH NOTHING ALONE. It sees a one-time handoff;
 * the app redeems it with a PKCE verifier that never left the app. So another
 * program that claimed `cookrew://` catches a string it cannot spend.
 *
 * A PROVIDER PROOF ON ITS OWN NEVER MERGES ANYTHING. An identity nobody has
 * linked gets a ticket and a question. There is no lookup by email here, and
 * none may be added: that lookup is how an attacker who registered a victim's
 * address first would inherit the victim's account.
 */

const SMALL_BODY = 16 * 1024
const CLIENT_STATE = /^[A-Za-z0-9_-]{16,128}$/
/** Base64url of a SHA-256: always 43 characters. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/
const PORT_MIN = 1024
const PORT_MAX = 65535

type OAuthError =
  | 'oauth_off'
  | 'bad_flow'
  | 'not_this_session'
  | 'wrong_identity'
  | 'link_taken'
  | 'link_exists'
  | 'link_paused'
  | 'last_sign_in'
  | 'ticket_gone'
  | 'flow_over'
  | 'provider_down'

const SENTENCES: Record<OAuthError, string> = {
  oauth_off: 'This sign-in is not available here.',
  bad_flow: 'That sign-in request could not be read. Start again.',
  not_this_session: 'This has to be finished from the session that started it.',
  wrong_identity: 'That is not the account linked here. Use the one you linked.',
  link_taken: 'That account is already linked to another Cookrew account.',
  link_exists: 'A different account from this provider is linked here. Remove it first.',
  link_paused: 'This sign-in was reported as “not me”, so it is paused. Link it again from a signed-in device.',
  last_sign_in: 'This is the only way into the account. Add another before removing it.',
  ticket_gone: 'That took too long, so it was dropped. Sign in again.',
  flow_over: 'That sign-in is over. Start again.',
  provider_down: 'The provider did not answer. Try again in a moment.'
}

const refuseOAuth = (response: ServerResponse, code: number, error: OAuthError): void =>
  json(response, code, { error, message: SENTENCES[error] })

/** A body that passed the limiter, or null with the refusal already written. */
async function bodyOf(ctx: V2Context, bucket: string): Promise<Record<string, unknown> | null> {
  if (!ctx.v2.limits.oauth.take(`${bucket}|${asking(ctx)}`)) {
    refuse(ctx.response, 429, 'rate_limited', { 'retry-after': '60' })
    return null
  }
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(ctx.response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return null
  }
  return body.value
}

/** The shape of `back`, or null. There is no URL field to validate, on purpose. */
function readBack(value: unknown): OAuthBack | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { scheme, port } = value as { scheme?: unknown; port?: unknown }
  const portOk = typeof port === 'number' && Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX
  if (port !== undefined && !portOk) return null
  if (scheme !== true && !portOk) return null
  return { scheme: scheme === true, ...(portOk ? { port: port as number } : {}) }
}

/**
 * The callback the provider app registered. On the auth origin it is still the
 * product origin's: the provider apps and their callbacks do not change.
 */
const callbackUrl = (ctx: V2Context, provider: OAuthProvider): string =>
  `${ctx.auth === undefined ? relyingParty(ctx).origin : productOrigin(ctx.v2)}/v2/oauth/${provider.id}/callback`

/**
 * POST /v2/oauth/:provider/start ON THE AUTH ORIGIN. The request says what the
 * trip is for; the page sends nothing but the provider. A link was proven when
 * the request was opened, by a signed-in client, so nobody signs in here.
 */
function startForRequest(ctx: V2Context, provider: OAuthProvider, request: AuthRequest): void {
  if (!ctx.v2.limits.oauth.take(`start|${asking(ctx)}`)) {
    refuse(ctx.response, 429, 'rate_limited', { 'retry-after': '60' })
    return
  }
  if (request.stage !== 'open' || (request.intent === 'link' && request.provider !== provider.id)) {
    refuseOAuth(ctx.response, 400, 'bad_flow')
    return
  }
  const flow = ctx.v2.oauth.flows.open({
    provider: provider.id,
    intent: request.intent === 'link' ? 'link' : 'sign-in',
    clientState: 'auth-request',
    challenge: request.challenge,
    back: { scheme: false },
    authRequest: request.id,
    ...(request.opener === null ? {} : { opener: request.opener })
  })
  const authorizeUrl = provider.authorizeUrl({
    state: flow.providerState,
    challenge: challengeFor(flow.providerVerifier),
    nonce: flow.nonce,
    redirectUri: callbackUrl(ctx, provider)
  })
  json(ctx.response, 201, { authorizeUrl, expiresAt: flow.expiresAt })
}

/** POST /v2/oauth/:provider/start */
async function start(ctx: V2Context, provider: OAuthProvider): Promise<void> {
  if (ctx.auth !== undefined) {
    startForRequest(ctx, provider, ctx.auth.request)
    return
  }
  const body = await bodyOf(ctx, 'start')
  if (body === null) return
  const intent = body.intent === undefined ? 'sign-in' : body.intent
  const back = readBack(body.back)
  const { state, challenge, act } = body
  if (
    !isOAuthIntent(intent) ||
    back === null ||
    typeof state !== 'string' ||
    !CLIENT_STATE.test(state) ||
    typeof challenge !== 'string' ||
    !CHALLENGE.test(challenge) ||
    (intent === 'step-up' && !isStepUpAct(act))
  ) {
    refuseOAuth(ctx.response, 400, 'bad_flow')
    return
  }
  let signed: Signed | null = null
  if (intent !== 'sign-in') {
    signed = signedIn(ctx.request, ctx.v2)
    if (signed === null) {
      refuse(ctx.response, 401, 'unauthenticated')
      return
    }
    // Adding a way in widens what the account opens from, so the proof comes
    // before the trip. A step-up trip IS the proof, so it needs none of its own.
    if (intent === 'link' && !(await stepUpHeld(ctx, signed, 'link-provider', body))) return
  }
  const flow = ctx.v2.oauth.flows.open({
    provider: provider.id,
    intent,
    ...(intent === 'step-up' && isStepUpAct(act) ? { act } : {}),
    clientState: state,
    challenge,
    back,
    ...(signed === null
      ? {}
      : { opener: { username: signed.account.username, jti: signed.claims.jti, device: signed.claims.dev } })
  })
  // The registry's own state and PKCE pair go to the provider. The client's
  // never do: they answer a different question, which is "did I start this".
  const authorizeUrl = provider.authorizeUrl({
    state: flow.providerState,
    challenge: challengeFor(flow.providerVerifier),
    nonce: flow.nonce,
    redirectUri: callbackUrl(ctx, provider)
  })
  json(ctx.response, 201, { authorizeUrl, expiresAt: flow.expiresAt })
}

/** GET /v2/oauth/:provider/callback */
async function callback(ctx: V2Context, provider: OAuthProvider): Promise<void> {
  const params = new URL(ctx.request.url ?? '', 'http://x').searchParams
  // STATE FIRST, and nothing is sent to a provider without it: an unsolicited
  // callback costs this process a map lookup.
  const flow = ctx.v2.oauth.flows.take(params.get('state'), provider.id)
  if (flow === null) {
    page(ctx.response, 400, 'That sign-in is over. Go back to Cookrew and start again.', null)
    return
  }
  if (flow.authRequest !== undefined) {
    await callbackForRequest(ctx, provider, flow, params)
    return
  }
  const code = params.get('code')
  if (params.get('error') !== null || code === null) {
    returnPage(ctx.response, flow, { error: 'denied' })
    return
  }
  const answer = await provider.exchange({
    code,
    verifier: flow.providerVerifier,
    nonce: flow.nonce,
    redirectUri: callbackUrl(ctx, provider)
  })
  if (!answer.ok) {
    returnPage(ctx.response, flow, { error: 'provider' })
    return
  }
  returnPage(ctx.response, flow, { handoff: ctx.v2.oauth.flows.settle(flow, answer.proof).handoff })
}

/**
 * A TRIP THE AUTH PAGE STARTED, BACK FROM THE PROVIDER.
 *
 * The proof waits on the request and the browser goes back to the page, which
 * continues it only from the browser that claimed the request. Nothing in the
 * redirect is a credential: the request id alone opens nothing.
 */
async function callbackForRequest(
  ctx: V2Context,
  provider: OAuthProvider,
  flow: Flow,
  params: URLSearchParams
): Promise<void> {
  const auth = ctx.v2.auth
  const request = auth?.requests.get(flow.authRequest) ?? null
  if (auth === null || request === null || request.stage === 'done' || request.stage === 'denied') {
    page(ctx.response, 400, 'That sign-in is over. Go back to Cookrew and start again.', null)
    return
  }
  const back = (extra: string): void => {
    const location = `${auth.origin}/?request=${encodeURIComponent(request.id)}&${extra}`
    ctx.response.writeHead(303, { location, 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'content-length': '0' })
    ctx.response.end()
  }
  const code = params.get('code')
  if (params.get('error') !== null || code === null) {
    back('denied=1')
    return
  }
  const answer = await provider.exchange({
    code,
    verifier: flow.providerVerifier,
    nonce: flow.nonce,
    redirectUri: callbackUrl(ctx, provider)
  })
  if (!answer.ok) {
    back('denied=1')
    return
  }
  auth.requests.stashProof(request, answer.proof)
  back('continue=1')
}

/**
 * POST /auth/api/continue — the bound browser finishes what the provider began.
 * Sign-in goes through the same `signInWith` the app's handoff does; a link is
 * added for the session that opened the request, if that session still stands.
 */
export function continueRequest(ctx: V2Context, request: AuthRequest): void {
  const proof = ctx.v2.auth?.requests.takeProof(request) ?? null
  if (proof === null) {
    refuseOAuth(ctx.response, 410, 'flow_over')
    return
  }
  if (request.intent !== 'link') {
    signInWith(ctx, proof, request.device)
    return
  }
  const opener = request.opener
  if (opener === null || !ctx.v2.accounts.isLiveSession(opener.username, opener.jti)) {
    refuse(ctx.response, 401, 'unauthenticated')
    return
  }
  // NOTHING IS LINKED YET. The proof waits on the request for the client that
  // opened it, which writes it when it spends the code with its own session.
  finishRequest(ctx, request, { status: 200, body: { status: 'linked', provider: proof.provider } }, { linked: proof.provider }, proof)
}

/** The page that hands back to the app. Script-free, so it needs no exception. */
function returnPage(response: ServerResponse, flow: Flow, fields: Record<string, string>): void {
  const params = new URLSearchParams({ ...fields, state: flow.clientState }).toString()
  const scheme = `cookrew://${OAUTH_SCHEME_HOST}#${params}`
  const loopback =
    flow.back.port === undefined ? null : `http://127.0.0.1:${flow.back.port}${OAUTH_LOOPBACK_PATH}?${params}`
  const first = flow.back.scheme ? scheme : (loopback ?? scheme)
  const words = fields.handoff === undefined ? 'That did not finish. Go back to Cookrew.' : 'Back to Cookrew…'
  page(response, 200, words, { first, fallback: flow.back.scheme ? loopback : null })
}

const attr = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')

/**
 * The handoff is in this document, so it is uncached and referrer-free, and it
 * is single use on top of that. Every value in it is URL-encoded by us.
 */
function page(
  response: ServerResponse,
  code: number,
  words: string,
  links: { first: string; fallback: string | null } | null
): void {
  const body = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cookrew</title>',
    links === null ? '' : `<meta http-equiv="refresh" content="0;url=${attr(links.first)}">`,
    '<style>body{font:15px -apple-system,sans-serif;margin:18vh auto;max-width:30em;text-align:center}</style></head><body>',
    `<p>${words}</p>`,
    links === null ? '' : `<p><a href="${attr(links.first)}">Open Cookrew</a></p>`,
    links?.fallback ? `<p><a href="${attr(links.fallback)}">Cookrew did not open? Continue here</a></p>` : '',
    '</body></html>'
  ].join('')
  const payload = Buffer.from(body, 'utf8')
  response.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(payload.byteLength),
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, no-store'
  })
  response.end(payload)
}

/**
 * THE PASSWORD STEP'S REPLACEMENT.
 *
 * The alarm's password lock is honoured here too, though it is about a
 * password: an account in that state has said it is under attack, and every
 * rung behind this point refuses it anyway, so opening a pending here would
 * only produce a ladder nobody could climb.
 */
export function signInWith(ctx: V2Context, proof: ProviderProof, rawDevice: unknown, via: 'browser' | 'device' = 'browser'): void {
  const { v2, response } = ctx
  const owner = v2.links.ownerOf(proof.provider, proof.subject)
  const account = owner === null ? null : v2.accounts.get(owner)
  if (account === null) {
    askForHandle(ctx, proof, via)
    return
  }
  if (v2.links.linkOf(account.username, proof.provider, proof.subject)?.pausedAt !== undefined) {
    refuseOAuth(response, 403, 'link_paused')
    return
  }
  if (v2.factors.store.mustChangePassword(account.username)) {
    refuseFactor(response, 403, 'password_change_required')
    return
  }
  afterFirstFactor(ctx, account, rawDevice, { provider: proof.provider, subject: proof.subject })
}

/** Nobody has this identity. Nothing is created until a person picks a name. */
function askForHandle(ctx: V2Context, proof: ProviderProof, via: 'browser' | 'device'): void {
  const { v2 } = ctx
  // Whoever polls a device flow may not be whoever typed the code, so a person's
  // address must reach neither this answer nor the account a claim would make.
  const held = via === 'browser' ? proof : { ...proof, email: null }
  const ticket = v2.oauth.flows.mintTicket(held, ctx.auth?.request.id)
  const suggest = suggestHandle(held.login, held.email)
  json(ctx.response, 200, {
    status: 'new',
    ticket: ticket.id,
    provider: proof.provider,
    suggest,
    free: suggest !== '' && !v2.accounts.has(suggest) && !legacyHolds(ctx, suggest),
    email: held.email,
    expiresAt: ticket.expiresAt
  })
}

/** POST /v2/oauth/redeem */
async function redeem(ctx: V2Context): Promise<void> {
  const body = await bodyOf(ctx, 'redeem')
  if (body === null) return
  const settled = ctx.v2.oauth.flows.redeem(body.handoff, body.verifier)
  if (settled === null) {
    refuse(ctx.response, 401, 'bad_credentials')
    return
  }
  const { flow, proof } = settled
  if (flow.intent === 'sign-in') {
    signInWith(ctx, proof, body.device)
    return
  }
  // THE SESSION THAT BEGAN IT, and no other. A link or a proof carried over to
  // a second session would let one sitting spend what another one earned.
  const signed = signedIn(ctx.request, ctx.v2)
  if (signed === null) {
    refuse(ctx.response, 401, 'unauthenticated')
    return
  }
  if (flow.opener === undefined || signed.claims.jti !== flow.opener.jti) {
    refuseOAuth(ctx.response, 403, 'not_this_session')
    return
  }
  if (flow.intent === 'link') finishLink(ctx, signed, proof)
  else finishStepUp(ctx, signed, flow, proof)
}

function finishLink(ctx: V2Context, signed: Signed, proof: ProviderProof): void {
  const added = ctx.v2.links.add(signed.account.username, proof)
  if (!added.ok) {
    refuseOAuth(ctx.response, 409, added.reason)
    return
  }
  // A new way in is told to every device: a stolen session must not add one
  // quietly, and this feed is the only channel an owner has.
  ctx.v2.events.append(signed.account.username, { kind: 'linked', device: PROVIDER_LABEL[proof.provider] })
  json(ctx.response, 200, { status: 'linked', provider: proof.provider })
}

/**
 * A PROVIDER PROOF BECOMES A CLIMBED RUNG.
 *
 * It must be an identity already on this account: anyone can prove they are
 * somebody at GitHub. A paused link still counts here, because the session and
 * the provider are two things and the pause is about the provider alone.
 */
function finishStepUp(ctx: V2Context, signed: Signed, flow: Flow, proof: ProviderProof): void {
  const { v2 } = ctx
  const username = signed.account.username
  if (v2.links.linkOf(username, proof.provider, proof.subject) === null || flow.act === undefined) {
    refuseOAuth(ctx.response, 403, 'wrong_identity')
    return
  }
  const pending = v2.factors.pending.open({
    username,
    device: null,
    deviceName: username,
    kind: 'account',
    address: asking(ctx),
    next: [],
    act: flow.act,
    opener: { jti: signed.claims.jti, device: signed.claims.dev }
  })
  v2.factors.pending.authorise(pending.id)
  json(ctx.response, 200, { stepUp: pending.id, act: flow.act, expiresAt: pending.expiresAt })
}

/** POST /v2/oauth/claim — the name, for a proven identity with no account. */
async function claim(ctx: V2Context): Promise<void> {
  const { v2, response } = ctx
  if (!v2.limits.accounts.take(`claim|${asking(ctx)}`)) {
    refuse(response, 429, 'rate_limited', { 'retry-after': '60' })
    return
  }
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const ticket = v2.oauth.flows.ticket(body.value.ticket)
  // A ticket minted for a request on the auth origin is spent only there, by
  // that request; one minted for an app's handoff is never spent there.
  if (ticket === null || (ticket.authRequest ?? null) !== (ctx.auth?.request.id ?? null)) {
    refuseOAuth(response, 410, 'ticket_gone')
    return
  }
  if (refuseIfLegacy(ctx, body.value.username)) return
  const { proof } = ticket
  const now = Date.now()
  const device = deviceFor(ctx, body.value.device)
  const out = v2.accounts.createWithProvider({
    username: body.value.username,
    device,
    link: { provider: proof.provider, subject: proof.subject, login: proof.login, linkedAt: now },
    email: emailFrom(proof, now)
  })
  if (!out.ok) {
    if (out.reason === 'link_taken') refuseOAuth(response, 409, 'link_taken')
    else refuse(response, out.reason === 'taken' ? 409 : 400, out.reason)
    return
  }
  v2.oauth.flows.spendTicket(ticket.id)
  if (ctx.auth !== undefined) {
    authorizeSession(ctx, ctx.auth.request, out.account.username, out.device.id, false, { codes: true })
    return
  }
  completeSignIn(ctx, out.account.username, device)
}

/** POST /v2/oauth/:provider/device — the device code stays in this process. */
async function deviceStart(ctx: V2Context, provider: OAuthProvider): Promise<void> {
  const body = await bodyOf(ctx, 'device')
  if (body === null) return
  if (typeof body.challenge !== 'string' || !CHALLENGE.test(body.challenge)) {
    refuseOAuth(ctx.response, 400, 'bad_flow')
    return
  }
  const grant = await provider.deviceStart?.()
  if (grant === undefined || grant === null) {
    refuseOAuth(ctx.response, 502, 'provider_down')
    return
  }
  const flow = ctx.v2.oauth.flows.openDevice({
    provider: provider.id,
    deviceCode: grant.deviceCode,
    challenge: body.challenge,
    intervalMs: grant.intervalMs,
    expiresInMs: grant.expiresInMs
  })
  json(ctx.response, 201, {
    flow: flow.id,
    userCode: grant.userCode,
    verificationUri: grant.verificationUri,
    intervalMs: grant.intervalMs,
    expiresAt: flow.expiresAt
  })
}

/**
 * POST /v2/oauth/device/:flow/poll
 *
 * THE PROVIDER'S INTERVAL IS HELD HERE, whoever is asking. GitHub answers a fast
 * poller with a longer interval for the whole client id, so a client that polls
 * too fast is told to wait and GitHub never hears about it.
 */
async function devicePoll(ctx: V2Context, id: string): Promise<void> {
  const { v2, response } = ctx
  const body = await readJsonBody(ctx.request, SMALL_BODY)
  if (!body.ok) {
    refuse(response, body.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const flow = v2.oauth.flows.device(id)
  const provider = flow === null ? undefined : v2.oauth.providers.get(flow.provider)
  if (flow === null || provider?.devicePoll === undefined) {
    refuseOAuth(response, 410, 'flow_over')
    return
  }
  if (!challengeMatches(flow.challenge, body.value.verifier)) {
    refuse(response, 401, 'bad_credentials')
    return
  }
  if (!v2.oauth.flows.mayPoll(flow)) {
    json(response, 202, { status: 'pending', intervalMs: flow.intervalMs })
    return
  }
  const polled = await provider.devicePoll(flow.deviceCode)
  if (polled.status === 'pending') {
    json(response, 202, { status: 'pending', intervalMs: flow.intervalMs })
    return
  }
  if (polled.status === 'slow') {
    v2.oauth.flows.slowDown(flow, polled.intervalMs)
    json(response, 202, { status: 'pending', intervalMs: polled.intervalMs })
    return
  }
  v2.oauth.flows.closeDevice(flow.id)
  if (polled.status === 'over') {
    json(response, 410, { error: 'flow_over', message: SENTENCES.flow_over, why: polled.why })
    return
  }
  signInWith(ctx, polled.proof, body.value.device, 'device')
}

/** DELETE /v2/me/links/:provider */
async function unlink(ctx: V2Context, name: string): Promise<void> {
  const { v2, response } = ctx
  const signed = signedIn(ctx.request, v2)
  if (signed === null) {
    refuse(response, 401, 'unauthenticated')
    return
  }
  if (!isProviderId(name)) {
    refuse(response, 404, 'not_found')
    return
  }
  if (!(await readAndStepUp(ctx, signed, 'unlink-provider')).ok) return
  const account = v2.accounts.get(signed.account.username) ?? signed.account
  if (v2.links.isLastWayIn(account, name)) {
    refuseOAuth(response, 409, 'last_sign_in')
    return
  }
  if (!v2.links.remove(account.username, name)) {
    refuse(response, 404, 'not_found')
    return
  }
  v2.events.append(account.username, { kind: 'unlinked', device: PROVIDER_LABEL[name] })
  noContent(response)
}

/** Answers true when it claimed the request. Mounted first in v2-routes. */
export function handleOAuthRoute(ctx: V2Context, rest: readonly string[]): boolean {
  const { method, response } = ctx
  if (rest.length === 3 && rest[0] === 'me' && rest[1] === 'links' && method === 'DELETE') {
    void unlink(ctx, ctx.decode(rest[2]) ?? '')
    return true
  }
  if (rest[0] !== 'oauth') return false
  if (rest.length === 2 && rest[1] === 'providers' && method === 'GET') {
    json(response, 200, {
      providers: [...ctx.v2.oauth.providers.values()].map((p) => ({
        id: p.id,
        label: p.label,
        device: p.deviceStart !== undefined
      }))
    })
    return true
  }
  if (rest.length === 2 && rest[1] === 'redeem' && method === 'POST') {
    void redeem(ctx)
    return true
  }
  if (rest.length === 2 && rest[1] === 'claim' && method === 'POST') {
    void claim(ctx)
    return true
  }
  if (rest.length === 4 && rest[1] === 'device' && rest[3] === 'poll' && method === 'POST') {
    void devicePoll(ctx, ctx.decode(rest[2]) ?? '')
    return true
  }
  const name = ctx.decode(rest[1] ?? '') ?? ''
  const provider = isProviderId(name) ? ctx.v2.oauth.providers.get(name) : undefined
  if (provider === undefined || rest.length !== 3) {
    refuseOAuth(response, 404, 'oauth_off')
    return true
  }
  if (rest[2] === 'start' && method === 'POST') {
    void start(ctx, provider)
    return true
  }
  if (rest[2] === 'callback' && method === 'GET') {
    void callback(ctx, provider)
    return true
  }
  if (rest[2] === 'device' && method === 'POST' && provider.deviceStart !== undefined) {
    void deviceStart(ctx, provider)
    return true
  }
  refuseOAuth(response, 404, 'oauth_off')
  return true
}
