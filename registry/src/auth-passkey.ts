import type { AuthEnrolment } from '../../src/shared/auth-site'
import { PROVIDER_LABEL, providerNames, type ProviderId } from '../../src/shared/oauth'
import type { StepUpAct } from '../../src/shared/step-up'
import { readJsonBody } from './http'
import type { AuthRequest, HeldPasskey } from './auth-requests'
import { finishRequest } from './auth-finish'
import { json, refuseFactor, spendChallenge, relyingParty } from './v2-factor-http'
import { factorError } from './v2-factor-copy'
import { parseRegistration } from './v2-passkeys'
import { PASSKEYS_MAX } from './v2-factor-store'
import { addRefusal, creationOptions, enrolLog } from './v2-enrol-routes'
import { asking, refuse, v2Json, type Signed, type V2Context, type V2Identity } from './v2-http'
import type { ProviderProof } from './v2-oauth-providers'

/**
 * ADDING A PASSKEY, ON AUTH.COOKREW.DEV.
 *
 * The one place a passkey is made. A client that is signed in (the desktop with
 * its bearer, cookrew.dev with its cookie) opens a `passkey` request for its
 * own account and device; a real browser runs the ceremony here, where
 * WebAuthn works and the rpId is the product's host, so the passkey opens the
 * account on cookrew.dev and on this page alike.
 *
 * THE THRESHOLD IS THE ACCOUNT'S OWN, unchanged. An account with no password
 * must step up for `add-factor` (STEP_UP_ENFORCEMENT: 'passwordless'), and the
 * one proof it has is a provider round trip. That trip runs on this page, for
 * this request: the identity must already be linked to the opener's account,
 * and what it earns is an ordinary climbed pending for act `add-factor`, bound
 * to the opener's session, held on the request (never sent to the page) and
 * spent by the one passkey it allows. A password account asks for nothing
 * here, exactly as POST /v2/me/passkeys/options asks it for nothing.
 *
 * NOTHING IS WRITTEN BY THE PAGE. The verified passkey waits on the request,
 * like a link's proof, and the opener writes it when it spends the code with
 * its verifier AND its own session. A browser that caught the request's URL
 * can finish the page; it cannot add its own authenticator to the account.
 */

const ACT: StepUpAct = 'add-factor'
const ATTESTATION_BODY = 32 * 1024
const NAME_MAX = 64
const DEFAULT_NAME = 'Passkey'

type Refusal = 'not_this_request' | 'session_over' | 'over' | 'not_linked' | 'wrong_identity' | 'not_the_opener'

const SENTENCES: Record<Refusal, string> = {
  not_this_request: 'This page was not opened to add a passkey. Start again from Security.',
  session_over: 'The session that asked for this passkey has ended. Sign in again, then add the passkey from Security.',
  over: 'This request already finished. To add another passkey, start again from Security.',
  not_linked: 'This account does not sign in that way.',
  wrong_identity: 'That is not the account linked to this Cookrew account.',
  not_the_opener: 'Only the session that asked for this passkey can add it. Start again from Security on that device.'
}

const say = (ctx: V2Context, request: AuthRequest, line: string): void => enrolLog(ctx, `${line} client=${request.client}`)

/** "GitHub", "GitHub or Google": the ways this account proves itself, in words. */
const named = providerNames

/** The account's linked providers, each once. */
function providersOf(v2: V2Identity, username: string): ProviderId[] {
  const links = v2.accounts.get(username)?.links ?? []
  return [...new Set(links.map((link) => link.provider))]
}

const stepUpSentence = (providers: readonly ProviderId[]): string =>
  providers.length === 0
    ? 'This account has no password and no way to prove it here. Add a passkey from a device that is signed in with a password.'
    : `Prove it is you first: continue with ${named(providers)}, the way this account signs in. You come straight back here.`

/** Is this request's opener still signed in, and is its account standing? */
function openerOf(v2: V2Identity, request: AuthRequest): { username: string; jti: string; passwordless: boolean } | null {
  const opener = request.opener
  if (request.intent !== 'passkey' || opener === null) return null
  const account = v2.accounts.get(opener.username)
  if (account === null || !v2.accounts.isLiveSession(opener.username, opener.jti)) return null
  return { username: opener.username, jti: opener.jti, passwordless: account.passwordless === true }
}

const proven = (v2: V2Identity, request: AuthRequest, opener: { username: string; jti: string }): boolean =>
  v2.factors.pending.holdsAuthorised(opener.username, ACT, request.stepUp, opener.jti)

/** What the page is told about a `passkey` request, beside the summary. */
export function enrolmentOf(v2: V2Identity, request: AuthRequest): AuthEnrolment | null {
  if (request.intent !== 'passkey' || request.opener === null) return null
  const opener = openerOf(v2, request)
  const providers = providersOf(v2, request.opener.username)
  const needs = opener !== null && opener.passwordless && !proven(v2, request, opener) ? 'provider' : 'ready'
  return { needs, providers }
}

/**
 * The gates every page call on a `passkey` request passes: the right kind of
 * request, still open, its opener still signed in, and the not-me alarm quiet.
 * Answers the opener, or null with the refusal written.
 */
function gate(ctx: V2Context, request: AuthRequest, at: string): { username: string; jti: string; passwordless: boolean } | null {
  const { v2, response } = ctx
  if (request.intent !== 'passkey') {
    v2Json(response, 404, { error: 'not_this_request', message: SENTENCES.not_this_request })
    return null
  }
  if (v2.auth?.requests.isOpen(request) !== true) {
    v2Json(response, 410, { error: 'expired', message: SENTENCES.over })
    return null
  }
  const opener = openerOf(v2, request)
  if (opener === null) {
    say(ctx, request, `refused why=session_over at=${at}`)
    v2Json(response, 401, { error: 'session_over', message: SENTENCES.session_over })
    return null
  }
  if (v2.factors.store.mustChangePassword(opener.username)) {
    say(ctx, request, `refused why=password_change_required at=${at}`)
    refuseFactor(response, 403, 'password_change_required')
    return null
  }
  return opener
}

/**
 * POST /v2/oauth/:provider/start for a `passkey` request: only a provider this
 * account already linked can prove anything, so any other is refused before
 * the person is sent away to it. Answers whether the trip may start.
 */
export function mayStartStepUp(ctx: V2Context, request: AuthRequest, provider: ProviderId): boolean {
  if (request.intent !== 'passkey' || request.opener === null) return true
  // A trip that could only come back to "signed out" or the alarm is not started.
  if (gate(ctx, request, 'start') === null) return false
  const providers = providersOf(ctx.v2, request.opener.username)
  if (providers.includes(provider)) return true
  v2Json(ctx.response, 400, {
    error: 'not_linked',
    message: `${SENTENCES.not_linked} ${providers.length === 0 ? '' : `Continue with ${named(providers)} instead.`}`.trim()
  })
  return false
}

/**
 * POST /auth/api/continue for a `passkey` request: the provider came back.
 *
 * It must be an identity on the opener's account — anyone can prove they are
 * somebody at GitHub. A paused link still counts, as in the app's own step-up:
 * the pause is about signing in with the provider, not about the owner proving
 * it is them. What it earns is held here and never shown to the page.
 */
export function continuePasskey(ctx: V2Context, request: AuthRequest, proof: ProviderProof): void {
  const { v2 } = ctx
  const opener = gate(ctx, request, 'step-up')
  if (opener === null) return
  if (v2.links.linkOf(opener.username, proof.provider, proof.subject) === null) {
    const providers = providersOf(v2, opener.username)
    say(ctx, request, 'step-up refused why=wrong_identity')
    v2Json(ctx.response, 403, {
      error: 'wrong_identity',
      message: `${SENTENCES.wrong_identity} Continue with ${named(providers)} as the account you signed up with, or sign out of ${PROVIDER_LABEL[proof.provider]} first.`
    })
    return
  }
  // One proof per request: a second trip replaces the first, which closes.
  if (request.stepUp !== null) v2.factors.pending.close(request.stepUp)
  const pending = v2.factors.pending.open({
    username: opener.username,
    device: null,
    deviceName: opener.username,
    kind: 'account',
    address: asking(ctx),
    next: [],
    act: ACT,
    opener: { jti: opener.jti, device: request.opener?.device ?? '' },
    authRequest: request.id
  })
  v2.factors.pending.authorise(pending.id)
  v2.auth?.requests.holdStepUp(request, pending.id)
  say(ctx, request, `step-up proven provider=${proof.provider}`)
  json(ctx.response, 200, { status: 'ready', enrol: enrolmentOf(v2, request) })
}

/** The challenge key for this request's ceremony: one request, one ceremony. */
const challengeKey = (request: AuthRequest): string => `enrol-page|${request.id}`

/** POST /auth/api/passkey/options — what navigator.credentials.create is asked for. */
export function passkeyOptionsOnPage(ctx: V2Context, request: AuthRequest): void {
  const { v2 } = ctx
  const opener = gate(ctx, request, 'options')
  if (opener === null) return
  if (opener.passwordless && !proven(v2, request, opener)) {
    const providers = providersOf(v2, opener.username)
    say(ctx, request, 'refused why=step_up at=options')
    v2Json(ctx.response, 403, { error: 'step_up', message: stepUpSentence(providers), providers })
    return
  }
  // Said BEFORE the browser makes anything: a credential the registry then
  // refuses would sit in the person's keychain, offered at every sign-in.
  if (v2.factors.store.passkeys(opener.username).length >= PASSKEYS_MAX) {
    say(ctx, request, 'refused why=passkey_limit at=options')
    refuseFactor(ctx.response, 409, 'passkey_limit')
    return
  }
  const account = v2.accounts.get(opener.username)
  const challenge = v2.factors.challenges.issue(challengeKey(request))
  json(ctx.response, 200, creationOptions(ctx, opener.username, account?.displayName ?? '', challenge))
}

/** The credential's two halves, or null for a body that is not one. */
function attestationOf(value: unknown): { clientDataJSON: unknown; attestationObject: unknown } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const inner = (value as { response?: unknown }).response
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return null
  const { clientDataJSON, attestationObject } = inner as Record<string, unknown>
  return { clientDataJSON, attestationObject }
}

const nameOf = (raw: unknown): string | null => {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name.length > NAME_MAX) return null
  return name === '' ? DEFAULT_NAME : name
}

/**
 * POST /auth/api/passkey — the page made one. Verified here against this
 * origin and the product's rpId, then held for the opener; the step-up is
 * spent now, by the one passkey it allowed. A refusal before that point keeps
 * the proof, so a cancelled Touch ID is a second press, not a second trip.
 */
export async function passkeyOnPage(ctx: V2Context, request: AuthRequest): Promise<void> {
  const { v2, response } = ctx
  const read = await readJsonBody(ctx.request, ATTESTATION_BODY)
  if (!read.ok) {
    refuse(response, read.reason === 'too_large' ? 413 : 400, 'malformed')
    return
  }
  const opener = gate(ctx, request, 'passkey')
  if (opener === null) return
  // THE BROWSER SAID NO (a cancelled Touch ID, a key that already holds one, a
  // refused rpId): nothing reaches this registry unless the page says so, and
  // the next "it cannot be added" must be in the log. The error's name only.
  if (read.value.failed !== undefined) {
    const why = typeof read.value.failed === 'string' && /^[A-Za-z]{1,40}$/.test(read.value.failed) ? read.value.failed : 'unknown'
    say(ctx, request, `browser refused why=${why}`)
    response.writeHead(204, { 'cache-control': 'private, no-store' })
    response.end()
    return
  }
  const name = nameOf(read.value.name)
  if (name === null) {
    refuseFactor(response, 400, 'bad_name')
    return
  }
  const credential = attestationOf(read.value.credential)
  const challenge = credential === null ? null : spendChallenge(v2.factors.challenges, challengeKey(request), credential.clientDataJSON)
  const { origin, rpId } = relyingParty(ctx)
  const parsed = credential === null || challenge === null ? null : parseRegistration(credential, { challenge, origin, rpId })
  if (parsed === null || !parsed.ok) {
    say(ctx, request, `refused why=${challenge === null ? 'challenge' : 'attestation'} at=passkey`)
    v2Json(response, 400, { error: 'passkey_refused', message: 'That passkey could not be checked. Try again, and finish it in this browser.' })
    return
  }
  // Said here, while the person is still on the page, rather than after the
  // trip back; the limit was asked at options, and the write checks both again.
  const known = v2.factors.store.byCredentialId(parsed.credentialId) !== null
  if (known) {
    say(ctx, request, 'refused why=passkey_known at=passkey')
    refuseFactor(response, 409, 'passkey_known')
    return
  }
  if (opener.passwordless && !v2.factors.pending.spendAuthorised(opener.username, ACT, request.stepUp, opener.jti)) {
    const providers = providersOf(v2, opener.username)
    say(ctx, request, 'refused why=step_up at=passkey')
    v2Json(response, 403, { error: 'step_up', message: stepUpSentence(providers), providers })
    return
  }
  const held: HeldPasskey = { credentialId: parsed.credentialId, jwk: parsed.jwk, signCount: parsed.signCount, name }
  v2.auth?.requests.holdPasskey(request, held)
  say(ctx, request, 'made')
  finishRequest(ctx, request, { status: 201, body: { status: 'passkey' } })
}

export type Written =
  | { ok: true; passkey: { id: string; name: string; addedAt: number } }
  | { ok: false; status: number; body: { error: string; message: string } }

/**
 * THE PASSKEY IS WRITTEN HERE AND ONLY HERE: by the client that opened the
 * request, spending its code (the redeem checked the verifier) with the very
 * session that opened it. Used by the desktop's /v2/auth/token and the web's
 * /auth/complete alike.
 */
export function writeHeldPasskey(ctx: Pick<V2Context, 'v2'>, request: AuthRequest, signed: Signed | null): Written {
  const { v2 } = ctx
  const log = (line: string): void => v2.auth?.log(`passkey enrolment: ${line} client=${request.client}`)
  const opener = request.opener
  const held = request.enrolment
  if (signed === null || opener === null || held === null || signed.claims.jti !== opener.jti || signed.account.username !== opener.username) {
    log('refused why=not_the_opener at=spend')
    return { ok: false, status: 401, body: { error: 'not_the_opener', message: SENTENCES.not_the_opener } }
  }
  if (v2.factors.store.mustChangePassword(opener.username)) {
    log('refused why=password_change_required at=spend')
    return { ok: false, status: 403, body: factorError('password_change_required') }
  }
  const added = v2.factors.store.addPasskey(opener.username, held)
  if (!added.ok) {
    const error = addRefusal(added.reason)
    log(`refused why=${error} at=spend`)
    return { ok: false, status: added.reason === 'bad_name' ? 400 : 409, body: factorError(error) }
  }
  log('added')
  return { ok: true, passkey: { id: added.passkey.id, name: added.passkey.name, addedAt: added.passkey.addedAt } }
}
