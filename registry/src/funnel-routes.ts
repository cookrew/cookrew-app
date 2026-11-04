import type { IncomingMessage, ServerResponse } from 'node:http'
import { FUNNEL_ROUTE, readFunnelPayload } from '../../src/shared/funnel-events'
import { funnelLimiterKey, type FunnelCounts } from './funnel-counts'
import { json, readJsonBody, type BodyResult } from './http'
import { Limiter, callerAddress } from './v2-limiter'
import { signedIn, type V2Identity } from './v2-http'

/**
 * POST /v1/funnel — one install's one event. Open, because an install has no
 * account to sign with, and that is what the rest of this file makes safe: the
 * allowlist is strict, the limiter holds no address, the answer echoes nothing.
 * JSON only, so a web page cannot spend its visitors with a simple form post.
 *
 * GET /v1/funnel — the totals, for one account. The registry has no site-wide
 * owner role, so the check is a real v2 sign-in naming the account this
 * deployment was started with (`--funnel-owner`). With none configured the
 * route does not exist.
 */

/** Five short fields. Anything near this size is not a funnel event. */
const BODY_LIMIT = 512
const PER_MINUTE = 120
/** Five short fields arrive at once. The server has no request timeout: the relay needs that. */
const BODY_DEADLINE_MS = 10_000

export interface FunnelMount {
  readonly counts: FunnelCounts
  /** The one account that may read the totals; empty closes the route. */
  readonly owner: string
  readonly perMinute?: number
  /**
   * The hops in front of this process whose X-Forwarded-For may be believed.
   * Without them every install behind a proxy shares one budget, so one noisy
   * client spends everyone's. Named here rather than on v2 so that turning this
   * on moves no sign-in limiter.
   */
  readonly trustedProxies?: readonly string[]
  readonly bodyMs?: number
}

const PRIVATE = { 'cache-control': 'private, no-store', vary: 'cookie, authorization' }

export interface FunnelRoute {
  readonly handle: (request: IncomingMessage, response: ServerResponse, pathname: string) => boolean
}

const readWithin = async (request: IncomingMessage, ms: number): Promise<BodyResult> => {
  const deadline = setTimeout(() => request.destroy(new Error('body deadline')), ms)
  try {
    return await readJsonBody(request, BODY_LIMIT)
  } finally {
    clearTimeout(deadline)
  }
}

export function createFunnelRoute(mount: FunnelMount, v2: V2Identity | undefined): FunnelRoute {
  const limiter = new Limiter(mount.perMinute ?? PER_MINUTE)

  const take = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const address = callerAddress(request.headers, request.socket.remoteAddress, mount.trustedProxies ?? [])
    if (!limiter.take(funnelLimiterKey(address))) return json(response, 429, { error: 'rate_limited' })
    if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
      return json(response, 415, { error: 'unsupported_media_type' })
    }
    const body = await readWithin(request, mount.bodyMs ?? BODY_DEADLINE_MS)
    if (!body.ok) return json(response, body.reason === 'too_large' ? 413 : 400, { error: body.reason })
    const payload = readFunnelPayload(body.value)
    if (payload === null || !mount.counts.acceptsDay(payload.day)) return json(response, 400, { error: 'bad_event' })
    mount.counts.add(payload)
    response.writeHead(204)
    response.end()
  }

  const read = (request: IncomingMessage, response: ServerResponse): void => {
    if (v2 === undefined || mount.owner === '') return json(response, 404, { error: 'not_found' })
    const signed = signedIn(request, v2)
    if (signed === null) return json(response, 401, { error: 'not_signed_in' }, PRIVATE)
    if (signed.account.username !== mount.owner) return json(response, 403, { error: 'not_owner' }, PRIVATE)
    json(response, 200, mount.counts.totals(), PRIVATE)
  }

  return {
    handle: (request, response, pathname) => {
      if (pathname !== FUNNEL_ROUTE) return false
      if (request.method === 'POST') {
        void take(request, response).catch(() => json(response, 500, { error: 'failed' }))
        return true
      }
      if (request.method === 'GET') {
        read(request, response)
        return true
      }
      json(response, 405, { error: 'method_not_allowed' })
      return true
    }
  }
}
