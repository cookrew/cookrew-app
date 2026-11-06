import { DOOR_MARKER, hostOutsideTheMac, UNLOCK_NEEDS_SEAL } from '../shared/remote-unlock'
import { carriesSealProof } from './seal-proof'
import { RELAY_MARKER } from './relay-base'
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
 *   POST /api/use/sources/settings   open a grant's page on the Mac: { pane? }
 *   GET  /api/use/sources/access     where the screen stands, and what can be done
 *   POST /api/use/sources/control    Take control of a card, or give it back: { card, on }
 *   POST /api/use/sources/restart    relaunch, on a build that can, to finish a grant
 *   POST /api/use/sources/wake       wake a sleeping display
 *   POST /api/use/sources/unlock/begin  the Mac's key and a one-time challenge
 *   POST /api/use/sources/unlock     { sealed }: a password sealed on the phone
 *
 * Everything here is a device somewhere else, so `where` is always away. The
 * machine switch is not here and never will be: it is the Mac's alone to set.
 *
 * A thumbnail is what is on the owner's screen right now, so a READ needs the
 * pairing credential here too. The wall's read-only token is good for every
 * other GET; it is not good for this, and neither is the gate's escape for an
 * embedder with no token at all. handleMobileApi's own gate runs first; this
 * asks for more on top of it, never less. The list is never stored either: a
 * phone's cache would keep pictures of the screen after the phone was forgotten.
 */

export const isUseSourceRoute = (path: string): boolean => path === USE_SOURCES_PATH || path.startsWith(`${USE_SOURCES_PATH}/`)

/**
 * A page the Mac served itself. The bridge writes the marker over whatever came
 * in, on the relay and on WebRTC alike, so it cannot be left off; and a page from
 * cookrew.dev whose traffic moved to the LAN still carries that Origin, which its
 * browser will not let it change.
 */
function fromTheMacsOwnPage(request: http.IncomingMessage): boolean {
  if (request.headers[RELAY_MARKER] === '1' || request.headers[DOOR_MARKER] === '1') return false
  const { host, origin } = request.headers
  if (hostOutsideTheMac(host)) return false
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

const NOT_PAIRED = 'Pair this device to see what is on the screen: a read-only token does not reach it'

export async function handleUseSourceRoutes(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  path: string,
  context: { readonly service: UseSourceService | undefined; readonly workspaceId: string; readonly paired: boolean; readonly credential: string | null }
): Promise<void> {
  const { service, workspaceId, paired, credential } = context
  if (!paired) return respondJson(response, 403, { ok: false, error: NOT_PAIRED })
  if (!service) return respondJson(response, 503, { ok: false, error: NO_SOURCE })
  const method = request.method ?? 'GET'
  const wrongMethod = (): void => respondJson(response, 405, { ok: false, error: 'Method not allowed' })

  if (path === USE_SOURCES_PATH) {
    if (method !== 'GET') return wrongMethod()
    const answer = await service.list(workspaceId, service.whoIs(credential))
    if (!answer.ok) return respondJson(response, answer.status, { ok: false, error: answer.error })
    return sendBody(response, 200, { 'content-type': 'application/json', 'cache-control': 'no-store' }, Buffer.from(JSON.stringify(answer.value)), request.headers['accept-encoding'])
  }
  if (path === `${USE_SOURCES_PATH}/open`) {
    if (method !== 'POST') return wrongMethod()
    const pick = await readJson<unknown>(request).catch(() => null)
    const answer = await service.open(workspaceId, pick, service.whoIs(credential))
    return answer.ok ? respondJson(response, 200, { ok: true, ...answer.value }) : respondJson(response, answer.status, { ok: false, error: answer.error })
  }
  if (path === `${USE_SOURCES_PATH}/settings`) {
    if (method !== 'POST') return wrongMethod()
    const body = await readJson<{ pane?: unknown } | null>(request).catch(() => null)
    const answer = await service.openSettings(workspaceId, body?.pane, 'away')
    return answer.ok ? respondJson(response, 200, { ok: true }) : respondJson(response, answer.status, { ok: false, error: answer.error })
  }
  if (path === `${USE_SOURCES_PATH}/access`) {
    if (method !== 'GET') return wrongMethod()
    const answer = await service.access(workspaceId, 'away')
    return answer.ok ? respondJson(response, 200, answer.value) : respondJson(response, answer.status, { ok: false, error: answer.error })
  }
  if (path === `${USE_SOURCES_PATH}/control`) {
    if (method !== 'POST') return wrongMethod()
    const ask = await readJson<unknown>(request).catch(() => null)
    const answer = await service.control(workspaceId, ask, service.whoIs(credential))
    if (answer.ok) return respondJson(response, 200, { ok: true })
    return respondJson(response, answer.status, { ok: false, error: answer.error, ...(answer.state ? { state: answer.state } : {}) })
  }
  if (path === `${USE_SOURCES_PATH}/restart`) {
    if (method !== 'POST') return wrongMethod()
    const answer = await service.restart(workspaceId, service.whoIs(credential))
    return answer.ok ? respondJson(response, 200, { ok: true }) : respondJson(response, answer.status, { ok: false, error: answer.error })
  }
  if (path === `${USE_SOURCES_PATH}/wake`) {
    if (method !== 'POST') return wrongMethod()
    const answer = await service.wake(workspaceId, service.whoIs(credential))
    return answer.ok ? respondJson(response, 200, { ok: true }) : respondJson(response, answer.status, { ok: false, error: answer.error })
  }
  if (path.startsWith(`${USE_SOURCES_PATH}/unlock`) && !carriesSealProof(request) && !fromTheMacsOwnPage(request)) return respondJson(response, 403, { ok: false, error: UNLOCK_NEEDS_SEAL })
  if (path === `${USE_SOURCES_PATH}/unlock/begin`) {
    if (method !== 'POST') return wrongMethod()
    const answer = await service.unlockBegin(workspaceId, service.whoIs(credential))
    return answer.ok ? respondJson(response, 200, answer.value) : respondJson(response, answer.status, { ok: false, error: answer.error })
  }
  if (path === `${USE_SOURCES_PATH}/unlock`) {
    if (method !== 'POST') return wrongMethod()
    const body = await readJson<{ sealed?: unknown } | null>(request).catch(() => null)
    const answer = await service.unlock(workspaceId, body?.sealed, service.whoIs(credential))
    return answer.ok ? respondJson(response, 200, answer.value) : respondJson(response, answer.status, { ok: false, error: answer.error })
  }
  respondJson(response, 404, { ok: false, error: 'Not found' })
}
