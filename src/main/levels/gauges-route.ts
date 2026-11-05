// GET /api/levels/gauges: this desktop's machine gauges, for the phone
// (shared/machine-gauges.ts). Called from handleLevelsRoutes, so it stands
// below the companion's /api gate like the rest of the levels.
//
// THE OWNER'S, AND ONLY THE OWNER'S. How loaded this Mac is says what the owner
// is doing, so the read-only wall token does not open it, and neither does
// anything a served session holds: a door bearer is no pairing credential, the
// path is not on the relay's door list (relay-frame.ts · DOOR_PATHS), a slug
// opens nothing (it is in SCOPE_AWARE for the owner's own phone, and the token
// is still asked for here), and a sandbox can neither read the pairing token
// (owner-secrets.ts) nor get anything for being on loopback.
// tests/zoom-gauges-route.test.ts drives each of those through
// `handle`. Refused means refused BEFORE sampling: a stranger's knock must not
// fork a child on the owner's machine.
//
// A QUESTION, NOT A STREAM. The phone asks every few seconds while it is at the
// devices stop. A stream would hold one of the relay's sixteen exchanges for as
// long as the page lies open, and would need a release that a phone going to
// sleep never sends.

import type http from 'node:http'
import { respondJson } from '../mobile-http'
import { sharedGaugeWatch, type GaugeReader } from '../machine-gauges'

const GAUGES_PATH = /^\/api\/levels\/gauges\/?$/

export interface GaugeRouteDeps {
  paired: (request: http.IncomingMessage, url: URL) => boolean
  gauges?: GaugeReader
}

async function answer(response: http.ServerResponse, gauges: GaugeReader): Promise<void> {
  try {
    const reading = await gauges.read()
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(reading))
  } catch (error) {
    console.error('Gauges route failed:', error)
    if (!response.headersSent) respondJson(response, 503, { error: 'gauges not readable' })
  }
}

/** True when the request was the gauges route and is being answered. */
export function handleGaugeRoute(request: http.IncomingMessage, response: http.ServerResponse, url: URL, deps: GaugeRouteDeps): boolean {
  if (!GAUGES_PATH.test(url.pathname)) return false
  if (request.method !== 'GET') respondJson(response, 405, { error: 'GET only' })
  else if (!deps.paired(request, url)) respondJson(response, 401, { error: 'Unauthorized — the gauges need this desktop’s pairing token.' })
  else void answer(response, deps.gauges ?? sharedGaugeWatch())
  return true
}
