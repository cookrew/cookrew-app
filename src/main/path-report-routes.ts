import type http from 'node:http'
import { readJson, respondJson } from './mobile-http'
import { pathReports, type PathReportDevice, type PathReportStore } from './path-reports'
import { PATH_REPORTS_ROUTE, PATH_REPORT_ROUTE } from '../shared/path-report'

/**
 * TWO ROUTES SO THE OWNER STOPS PHOTOGRAPHING A PHONE SCREEN.
 *
 * The companion's "why this path" panel showed four LAN candidates saying "no
 * answer" and a 13,328 ms relay round trip, and the only way anyone else could
 * look at it was a picture of a phone. POST puts each race where the desktop
 * can hold it; GET hands the last few back to a `curl` at the Mac.
 *
 * THEY ARE GATED BY BEING HERE, and that is deliberate rather than incidental.
 * mobile-server.ts calls this BELOW its delegation to handleMobileApi, which is
 * the one choke point where credentials are checked: a non-GET without the
 * pairing (or an admitted phone's own) token is already refused 401 there, and
 * a GET under /api/ without at least the read-only token likewise. Adding a
 * second copy of that check here would be a second thing to keep in step —
 * that is exactly the reasoning that put /api/reach and /api/account below the
 * same line. See the comments around them.
 *
 * THE DEVICE IS THE BRIDGE'S TO NAME, NEVER THE BODY'S. `x-cookrew-device` is
 * stripped off every request and re-set only by the relay (relay-device.ts), so
 * a report over the relay is filed under the phone the registry named and a
 * report over a direct plane is filed as unnamed. A body that could name its
 * own device would let any admitted phone write rows into another's history.
 */

/** Small on purpose: a race with twelve candidates is a few hundred bytes. */
const REPORT_BODY_LIMIT = 16 * 1024

export interface PathReportRouteDeps {
  /** The device the BRIDGE named, or null on a direct plane. */
  readonly device: PathReportDevice
  /** Injected for tests; the process's own store otherwise. */
  readonly store?: PathReportStore
}

/**
 * Answer the two path-report routes. False means this was not one of them.
 *
 * Never throws: a malformed body is a 400 and a store that refuses is a 400,
 * because a phone posting a diagnostic must not be able to take down the
 * server it is diagnosing.
 */
export const handlePathReportRoutes = async (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  deps: PathReportRouteDeps
): Promise<boolean> => {
  const store = deps.store ?? pathReports()
  const method = request.method ?? 'GET'

  if (method === 'POST' && url.pathname === PATH_REPORT_ROUTE) {
    const body = await readJson<unknown>(request, REPORT_BODY_LIMIT).catch(() => null)
    const kept = store.record(deps.device, body)
    if (!kept) {
      respondJson(response, 400, { error: 'that was not a path report' })
      return true
    }
    // 204 with no echo: the phone knows what it sent, and an echo would be a
    // second copy of a diagnostic travelling back over the path in question.
    respondJson(response, 204, {})
    return true
  }

  if (method === 'GET' && url.pathname === PATH_REPORTS_ROUTE) {
    const reports = store.list()
    respondJson(response, 200, { reports, count: reports.length })
    return true
  }

  return false
}
