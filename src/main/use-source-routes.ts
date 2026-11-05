import type http from 'node:http'
import { USE_SOURCES_PATH } from '../shared/use-sources'
import { sendBody } from './http-compress'
import { readJson, respondJson } from './mobile-http'
import { NO_SOURCE, type UseSourceService } from './use-source-service'

/**
 * THE PICKER'S ROUTES, FOR THE PHONE (the desktop asks over IPC).
 *
 *   GET  /api/use/sources            the windows and displays, with pictures
 *   POST /api/use/sources/open       { source, card? }: make or re-point a card
 *   POST /api/use/sources/settings   open the grant's page in System Settings
 *
 * A thumbnail is what is on the owner's screen right now, so a READ needs the
 * pairing credential here too. The wall's read-only token is good for every
 * other GET; it is not good for this, and neither is the gate's escape for an
 * embedder with no token at all. handleMobileApi's own gate runs first; this
 * asks for more on top of it, never less. The list is never stored either: a
 * phone's cache would keep pictures of the screen after the phone was forgotten.
 */

export const isUseSourceRoute = (path: string): boolean => path === USE_SOURCES_PATH || path.startsWith(`${USE_SOURCES_PATH}/`)

const NOT_PAIRED = 'Pair this device to see what is on the screen: a read-only token does not reach it'

export async function handleUseSourceRoutes(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  path: string,
  context: { readonly service: UseSourceService | undefined; readonly workspaceId: string; readonly paired: boolean }
): Promise<void> {
  const { service, workspaceId, paired } = context
  if (!paired) return respondJson(response, 403, { ok: false, error: NOT_PAIRED })
  if (!service) return respondJson(response, 503, { ok: false, error: NO_SOURCE })
  const method = request.method ?? 'GET'
  const wrongMethod = (): void => respondJson(response, 405, { ok: false, error: 'Method not allowed' })

  if (path === USE_SOURCES_PATH) {
    if (method !== 'GET') return wrongMethod()
    const answer = await service.list(workspaceId)
    if (!answer.ok) return respondJson(response, answer.status, { ok: false, error: answer.error })
    return sendBody(response, 200, { 'content-type': 'application/json', 'cache-control': 'no-store' }, Buffer.from(JSON.stringify(answer.value)), request.headers['accept-encoding'])
  }
  if (path === `${USE_SOURCES_PATH}/open`) {
    if (method !== 'POST') return wrongMethod()
    const pick = await readJson<unknown>(request).catch(() => null)
    const answer = await service.open(workspaceId, pick)
    return answer.ok ? respondJson(response, 200, { ok: true, ...answer.value }) : respondJson(response, answer.status, { ok: false, error: answer.error })
  }
  if (path === `${USE_SOURCES_PATH}/settings`) {
    if (method !== 'POST') return wrongMethod()
    const answer = await service.openSettings(workspaceId)
    return answer.ok ? respondJson(response, 200, { ok: true }) : respondJson(response, answer.status, { ok: false, error: answer.error })
  }
  respondJson(response, 404, { ok: false, error: 'Not found' })
}
