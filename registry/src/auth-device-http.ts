import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isProviderId, type ProviderId } from '../../src/shared/oauth'
import { DeviceTransactions, hashBrowserSecret, hashCsrfToken, type DeviceTransactionResult, type DeviceTransactionsOptions } from './auth-device-transaction'
import { ProviderBinding } from './auth-provider-binding'
import { json, readJsonBody } from './http'
import type { OAuthProvider, ProviderProof } from './v2-oauth-providers'
import { callerAddress, Limiter } from './v2-limiter'

/**
 * THE AUTH ORIGIN'S HTTP, and the one product-origin path it answers.
 *
 * On the auth origin: open a device transaction, prove it, start a provider
 * trip for the proven device, finish it. On the product origin: the provider's
 * callback, at the path the existing OAuth already registered, taken ONLY when
 * the one-use state is this binding's — anything else is left untouched for the
 * legacy flow.
 *
 * NOTHING HERE ISSUES A SESSION OR ATTACHES A DEVICE. Finishing hands the
 * frozen `{ device, proof }` to the ladder seam and writes back what it
 * answers, with no cookie; without a ladder, finishing refuses before spending
 * anything. The device is always the one the transaction proved: no request
 * after the proof may carry one.
 */

const COOKIE = '__Host-cr_auth_device'
const CREATE = '/auth/device-transactions'
const PROOF = '/auth/device-transactions/proof'
const START = '/auth/provider/start'
const FINISH = '/auth/provider/finish'
const CALLBACK = /^\/v2\/oauth\/([a-z]+)\/callback$/
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
const PAGE_HEADERS = {
  ...HEADERS,
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
}
const token = () => randomBytes(32).toString('base64url')

/** What one finished provider trip hands the ladder: the proven device, never a browser's claim. */
export interface ProvenProvider {
  readonly device: DeviceTransactionResult
  readonly proof: ProviderProof
}

export interface ProviderBindingHttpOptions {
  providers: ReadonlyMap<ProviderId, OAuthProvider>
  /** The MFA ladder. It alone decides what a proof earns; its answer is written as JSON, never with a cookie. */
  ladder?: (proven: ProvenProvider) => Record<string, unknown>
}

export interface AuthDeviceHttp {
  /** Every request that arrived on the auth origin. */
  handle: (request: IncomingMessage, response: ServerResponse) => void
  /** A product-origin request. True when it was a callback this binding owns, and it has been answered. */
  providerCallback: (request: IncomingMessage, response: ServerResponse, url: URL) => boolean
}

const only = (body: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(body).every((key) => keys.includes(key))

function browserSecretOf(request: IncomingMessage): string | undefined {
  const cookies = (request.headers.cookie ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE}=`))
  return cookies.length === 1 ? cookies[0].slice(COOKIE.length + 1) : undefined
}

const credentialsOf = (request: IncomingMessage, transactionId: unknown) =>
  ({ transactionId, browserSecret: browserSecretOf(request), csrfToken: request.headers['x-csrf-token'] })

function overPage(response: ServerResponse, signIn: string): void {
  const href = signIn.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
  const payload = Buffer.from(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cookrew</title></head><body>' +
      `<p>That sign-in is over. Start again.</p><p><a href="${href}">Back to sign-in</a></p></body></html>`,
    'utf8'
  )
  response.writeHead(400, { ...PAGE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-length': String(payload.byteLength) })
  response.end(payload)
}

export function createAuthDeviceHttp(
  options: DeviceTransactionsOptions,
  provider?: ProviderBindingHttpOptions & { callbackOrigin: string }
): AuthDeviceHttp {
  const transactions = new DeviceTransactions(options)
  const binding = provider
    ? new ProviderBinding({
        transactions,
        providers: provider.providers,
        callbackOrigin: provider.callbackOrigin,
        isDeviceRevoked: options.isDeviceRevoked,
        ...(options.now === undefined ? {} : { now: options.now })
      })
    : null
  const callbackHost = provider ? new URL(provider.callbackOrigin).host : null
  const signIn = `${transactions.audience}/sign-in`
  const limiter = new Limiter(30)
  const routes = binding ? [CREATE, PROOF, START, FINISH] : [CREATE, PROOF]

  function create(body: Record<string, unknown>, response: ServerResponse): void {
    if (!only(body, ['device'])) { json(response, 400, {}, HEADERS); return }
    const browser = token()
    const csrfToken = token()
    const created = transactions.create({ device: body.device, browserSecretHash: hashBrowserSecret(browser), csrfHash: hashCsrfToken(csrfToken) })
    if (!created.ok) { json(response, created.reason === 'capacity' ? 429 : 400, {}, HEADERS); return }
    const { transactionId, challenge, transcript, deviceId, expiresAt } = created
    json(response, 201, { transactionId, challenge, transcript, deviceId, expiresAt, csrfToken }, {
      ...HEADERS, 'set-cookie': `${COOKIE}=${browser}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=900`
    })
  }

  function prove(request: IncomingMessage, body: Record<string, unknown>, response: ServerResponse): void {
    if (!only(body, ['transactionId', 'signature'])) { json(response, 400, {}, HEADERS); return }
    const presented = credentialsOf(request, body.transactionId)
    const result = transactions.prove(body.transactionId, { ...presented, signature: body.signature })
    if (!result.ok) { json(response, 403, {}, HEADERS); return }
    response.writeHead(204, HEADERS); response.end()
  }

  function start(bound: ProviderBinding, request: IncomingMessage, body: Record<string, unknown>, response: ServerResponse): void {
    if (!only(body, ['transactionId', 'provider']) || !isProviderId(body.provider)) { json(response, 400, {}, HEADERS); return }
    const started = bound.start(body.provider, credentialsOf(request, body.transactionId))
    if (started === null) { json(response, 403, {}, HEADERS); return }
    json(response, 201, { authorizeUrl: started.authorizeUrl, expiresAt: started.expiresAt }, HEADERS)
  }

  function finish(bound: ProviderBinding, request: IncomingMessage, body: Record<string, unknown>, response: ServerResponse): void {
    if (!only(body, ['transactionId'])) { json(response, 400, {}, HEADERS); return }
    const ladder = provider?.ladder
    // No ladder, nothing to hand a proof to: refuse while the proof is still held.
    if (ladder === undefined) { json(response, 503, {}, HEADERS); return }
    const proven = bound.finish(credentialsOf(request, body.transactionId))
    if (proven === null) { json(response, 403, {}, HEADERS); return }
    json(response, 200, ladder(proven), HEADERS)
  }

  function handle(request: IncomingMessage, response: ServerResponse): void {
    const path = request.url ?? ''
    if (request.method !== 'POST' || !routes.includes(path)) { json(response, 404, {}, HEADERS); return }
    if (!limiter.take(callerAddress(request.headers, request.socket.remoteAddress))) { json(response, 429, {}, HEADERS); return }
    if (request.headers.origin !== options.audience) { json(response, 403, {}, HEADERS); return }
    void readJsonBody(request, 4096).then((body) => {
      if (!body.ok) { json(response, body.reason === 'too_large' ? 413 : 400, {}, HEADERS); return }
      if (path === CREATE) create(body.value, response)
      else if (path === PROOF) prove(request, body.value, response)
      else if (binding && path === START) start(binding, request, body.value, response)
      else if (binding) finish(binding, request, body.value, response)
    }).catch(() => { if (!response.headersSent) json(response, 500, {}, HEADERS); else response.end() })
  }

  function providerCallback(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
    if (binding === null || request.method !== 'GET' || request.headers.host !== callbackHost) return false
    const match = CALLBACK.exec(url.pathname)
    const name = match?.[1]
    if (!isProviderId(name) || !binding.owns(url.searchParams)) return false
    void binding.callback(name, url.searchParams).then((ok) => {
      if (!ok) { overPage(response, signIn); return }
      response.writeHead(303, { ...PAGE_HEADERS, location: signIn, 'content-length': '0' })
      response.end()
    }).catch(() => { if (!response.headersSent) overPage(response, signIn); else response.end() })
    return true
  }

  return { handle, providerCallback }
}
