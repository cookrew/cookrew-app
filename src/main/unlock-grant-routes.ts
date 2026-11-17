import type http from 'node:http'
import type { ViewerWho } from '../shared/remote-access'
import { UNLOCK_GRANT_PATH } from '../shared/unlock-grant'
import { readJson, respondJson } from './mobile-http'
import type { UnlockGrantDoor } from './unlock-grant'

/**
 * SETTING UP UNLOCK, OVER HTTP (main/unlock-grant.ts).
 *
 *   POST /api/unlock-grants/ask     { commit }: a new device starts, through the relay
 *   POST /api/unlock-grants/reveal  { id, key, nonce }: and opens its commitment
 *   GET  /api/unlock-grants/status?id=  how its own exchange stands; the sealed code once allowed
 *   GET  /api/unlock-grants/pending     what waits, with its words: INSIDE only
 *   POST /api/unlock-grants/decide  { id, allow }: INSIDE only
 *
 * The asker's routes carry nothing a relay could use: a commitment, public keys,
 * and a code sealed to a key the owner has checked. The words and the yes are
 * another matter, so those take the sealed session or a page the Mac served
 * itself: a relay that could read or answer them could approve its own key.
 */

export const isUnlockGrantRoute = (path: string): boolean => path === UNLOCK_GRANT_PATH || path.startsWith(`${UNLOCK_GRANT_PATH}/`)

const INSIDE_ONLY = 'Only a device that can already unlock this Mac can see or approve a set-up, inside its sealed session.'

export async function handleUnlockGrantRoutes(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  path: string,
  url: URL,
  context: { readonly door: UnlockGrantDoor | undefined; readonly paired: boolean; readonly who: ViewerWho; readonly inside: boolean }
): Promise<void> {
  const { door, paired, who, inside } = context
  if (!paired) return respondJson(response, 403, { ok: false, error: 'Pair this device first.' })
  if (!door) return respondJson(response, 503, { ok: false, error: 'This machine cannot be set up for unlock.' })
  const method = request.method ?? 'GET'
  const route = path.slice(UNLOCK_GRANT_PATH.length)
  const body = async (): Promise<unknown> => readJson<unknown>(request, 4096).catch(() => null)
  const said = (answer: object): void => respondJson(response, 200, answer)

  if (route === '/ask' && method === 'POST') return said(await door.ask(who, await body()))
  if (route === '/reveal' && method === 'POST') return said(await door.reveal(who, await body()))
  if (route === '/status' && method === 'GET') return said(await door.status(who, url.searchParams.get('id')))
  if (route === '/pending' && method === 'GET') {
    if (!inside) return respondJson(response, 403, { ok: false, error: INSIDE_ONLY })
    return said({ ok: true, pending: door.pending(who) })
  }
  if (route === '/decide' && method === 'POST') {
    if (!inside) return respondJson(response, 403, { ok: false, error: INSIDE_ONLY })
    return said(door.decide(who, await body()))
  }
  respondJson(response, 404, { ok: false, error: 'Not found' })
}
