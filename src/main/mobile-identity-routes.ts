import type http from 'node:http'
import { admit, refusedRedirect, type AdmissionDeps } from './admission'
import type { AccountFile } from './account-v2'
import type { AdmittedDeviceStore } from './admitted-devices'
import type { RegistryKeys } from './canvas-token'
import { helloAnswer, helloCorsHeaders } from './device-hello'
import { respondJson } from './mobile-http'
import { plaintextVerdict } from './plaintext-gate'
import { PAIRING_COPY } from '../shared/pairing-qr'

/**
 * THE TWO ROUTES PAIRING THROUGH cookrew.dev ADDS, AND WHY THEY SIT HERE.
 *
 * Both must answer ABOVE the pairing-token gate in mobile-api, because both
 * exist for a phone that does not have the token yet — that is the entire
 * point of them. Keeping them in their own module means the exemption is one
 * import in mobile-server rather than two more branches inside a cascade that
 * already decides who may read a transcript.
 *
 *   GET /api/hello?nonce=…      "prove you are the device the registry named"
 *   GET /?open=…&key=…&device=… "let me in, and give me the session"
 *
 * Everything either route can do without an account is nothing: `identity`
 * being absent, or `account()` answering null, leaves both silent and the
 * legacy `?token=` path — which still works, and must — untouched.
 */

export interface MobileIdentityDeps {
  readonly account: () => AccountFile | null
  readonly registryOrigin: () => string
  readonly keys: () => Promise<RegistryKeys | null>
  readonly refreshKeys: () => Promise<RegistryKeys | null>
  readonly admitted: AdmittedDeviceStore
  readonly acceptsPairingKey: (key: string) => boolean
  /** The credential a legacy pairing produces, for a phone with no token yet. */
  readonly pairingToken: () => string | null
  /** Is the TLS listener up? A plaintext admission is sent there instead. */
  readonly httpsReady?: () => boolean
  /** Where the secure address is, for the redirect. */
  readonly secureLocation?: (request: http.IncomingMessage, url: URL) => string | null
  /** Burn a canvas token's jti, so a recorded admission cannot be replayed. */
  readonly spend?: (jti: string, exp: number) => boolean
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

/** Where an admitted phone is sent so the companion boot lifts its session. */
export const admittedRedirect = (base: string, token: string | null): string =>
  token ? `${base}?token=${encodeURIComponent(token)}` : base

export const handleIdentityRoutes = async (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  deps: MobileIdentityDeps | undefined
): Promise<boolean> => {
  if (!deps) return false
  const method = request.method ?? 'GET'
  const log = deps.log ?? ((): void => undefined)

  if (url.pathname === '/api/hello') {
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
    const answer = helloAnswer(deps.account(), url.searchParams.get('nonce'))
    response.writeHead(answer.status, {
      ...cors,
      'content-type': 'application/json',
      'cache-control': 'no-store'
    })
    response.end(JSON.stringify(answer.body))
    return true
  }

  // Only `/` carries an admission, and only with a token on it. Anything else
  // is an ordinary page load and belongs to the renderer handler below.
  const open = url.searchParams.get('open')
  if (method !== 'GET' || url.pathname !== '/' || !open) return false

  /**
   * NOT IN THE CLEAR. The query carries a canvas token and the answer carries
   * a session; both are secrets in transit, and the plaintext listener puts
   * them on the LAN for anyone with a packet capture. A phone that arrived
   * here over http is sent to the https address with the same query intact, so
   * the ceremony completes rather than dead-ends.
   */
  const verdict = plaintextVerdict(request, deps.httpsReady?.() ?? false)
  if (verdict !== 'allow') {
    const secure = verdict === 'redirect' ? (deps.secureLocation?.(request, url) ?? null) : null
    if (secure) {
      log('admission arrived in the clear — sending it to the secure address')
      response.writeHead(307, { location: secure, 'cache-control': 'no-store' })
      response.end()
      return true
    }
    // 426: the request is fine, the transport is not, and there is no secure
    // address to name — which is a real state (no openssl, no certificate).
    log('admission refused: plaintext listener, and no secure address to offer')
    respondJson(response, 426, { error: PAIRING_COPY.INSECURE })
    return true
  }

  const admission = await admit(
    {
      token: open,
      key: url.searchParams.get('key'),
      phoneDeviceId: url.searchParams.get('device'),
      phoneName: url.searchParams.get('name')
    },
    {
      account: deps.account,
      keys: deps.keys,
      refreshKeys: deps.refreshKeys,
      admitted: deps.admitted,
      acceptsPairingKey: deps.acceptsPairingKey,
      ...(deps.spend ? { spend: deps.spend } : {}),
      now: deps.now ?? Date.now,
      log
    } satisfies AdmissionDeps
  )

  if (admission.ok) {
    log(`admitted ${admission.device.deviceId}${admission.firstTime ? ' (first time)' : ''}`)
    // The SAME credential a legacy pairing produces, handed over the SAME way:
    // the companion's boot lifts `?token=` into localStorage and then scrubs
    // it out of the address bar, which is what leaves the phone sitting on a
    // bare `/` with a working session. Reusing that path is deliberate — a
    // second way to issue the credential would be a second thing to revoke.
    // THIS PHONE'S OWN token, not the global one. Handing every admitted
    // phone the same credential meant one captured phone was every phone, and
    // FORGET revoked nothing — the token it held was everybody's.
    response.writeHead(303, {
      location: admittedRedirect('/', admission.token || deps.pairingToken()),
      'cache-control': 'no-store'
    })
    response.end()
    return true
  }

  const refusal = admission.refusal
  if (refusal.kind === 'key' || refusal.kind === 'device') {
    // A wrong key and a link that named the Mac are both mistakes, and in both
    // the person is looking at the page that sent them here — so they go back
    // to it with the reason, and the page says which one it was.
    const account = deps.account()
    response.writeHead(303, {
      location: refusedRedirect(deps.registryOrigin(), account?.deviceId ?? '', refusal.kind),
      'cache-control': 'no-store'
    })
    response.end()
    return true
  }

  log(`admission refused: ${refusal.kind === 'token' ? refusal.reason : refusal.kind}`)
  respondJson(response, 401, { error: refusal.sentence })
  return true
}
