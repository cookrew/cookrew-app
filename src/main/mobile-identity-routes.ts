import type http from 'node:http'
import type { TLSSocket } from 'node:tls'
import type { AccountFile } from './account-v2'
import type { AdmittedDeviceStore } from './admitted-devices'
import { companionCredential } from './companion-gate'
import { helloAnswer, helloAnswerV2, helloCorsHeaders, readAdmission } from './device-hello'
import { presentedToken, readJson, respondJson } from './mobile-http'
import { safeDeviceName, type RelayDevice } from './relay-device'
import { publishedRequestOrigin } from '../shared/hello-proof'

/**
 * THE TWO ROUTES PAIRING ADDS, AND WHY THEY SIT HERE.
 *
 *   GET  /api/hello?nonce=…   "prove you are the device the registry named"
 *   POST /api/admit           "here is MY key — mint me a token of my own"
 *
 * THE ADMISSION ROUTE (v3, V3-21) is the one place the ROOT pairing token
 * still opens on its own. It is the bootstrap: a phone that holds the
 * printed token — from the QR, from the fragment on the relay URL — presents
 * it here together with a proof of its device key (device-hello.ts ·
 * readAdmission), and leaves with a token that is its own. Everything after
 * that is authenticated by the per-device token (companion-gate.ts), which
 * is the credential FORGET and a registry revoke can actually end. The root
 * token never opens a transcript directly again — once the companion side
 * bootstraps (V3-14); until then companion-gate's `rootEverywhere` keeps
 * paired phones working.
 *
 *   ANSWER  200 { deviceId, name?, token, desktopId }
 *           token is 24 random bytes base64url — the same width as the root,
 *           so the companion stores it where the root was (cr_token:<desktopId>).
 *           desktopId is THIS Mac's device id, so the phone files it under the
 *           right Mac when one origin hosts several (pairing-scope.ts).
 *   REFUSE  401 without the root or a per-device token; 400/401/421 as
 *           readAdmission says; 404 with no account, as /api/hello.
 *
 * A phone already admitted may call it again with its per-device token — a
 * second browser on the same phone, a cleared storage — and gets a fresh
 * token; the row's old hash is replaced (admitted-devices.ts · admit).
 *
 * It must answer ABOVE the pairing-token gate in mobile-api, because it exists
 * for a phone that has not sent a credential yet — the phone races the
 * addresses on the reach card and asks each one to sign a nonce before it
 * trusts any of them with the token. Keeping it in its own module means the
 * exemption is one import in mobile-server rather than another branch inside a
 * cascade that already decides who may read a transcript.
 *
 * WHAT USED TO BE HERE: `GET /?open=<canvasToken>&key=<KEY>&device=<id>`, the
 * admission ceremony. Reach v2.1 retired it whole. A phone is authorised at
 * this Mac by the pairing token and by nothing else, whether it arrives on the
 * LAN, over the tailnet or down the relay — so `?open=` is not a route, it is
 * a query string on an ordinary page load, and the pairing gate in mobile-api
 * answers it exactly as it answers everything else. Three things went with it:
 * the six-character key, the registry-signed canvas token (and the spent-jti
 * store that stopped it being replayed), and the `?refused=` redirects back to
 * cookrew.dev. One credential cannot be replayed into a second one, and there
 * is no ceremony left to refuse halfway through.
 *
 * Everything this route can do without an account is nothing: `identity` being
 * absent, or `account()` answering null, leaves it silent.
 */

export interface MobileIdentityDeps {
  readonly account: () => AccountFile | null
  readonly registryOrigin: () => string
  /**
   * Phones this Mac has let in. Read by the companion-token door in
   * mobile-api and written by the bridge's device headers (relay-device.ts);
   * listed and forgotten from the account sheet.
   */
  readonly admitted: AdmittedDeviceStore
  /**
   * The origins THIS server answers on, so a companion served over one of
   * them may read `/api/hello` from another while it looks for a better path.
   * Supplied by mobile-server, which is the only thing that knows them.
   */
  readonly selfOrigins?: () => readonly string[]
  readonly now?: () => number
  readonly log?: (message: string) => void
  /**
   * The registry profile's display name and avatar, if main happens to hold
   * them. Optional and never fetched here: /api/account must answer from
   * local state, or the avatar waits on a network call to draw a letter.
   */
  readonly profileFace?: () => { displayName?: string; avatar?: string | null } | null
  /**
   * The root pairing token, for the admission route only. Read through a
   * function because it rotates (`cookrew mobile --rotate`) and the value in
   * the running server is the one that counts. Null before it is minted.
   */
  readonly pairingToken?: () => string | null
}

export const handleIdentityRoutes = async (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  deps: MobileIdentityDeps | undefined,
  /** The device the bridge named on this request, when it came down the relay. */
  bridged: RelayDevice | null = null
): Promise<boolean> => {
  if (!deps) return false
  if (url.pathname === '/api/admit') return admit(request, response, url, deps, bridged)
  if (url.pathname !== '/api/hello') return false
  const method = request.method ?? 'GET'

  const cors = helloCorsHeaders(
    request.headers.origin,
    deps.registryOrigin(),
    deps.selfOrigins?.() ?? []
  )
  if (method === 'OPTIONS') {
    response.writeHead(204, { ...cors, 'content-length': '0' })
    response.end()
    return true
  }
  if (method !== 'GET') return false
  const answer = helloFor(request, url, deps)
  response.writeHead(answer.status, {
    ...cors,
    'content-type': 'application/json',
    'cache-control': 'no-store'
  })
  response.end(JSON.stringify(answer.body))
  return true
}

/**
 * WHICH VERSION THIS CALLER ASKED FOR, and why the query says so.
 *
 * `?origin=` is the version marker: only a client that intends to check the
 * signed origin sends the origin it dialled, and only that client can use a
 * version 2 answer. A phone on an older bundle sends no `origin` and gets
 * exactly the answer it got before — unchanged, down to the byte — so an
 * update to the Mac never strands a companion that has not been reloaded.
 *
 * THE HOST PIN LIVES HERE, and only on the version 2 path, deliberately. It
 * exists to make the SIGNED origin true; version 1 signs no origin, so pinning
 * it there would refuse working phones to protect a field that does not exist.
 * The names are the ones this server actually answers on (`selfOrigins`, from
 * mobile-server). An empty list means this Mac cannot say what it published —
 * no certificate, no account — and a proof it cannot stand behind is a 421
 * rather than a guess made from the caller's own Host header.
 *
 * NOTE for whoever lands the server-wide Host allow-list: this is the minimal
 * check, scoped to this one route. Replace it with the shared one when it
 * arrives; the contract it must keep is `publishedRequestOrigin`.
 */
const helloFor = (
  request: http.IncomingMessage,
  url: URL,
  deps: MobileIdentityDeps
): ReturnType<typeof helloAnswer> | ReturnType<typeof helloAnswerV2> => {
  const nonce = url.searchParams.get('nonce')
  const asked = url.searchParams.get('origin')
  if (asked === null) return helloAnswer(deps.account(), nonce)
  return helloAnswerV2({
    account: deps.account(),
    nonce,
    asked,
    arrived: publishedRequestOrigin(
      request.headers.host,
      (request.socket as TLSSocket).encrypted === true,
      deps.selfOrigins?.() ?? []
    ),
    now: deps.now?.() ?? Date.now()
  })
}

/**
 * THE ADMISSION. The bearer decides whether the ceremony may begin, the body
 * decides who it is for, and only then is a token minted — in that order, so
 * a stranger without the root token learns nothing about what a valid body
 * looks like, and a valid body from a caller with no credential mints nothing.
 */
const admit = async (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  deps: MobileIdentityDeps,
  bridged: RelayDevice | null
): Promise<boolean> => {
  if ((request.method ?? 'GET') !== 'POST') {
    respondJson(response, 405, { error: 'admission is a POST' })
    return true
  }
  const account = deps.account()
  if (!account) {
    respondJson(response, 404, { error: 'no account on this desktop' })
    return true
  }
  const opened = companionCredential({
    route: 'admission',
    presented: presentedToken(request, url),
    rootToken: deps.pairingToken?.() ?? null,
    perDevice: deps.admitted.deviceFor,
    rootEverywhere: false
  })
  if (opened === null) {
    respondJson(response, 401, {
      error: 'Unauthorized — open the pairing URL shown on the desktop (it carries the token).'
    })
    return true
  }
  let body: unknown
  try {
    body = await readJson<unknown>(request, 16 * 1024)
  } catch {
    respondJson(response, 400, { error: 'the body must be JSON' })
    return true
  }
  const reading = readAdmission({
    body,
    arrived: publishedRequestOrigin(
      request.headers.host,
      (request.socket as TLSSocket).encrypted === true,
      deps.selfOrigins?.() ?? []
    ),
    bridged,
    now: deps.now?.() ?? Date.now()
  })
  if (!reading.ok) {
    respondJson(response, reading.status, { error: reading.error })
    return true
  }
  /**
   * THE CREDENTIAL THAT OPENED THE DOOR IS THE DEVICE THIS MINTS FOR (H1).
   *
   * A device token says who is asking. The body says which device the token
   * is to be minted for. Nothing bound them, so an admitted phone could sign
   * a perfect proof for a key it had just made and walk away with a second
   * credential under an id the account has never held — and an id the account
   * has never held is an id no revoke can ever name, so `prune` could not
   * reach it and the ghost outlived the phone it came from.
   *
   * So a device may re-mint its OWN token and nothing else. Admitting a NEW
   * device stays the root token's job, which is the one credential the owner
   * can rotate — and the one they are told about.
   *
   * 403 rather than 401: the credential is good, and what it asked for is not
   * its to ask. Saying 401 would send a phone to re-pair over a refusal that
   * re-pairing does not change.
   */
  if (opened.kind === 'device' && reading.deviceId !== opened.deviceId) {
    deps.log?.('refused an admission for a device other than the one that asked')
    respondJson(response, 403, {
      error: 'This device may take a new token for itself, not for another device.'
    })
    return true
  }
  const name = safeDeviceName(reading.name)
  let minted: ReturnType<AdmittedDeviceStore['admit']>
  try {
    minted = deps.admitted.admit({ deviceId: reading.deviceId, ...(name ? { name } : {}) })
  } catch (error) {
    // A ledger that will not take the row is a phone that is NOT admitted:
    // unlike a sighting, here the write IS the credential.
    console.error('Could not admit a device:', error)
    respondJson(response, 503, { error: 'this Mac could not record the admission' })
    return true
  }
  deps.log?.(`admitted ${minted.device.name ?? minted.device.deviceId} (${opened.kind} token)`)
  respondJson(response, 200, {
    deviceId: minted.device.deviceId,
    ...(minted.device.name ? { name: minted.device.name } : {}),
    token: minted.token,
    desktopId: account.deviceId
  })
  return true
}
