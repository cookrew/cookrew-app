import type http from 'node:http'
import { ROUTE_HTTP_SCHEMA_VERSION, ROUTE_ID_RE, routeSchemaQuery } from '../../shared/route'
import { sendBody } from '../http-compress'
import { readJson } from '../mobile-http'
import { sealedV2Of } from '../seal-proof'
import { routeHttpView } from './http-view'
import type { RouteService } from './service'

type RouteHttpService = Pick<RouteService, 'state' | 'setDefault' | 'setSharedMcp'> & {
  endpointInventory?: () => string[] | null
}

/** A URL, or a host/address with a numeric port: never a model id written as `provider/model`. */
const ENDPOINT_SHAPED = /^(?:[a-z][a-z0-9+.-]*:\/\/|(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):\d{1,5}(?:[/?#]|$))/i

/**
 * A client too old to read this projection. It is refused, not given a shape
 * it does not understand: an old renderer would silently ignore `withheld`
 * and `remoteRisks`, which is exactly the HIGH this closed. The upgrade
 * explanation belongs where that client can reach it (the host's own note),
 * never in the body of a refusal it will not render.
 */
export const ROUTE_NEEDS_UPDATE = 'Update Cookrew on this device to use Routing.'

/**
 * Does this URL's query name a schema at least ROUTE_HTTP_SCHEMA_VERSION?
 *
 * Takes the SEARCH STRING, not the request: the stream path already has the
 * parsed URL (with its seat slug stripped), and a second parse of `request.url`
 * let the two disagree — an embedder that supplies one and not the other was
 * silently classed as an old client.
 */
export function routeCapable(search: string): boolean {
  const claimed = routeSchemaQuery(search)
  return claimed !== null && claimed >= ROUTE_HTTP_SCHEMA_VERSION
}

function endpointShaped(value: string): boolean {
  if (ENDPOINT_SHAPED.test(value)) return true
  if (!URL.canParse(value)) return false
  return ['http:', 'https:', 'ws:', 'wss:'].includes(new URL(value).protocol)
}

export function mayReadRouteDiagnostics(request: http.IncomingMessage, ownerPairingNow: () => boolean): boolean {
  return sealedV2Of(request) && ownerPairingNow()
}

function respondRouteJson(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  // The representation can change with pairing or transport on the same URL.
  // Never let a 304 reuse a previously authorized snapshot.
  sendBody(response, status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
    Buffer.from(JSON.stringify(body)), response.req?.headers['accept-encoding'])
}

export async function handleRouteHttp(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  route: RouteHttpService,
  action: 'read' | 'default' | 'shared-mcp',
  ownerPairingNow: () => boolean,
  pairingRequired: boolean,
  /** The URL the caller already parsed (mobile-api). Absent: this request's own. */
  search = new URL(request.url ?? '/', 'http://request.invalid').search
): Promise<void> {
  // Client-first (owner 2026-11-22): an old client is refused the route, both
  // reads and writes, before anything is read out of it. 426 requires an
  // Upgrade header (RFC 7231 §6.5.15); the value names what to move to.
  if (!routeCapable(search)) {
    return respondRouteJson(response, 426, { error: ROUTE_NEEDS_UPDATE }, {
      upgrade: `cookrew-route-schema/${ROUTE_HTTP_SCHEMA_VERSION}`
    })
  }
  const fullView = () => mayReadRouteDiagnostics(request, ownerPairingNow)
  let update = () => route.state()
  if (action !== 'read') {
    const body = await readJson<{ model?: unknown; on?: unknown } | null>(request).catch(() => null)
    if (response.destroyed) return
    if (pairingRequired && !ownerPairingNow()) {
      return respondRouteJson(response, 401, { error: 'Unauthorized — pairing required.' })
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return respondRouteJson(response, 400, { ok: false, reason: 'Invalid route settings JSON.' })
    }
    if (action === 'default') {
      const { model } = body
      if (model !== null && (typeof model !== 'string' || (model !== '' && (!ROUTE_ID_RE.test(model) || endpointShaped(model))))) {
        return respondRouteJson(response, 400, { ok: false, reason: 'model must be a route id or null' })
      }
      update = () => route.setDefault(model === '' ? null : model)
    } else {
      const { on } = body
      if (typeof on !== 'boolean') return respondRouteJson(response, 400, { ok: false, reason: 'on must be a boolean' })
      update = () => route.setSharedMcp(on)
    }
  }
  try {
    const state = update()
    respondRouteJson(response, 200, routeHttpView(state, fullView(), route.endpointInventory))
  } catch (error) {
    const fallback = action === 'read' ? 'Route state could not be read.' : 'Route settings could not be saved.'
    respondRouteJson(response, 500, { error: fullView() && error instanceof Error ? error.message : fallback })
  }
}
