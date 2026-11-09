import type http from 'node:http'
import type { AccountPairDoor } from './account-pair'
import { readJson, respondJson } from './mobile-http'
import type { RelayDevice } from './relay-device'
import { PAIR_PATHS } from '../shared/account-pair'

/**
 * THE THREE ROUTES OF ENTERING WITH THE ACCOUNT (shared/account-pair.ts).
 *
 *   GET  /api/pair         may this machine be entered with the account, and how
 *   POST /api/pair/begin   a one-use challenge for one device
 *   POST /api/pair         the device's signature and the secret → its own token
 *
 * ABOVE THE PAIRING GATE, beside /api/admit, because they exist for a device
 * that holds no credential for this machine yet. What admits here is the
 * account's secret, checked by the door; nothing on these routes is opened by
 * a pairing token, and nothing they answer reveals a secret.
 *
 * NEVER A SECRET IN A URL: a `?token=` or any query on these is refused, and
 * the bodies are read here and handed to the door without being logged.
 */

const BODY_MAX = 16 * 1024

const noStore = (response: http.ServerResponse): void => {
  response.setHeader('cache-control', 'no-store')
}

export const isAccountPairPath = (pathname: string): boolean =>
  pathname === PAIR_PATHS.offer || pathname === PAIR_PATHS.begin

export async function handleAccountPairRoutes(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  door: AccountPairDoor | undefined,
  bridged: RelayDevice | null
): Promise<boolean> {
  if (!isAccountPairPath(url.pathname)) return false
  noStore(response)
  if (door === undefined) {
    respondJson(response, 404, { error: 'This machine does not take the account at the door.' })
    return true
  }
  if (url.search.length > 0) {
    respondJson(response, 400, { error: 'Nothing on these routes travels in the URL.' })
    return true
  }
  const method = request.method ?? 'GET'
  if (url.pathname === PAIR_PATHS.offer && method === 'GET') {
    respondJson(response, 200, door.offer())
    return true
  }
  if (method !== 'POST') {
    respondJson(response, 405, { error: 'Use POST.' })
    return true
  }
  // JSON only: a cross-site form post (text/plain) must not reach the door.
  if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) {
    respondJson(response, 415, { ok: false, outcome: 'refused', error: 'Send JSON.' })
    return true
  }
  let body: unknown
  try {
    body = await readJson<unknown>(request, BODY_MAX)
  } catch {
    respondJson(response, 400, { ok: false, outcome: 'refused', error: 'The body must be JSON.' })
    return true
  }
  const stamp = bridged === null ? null : { deviceId: bridged.deviceId }
  const reply =
    url.pathname === PAIR_PATHS.begin
      ? await door.begin({ body, bridged: stamp })
      : await door.finish({ body, bridged: stamp })
  respondJson(response, reply.status, reply.body)
  return true
}
