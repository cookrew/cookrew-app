import type http from 'node:http'
import { readJson, respondJson } from './mobile-http'
import { pathReports, type PathReportDevice, type PathReportStore } from './path-reports'
import { sealedV2Of } from './seal-proof'
import { PATH_REPORTS_ROUTE, PATH_REPORT_ROUTE } from '../shared/path-report'

/**
 * TWO ROUTES SO THE OWNER STOPS PHOTOGRAPHING A PHONE SCREEN.
 *
 * The companion's "why this path" panel showed four LAN candidates saying "no
 * answer" and a 13,328 ms relay round trip, and the only way anyone else could
 * look at it was a picture of a phone. POST puts each race where the desktop
 * can hold it; GET hands the last few back to the owner.
 *
 * THEY ARE GATED BY BEING HERE, and that is deliberate rather than incidental.
 * mobile-server.ts calls this BELOW its delegation to handleMobileApi, which is
 * the one choke point where credentials are checked: a non-GET without the
 * pairing (or an admitted phone's own) token is already refused 401 there, and
 * a GET under /api/ without at least the read-only token likewise.
 *
 * AND ONLY INSIDE COOKREW-SEAL/2 (security review, 2026-11-19). A report names
 * the Mac's LAN and tailnet addresses (`link.via`, the candidates' address
 * forms) and carries the browser's own words, which may spell one any way at
 * all. Being past the gate says who asked, not how the request travelled, and
 * no pattern over free text can promise an address is gone, so nothing is
 * redacted: the road is asked instead.
 *
 *   POST is filed only from a v2 seal's inner request (seal-proof.ts ·
 *   sealedV2Of) with owner pairing. Anything else is 403 before the body is read.
 *
 *   GET is answered only on a v2 seal AND to the owner's pairing (never the
 *   read-only wall token). Anything else is 403, whatever is already held.
 *
 * Not on a loopback curl either: a request with no relay marker is not proof
 * it never left the Mac, so the only road that counts is the one whose proof
 * nothing outside this process can write.
 *
 * INCOMPATIBLE ON PURPOSE with an older console, which POSTs plain: its
 * reports are refused, as its unsealed RTC offer is (mobile-api.ts).
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
  /**
   * The presented credential is the owner's (pairing or an admitted phone's
   * own), not the read-only wall token. Absent, it is not: no read.
   */
  readonly owner?: boolean
}

const SEALED_ONLY = { error: 'sealed session required' }

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
    if (!sealedV2Of(request)) {
      respondJson(response, 403, SEALED_ONLY)
      return true
    }
    if (deps.owner !== true) {
      respondJson(response, 403, { error: 'owner pairing required' })
      return true
    }
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
    if (!sealedV2Of(request)) {
      respondJson(response, 403, SEALED_ONLY)
      return true
    }
    if (deps.owner !== true) {
      respondJson(response, 403, { error: 'owner pairing required' })
      return true
    }
    const reports = store.list()
    respondJson(response, 200, { reports, count: reports.length })
    return true
  }

  return false
}
