import type http from 'node:http'
import { admit, refusedRedirect, type AdmissionDeps } from './admission'
import type { AccountFile } from './account-v2'
import type { AdmittedDeviceStore } from './admitted-devices'
import type { RegistryKeys } from './canvas-token'
import { helloAnswer, helloCorsHeaders } from './device-hello'
import { respondJson } from './mobile-http'

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
  /** The credential a legacy pairing produces; an admitted phone gets it too. */
  readonly pairingToken: () => string | null
  readonly now?: () => number
  readonly log?: (message: string) => void
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
    const cors = helloCorsHeaders(request.headers.origin, deps.registryOrigin())
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
      now: deps.now ?? Date.now
    } satisfies AdmissionDeps
  )

  if (admission.ok) {
    log(`admitted ${admission.device.deviceId}${admission.firstTime ? ' (first time)' : ''}`)
    // The SAME credential a legacy pairing produces, handed over the SAME way:
    // the companion's boot lifts `?token=` into localStorage and then scrubs
    // it out of the address bar, which is what leaves the phone sitting on a
    // bare `/` with a working session. Reusing that path is deliberate — a
    // second way to issue the credential would be a second thing to revoke.
    response.writeHead(303, {
      location: admittedRedirect('/', deps.pairingToken()),
      'cache-control': 'no-store'
    })
    response.end()
    return true
  }

  const refusal = admission.refusal
  if (refusal.kind === 'key') {
    // A wrong key is a mistake, and the person is looking at the page that
    // sent them here — so they go back to it with the reason.
    const account = deps.account()
    response.writeHead(303, {
      location: refusedRedirect(deps.registryOrigin(), account?.deviceId ?? ''),
      'cache-control': 'no-store'
    })
    response.end()
    return true
  }

  log(`admission refused: ${refusal.reason}`)
  respondJson(response, 401, { error: refusal.sentence })
  return true
}
