import type http from 'node:http'
import type { TLSSocket } from 'node:tls'
import type { AccountFile } from './account-v2'
import type { AdmittedDeviceStore } from './admitted-devices'
import { helloAnswer, helloAnswerV2, helloCorsHeaders } from './device-hello'
import { publishedRequestOrigin } from '../shared/hello-proof'

/**
 * THE ONE ROUTE PAIRING ADDS, AND WHY IT SITS HERE.
 *
 *   GET /api/hello?nonce=…   "prove you are the device the registry named"
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
}

export const handleIdentityRoutes = async (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  deps: MobileIdentityDeps | undefined
): Promise<boolean> => {
  if (!deps) return false
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
