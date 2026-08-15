// The live v4 §4 gate: one order, one manifest, deny-by-default.
//
// Piye's two pure modules decide (classifyRoute says WHAT the route is,
// gateDecision says whether this consumer may have it). This module is the
// wiring they were written for: it turns a real request into their inputs —
// which credential was presented, which route this path is, which workspace or
// agent it names — and hands back one verdict that both doors use.
//
// BOTH doors, deliberately. The HTTP choke point and the WebSocket upgrade run
// the same function over the same manifest, because a gate that only covers the
// door people remember is how the browser stream ended up admitting anyone who
// asked (Sol F2 of the v2 review). An upgrade is a GET; the manifest classifies
// it like one.
//
// WHAT CHANGED, in one line: /api/* used to be write-gated — any GET was open
// to anyone on the LAN. Now every /api/* route requires a known credential, and
// only /api/auth/status plus the static bootstrap stay public.

import type http from 'node:http'
import { gateDecision, type GateConsumer, type GateTarget } from '../shared/gate'
import { classifyRoute } from '../shared/route-manifest'
import { pairingAuthorized } from './mobile-http'
import {
  PHONE_CONSUMER_NAME,
  WALL_CONSUMER_NAME,
  consumerRow
} from './consumers'

/**
 * The credentials this process honours. Two tokens today; the consumers table
 * only ever REFINES the rows they resolve to, because minting a third token is
 * wave 5 and a row nobody can present is inert.
 */
export interface AuthTokens {
  /** Absent = the in-process embedder escape: no gate at all (loopback only). */
  pairingToken?: string
  wallToken?: string
  /** Parsed ~/.cookrew/consumers.json rows, keyed by consumer name. */
  consumers?: Readonly<Record<string, GateConsumer>>
}

export interface IdentifiedConsumer {
  name: string
  consumer: GateConsumer
}

export interface GateVerdict {
  status: 200 | 401 | 403 | 429 | 402
  reason: string
  /** Who we decided the caller is; null when the credential was not known. */
  consumer: string | null
}

/**
 * Which credential is this, if any?
 *
 * Compared constant-time by pairingAuthorized, and the token may ride a bearer
 * header or `?token=`: EventSource and WebSocket cannot set headers, and §4
 * sanctions query tokens exactly there ("one-shot bootstrap/stream tickets").
 */
export function identifyConsumer(
  request: Pick<http.IncomingMessage, 'headers'>,
  url: URL,
  tokens: AuthTokens
): IdentifiedConsumer | null {
  if (tokens.pairingToken && pairingAuthorized(request, url, tokens.pairingToken)) {
    return { name: PHONE_CONSUMER_NAME, consumer: consumerRow(PHONE_CONSUMER_NAME, tokens.consumers) }
  }
  if (tokens.wallToken && pairingAuthorized(request, url, tokens.wallToken)) {
    return { name: WALL_CONSUMER_NAME, consumer: consumerRow(WALL_CONSUMER_NAME, tokens.consumers) }
  }
  return null
}

/**
 * The workspace or agent a path names, for the scope step of the order.
 *
 * Only the shapes the manifest already spells out, and only the id — no lookup,
 * no existence check. Existence must NOT leak through the gate (step 1 is
 * authenticate, precisely so a 401 answers before anything is resolved), and a
 * scope test needs the name, not the object.
 */
export function routeTarget(path: string): GateTarget {
  const clean = path.split('?')[0]
  const workspace = /^\/api\/workspaces\/([^/]+)(?:\/|$)/.exec(clean)?.[1]
  const agent =
    /^\/api\/agents\/([^/]+)(?:\/|$)/.exec(clean)?.[1] ??
    /^\/api\/terminal\/([^/]+)(?:\/|$)/.exec(clean)?.[1]
  const decode = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return {
    ...(workspace !== undefined && workspace !== 'switch' && workspace !== 'rename'
      ? { workspace: decode(workspace) }
      : {}),
    ...(agent !== undefined ? { agent: decode(agent) } : {})
  }
}

/** One request, one verdict — the same call for an HTTP route and an upgrade. */
export function gateRequest(input: {
  method: string
  url: URL
  request: Pick<http.IncomingMessage, 'headers'>
  tokens: AuthTokens
}): GateVerdict {
  const identified = identifyConsumer(input.request, input.url, input.tokens)
  const decision = gateDecision({
    consumer: identified?.consumer ?? null,
    route: classifyRoute(input.method, input.url.pathname),
    target: routeTarget(input.url.pathname)
  })
  return { ...decision, consumer: identified?.name ?? null }
}

/**
 * What the caller is told. Enough to act on (re-pair, or stop retrying), never
 * enough to map the surface: a 403 says "outside your token", not which route
 * would have worked.
 */
export function gateMessage(verdict: GateVerdict): string {
  if (verdict.status === 401) {
    return 'Unauthorized — open the pairing URL shown on the desktop (it carries ?token=).'
  }
  if (verdict.consumer === WALL_CONSUMER_NAME) {
    // The 401→403 migration (Sol F9): the wall's token is KNOWN, so re-pairing
    // is not the fix and 401 was the wrong answer. The phrase "read-only" is
    // load-bearing — the renderer reads it to tell a scope refusal from an
    // unpaired device.
    return 'Forbidden — this token is read-only.'
  }
  if (verdict.reason === 'unclassified-route') return 'Forbidden — unknown route.'
  return "Forbidden — this route is outside your token's scope."
}

/**
 * Does this path go through the gate at all?
 *
 * The API surface does; the static bootstrap (index.html, hashed assets, the
 * dev module graph) does not — it is the client that goes on to authenticate,
 * and gating it would leave a phone with a blank page and no way to pair.
 */
export function gatedPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/')
}
