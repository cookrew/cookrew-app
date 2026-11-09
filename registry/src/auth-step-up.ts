import type { IncomingMessage } from 'node:http'
import { STEP_UP_LANDING_HASH, STEP_UP_LANDING_PARAM, type AuthStepUp } from '../../src/shared/auth-site'
import { PROVIDER_LABEL, type ProviderId } from '../../src/shared/oauth'
import { STEP_UP_SENTENCE, type StepUpAct } from '../../src/shared/step-up'
import type { AuthRequest } from './auth-requests'
import { finishRequest } from './auth-finish'
import { factorError } from './v2-factor-copy'
import { asking, v2Json, type Signed, type V2Context, type V2Identity } from './v2-http'
import { callerAddress } from './v2-limiter'
import type { ProviderProof } from './v2-oauth-providers'
import type { Factor, Pending } from './v2-pending'
import type { VerifiedBy } from './v2-session-age'

/**
 * A STEP-UP FOR cookrew.dev/me, PROVEN ON AUTH.COOKREW.DEV.
 *
 * /me cannot make a provider trip, and an account with no password has nothing
 * else to bring, so five minutes after signing in "Set a password", "Delete
 * account", "Add an authenticator" and "Recovery codes" all used to end in a
 * sentence. Now /me opens a `step-up` request for the ONE act it is about to
 * do, and the person proves it here with what the account holds:
 *
 *   a passkey, when the account has one — the only proof that counts for a
 *     first password on such an account (v2-device-grant.ts setFirstPassword);
 *   else a provider the account already linked, the round trip the app makes;
 *   else a code — the authenticator or a recovery code, the rungs the step-up
 *     gate itself offers (v2-step-up.ts).
 *
 * NOTHING COUNTS WHEN THE PAGE FINISHES. The proof waits on the request, and it
 * is made to count only when the browser that opened the request spends the
 * code with its verifier (the HttpOnly cookie it was given) AND the very
 * session that opened it. Then it is exactly what the app's own step-up earns
 * (finishStepUp in v2-oauth-routes.ts, finishRung in v2-factor-http.ts): the
 * sitting is marked verified now, and one authorised pending for this act,
 * bound to this sitting, is handed back to /me. A stolen session that sends the
 * owner its link gets nothing: the owner's browser holds no verifier for it.
 */

type Refusal = 'not_this_request' | 'over' | 'session_over' | 'not_offered' | 'wrong_identity' | 'no_rung' | 'not_the_opener'

const SENTENCES: Record<Refusal, string> = {
  not_this_request: 'This page was not opened to confirm anything. Start again from your account page.',
  over: 'This confirmation already finished. Start again from your account page.',
  session_over: 'The session that asked for this has ended. Sign in again, then try once more.',
  not_offered: 'That is not a way this account can confirm this.',
  wrong_identity: 'That is not the account linked to this Cookrew account.',
  no_rung: 'This account has no passkey or code to confirm with here.',
  not_the_opener: 'Only the browser and session that asked can use this confirmation. Start again from your account page.'
}

const say = (ctx: Pick<V2Context, 'v2'>, line: string): void => ctx.v2.auth?.log(`step-up: ${line}`)

/** What this account can prove an act with: the shape of a proof, never one. */
export interface StepWays {
  passkey: boolean
  providers: ProviderId[]
  codes: ('totp' | 'recovery')[]
}

const NONE: StepWays = { passkey: false, providers: [], codes: [] }

/**
 * THE WAYS, PER ACT — the registry's own rules, read and never loosened.
 *
 * A first password on an account that holds a passkey is set after the passkey
 * and nothing weaker (setFirstPassword): a password set on a provider alone
 * would open the device pass with the provider alone. Every other act takes
 * what the step-up gate takes. `approve` is never offered: on a step-up the
 * asker is already attached, and it must not answer its own question (C1).
 */
export function stepUpWays(v2: V2Identity, username: string, act: StepUpAct): StepWays {
  const account = v2.accounts.get(username)
  if (account === null) return NONE
  const passkey = v2.factors.store.hasPasskey(username)
  if (act === 'change-password' && passkey) return { passkey: true, providers: [], codes: [] }
  const providers = [...new Set((account.links ?? []).map((link) => link.provider))].filter((id) => v2.oauth.providers.has(id))
  const codes: StepWays['codes'] = []
  if (v2.factors.store.totpActive(username)) codes.push('totp')
  if (account.recovery.length > 0) codes.push('recovery')
  return { passkey, providers, codes }
}

/** What the page is told about a `step-up` request, beside the summary. */
export function stepOf(v2: V2Identity, request: AuthRequest): AuthStepUp | null {
  if (request.intent !== 'step-up' || request.opener === null || request.act === null) return null
  return { act: request.act, sentence: STEP_UP_SENTENCE[request.act], ...stepUpWays(v2, request.opener.username, request.act) }
}

/** May the opener's account step up for this act at all? The alarm answers first. */
const alarmed = (v2: V2Identity, username: string, act: StepUpAct): boolean =>
  // "Not me" closes every act but the password: setting it is the way out of
  // the alarm, and a lock with its key inside is no lock (v2-step-up.ts).
  act !== 'change-password' && v2.factors.store.mustChangePassword(username)

interface Opener {
  username: string
  jti: string
  device: string
  act: StepUpAct
}

/**
 * The gates every page call on a `step-up` request passes: the right kind of
 * request, still open, its opener still signed in, and the alarm quiet for the
 * act. Answers the opener, or null with the refusal written.
 */
function gate(ctx: V2Context, request: AuthRequest, at: string): Opener | null {
  const { v2, response } = ctx
  if (request.intent !== 'step-up' || request.act === null || request.opener === null) {
    v2Json(response, 404, { error: 'not_this_request', message: SENTENCES.not_this_request })
    return null
  }
  if (v2.auth?.requests.isOpen(request) !== true) {
    v2Json(response, 410, { error: 'expired', message: SENTENCES.over })
    return null
  }
  const { username, jti, device } = request.opener
  if (v2.accounts.get(username) === null || !v2.accounts.isLiveSession(username, jti)) {
    say(ctx, `refused why=session_over at=${at}`)
    v2Json(response, 401, { error: 'session_over', message: SENTENCES.session_over })
    return null
  }
  if (alarmed(v2, username, request.act)) {
    say(ctx, `refused why=password_change_required at=${at}`)
    v2Json(response, 403, factorError('password_change_required'))
    return null
  }
  return { username, jti, device, act: request.act }
}

/** "GitHub", "GitHub or Google". */
const named = (providers: readonly ProviderId[]): string => providers.map((p) => PROVIDER_LABEL[p]).join(' or ')

/**
 * POST /v2/auth/requests with intent `step-up`: may this session open one?
 * Answers the opener to record, or null with the refusal written. Only the
 * web opens one — its code comes back to the browser holding the session.
 */
export function openerForStepUp(ctx: V2Context, signed: Signed, act: StepUpAct): { username: string; jti: string; device: string } | null {
  const { v2, response } = ctx
  if (alarmed(v2, signed.account.username, act)) {
    v2Json(response, 403, factorError('password_change_required'))
    return null
  }
  const ways = stepUpWays(v2, signed.account.username, act)
  if (!ways.passkey && ways.providers.length === 0 && ways.codes.length === 0) {
    v2Json(response, 409, { error: 'no_rung', message: SENTENCES.no_rung })
    return null
  }
  return { username: signed.account.username, jti: signed.claims.jti, device: signed.claims.dev }
}

/**
 * POST /auth/api/step-up — the page wants a rung (passkey or a code). A ladder
 * pending is opened for this request alone, climbed through the ladder's own
 * routes, and never authorised by them: its finish is `heldForOpener`.
 */
export function startLadder(ctx: V2Context, request: AuthRequest): void {
  const { v2 } = ctx
  const opener = gate(ctx, request, 'ladder')
  if (opener === null) return
  const ways = stepUpWays(v2, opener.username, opener.act)
  const next: Factor[] = [...(ways.passkey ? (['passkey'] as const) : []), ...ways.codes]
  if (next.length === 0) {
    v2Json(ctx.response, 409, {
      error: 'no_rung',
      message: ways.providers.length === 0 ? SENTENCES.no_rung : `Confirm with ${named(ways.providers)} instead.`
    })
    return
  }
  // One ladder per request: a second press replaces the first.
  if (request.stepUp !== null) v2.factors.pending.close(request.stepUp)
  const pending = v2.factors.pending.open({
    username: opener.username,
    device: null,
    deviceName: opener.username,
    kind: 'account',
    address: asking(ctx),
    next,
    act: opener.act,
    opener: { jti: opener.jti, device: opener.device },
    authRequest: request.id
  })
  v2.auth?.requests.holdStepUp(request, pending.id)
  v2Json(ctx.response, 200, { pending: pending.id, next, expiresAt: pending.expiresAt }, { 'cache-control': 'private, no-store' })
}

/**
 * A RUNG WAS CLIMBED ON THE PAGE for a `step-up` request (finishRung sends it
 * here). Nothing is authorised and no sitting is marked: the proof is held on
 * the request and the page is handed its way back.
 */
export function heldForOpener(ctx: V2Context, pending: Pending, id: string, by: VerifiedBy | null): void {
  ctx.v2.factors.pending.close(id)
  const request = ctx.auth?.request
  if (request === undefined || request.id !== pending.authRequest || by === null) {
    v2Json(ctx.response, 410, { error: 'expired', message: SENTENCES.over })
    return
  }
  const opener = gate(ctx, request, 'rung')
  if (opener === null) return
  if (opener.act !== pending.act) {
    v2Json(ctx.response, 410, { error: 'expired', message: SENTENCES.over })
    return
  }
  hold(ctx, request, opener, by)
}

function hold(ctx: V2Context, request: AuthRequest, opener: Opener, by: VerifiedBy): void {
  ctx.v2.auth?.requests.holdStepBy(request, by)
  say(ctx, `held act=${opener.act} by=${by} client=${request.client}`)
  finishRequest(ctx, request, { status: 200, body: { status: 'step-up', act: opener.act } })
}

/**
 * POST /v2/oauth/:provider/start for a `step-up` request: only a provider this
 * account linked, and only for an act that takes one. Answers whether the trip
 * may start; a trip that could only come back refused is never started.
 */
export function mayStartProvider(ctx: V2Context, request: AuthRequest, provider: ProviderId): boolean {
  const opener = gate(ctx, request, 'start')
  if (opener === null) return false
  const ways = stepUpWays(ctx.v2, opener.username, opener.act)
  if (ways.providers.includes(provider)) return true
  v2Json(ctx.response, 400, {
    error: 'not_offered',
    message: ways.passkey && ways.providers.length === 0 ? `${SENTENCES.not_offered} Use your passkey.` : SENTENCES.not_offered
  })
  return false
}

/**
 * POST /auth/api/continue for a `step-up` request: the provider came back. It
 * must be an identity on the opener's account — anyone can prove they are
 * somebody at GitHub. A paused link still counts, as in the app's own step-up.
 */
export function continueStepUp(ctx: V2Context, request: AuthRequest, proof: ProviderProof): void {
  const { v2 } = ctx
  const opener = gate(ctx, request, 'provider')
  if (opener === null) return
  const ways = stepUpWays(v2, opener.username, opener.act)
  if (!ways.providers.includes(proof.provider) || v2.links.linkOf(opener.username, proof.provider, proof.subject) === null) {
    say(ctx, 'refused why=wrong_identity at=provider')
    const others = ways.providers.length === 0 ? '' : ` Continue with ${named(ways.providers)} as the account you signed up with, or sign out of ${PROVIDER_LABEL[proof.provider]} first.`
    v2Json(ctx.response, 403, { error: 'wrong_identity', message: `${SENTENCES.wrong_identity}${others}` })
    return
  }
  hold(ctx, request, opener, 'provider')
}

export type StepUpSpent = { ok: true; location: string } | { ok: false; message: string }

/**
 * THE PROOF COUNTS HERE AND ONLY HERE: /auth/complete, in the browser that
 * opened the request (the redeem checked its verifier), with the very session
 * that opened it. The sitting is marked verified now, and one authorised
 * pending for this act and this sitting is minted — what the app's provider
 * step-up earns, no more.
 */
export function spendStepUp(v2: V2Identity, request: AuthRequest, signed: Signed | null, http: IncomingMessage): StepUpSpent {
  const log = (line: string): void => v2.auth?.log(`step-up: ${line} client=${request.client}`)
  const { opener, act, stepBy } = request
  if (signed === null || opener === null || act === null || stepBy === null || signed.claims.jti !== opener.jti || signed.account.username !== opener.username) {
    log('refused why=not_the_opener at=spend')
    return { ok: false, message: SENTENCES.not_the_opener }
  }
  const { username } = opener
  if (alarmed(v2, username, act)) {
    log('refused why=password_change_required at=spend')
    return { ok: false, message: factorError('password_change_required').message }
  }
  // The account may have gained a passkey while the person was away.
  if (act === 'change-password' && stepBy !== 'passkey' && v2.factors.store.hasPasskey(username)) {
    log('refused why=passkey_required at=spend')
    return { ok: false, message: 'This account has a passkey now. Confirm with the passkey, then set the password.' }
  }
  const pending = v2.factors.pending.open({
    username,
    device: null,
    deviceName: username,
    kind: 'account',
    address: callerAddress(http.headers, http.socket.remoteAddress, v2.trustedProxies),
    next: [],
    act,
    opener: { jti: opener.jti, device: signed.claims.dev }
  })
  v2.factors.pending.authorise(pending.id)
  v2.accounts.markVerified(username, opener.jti, stepBy)
  log(`proven act=${act} by=${stepBy}`)
  const back = request.returnPath ?? '/me'
  const query = new URLSearchParams({ [STEP_UP_LANDING_PARAM]: act }).toString()
  const fragment = new URLSearchParams({ [STEP_UP_LANDING_HASH]: pending.id }).toString()
  return { ok: true, location: `${back}?${query}#${fragment}` }
}
