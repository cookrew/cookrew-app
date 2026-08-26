import { randomUUID } from 'node:crypto'
import { validateCallPrompt } from './call-prompt'
import { safeCallReply } from './call-reply'
import type { ServedTemplate } from './session-served'
import type { ServedCallers } from './served-callers'

/**
 * THE SERVED CREW's public face and gate, over HTTP — the caller side of
 * share-on-save. Mounted at a served slug (a slug no live workspace holds),
 * these are the only routes a stranger meets:
 *
 *   GET  /crew                → the public face (name, door, price, version)
 *   POST /api/call/challenge  → a nonce (sign-in starts here; discloses nothing)
 *   POST /api/call/assert     → sign in / sign UP (TOFU) → Bearer token
 *   POST /ask                 → the product: 401/403/402 → mint or reuse → the
 *                               conductor answers. 402 fires only at session
 *                               START (per-session price), so R5 holds — no
 *                               conversation is ever interrupted for money.
 *
 * PURE OVER ITS DEPS. No http types here: the mobile-server adapter feeds
 * (method, path, headers, body) and writes the returned descriptor, so every
 * branch is testable without a socket. The dev facilitator settles X-Payment in
 * M1 (no chain); its refuse/unverifiable prefixes drive the two error voices.
 */

export interface ServedResponse {
  status: number
  headers?: Record<string, string>
  body: unknown
}

export interface CrewFace {
  name: string
  /** The identity the sign-in payload binds to. Public — it IS the address. */
  serviceId: string
  slug: string
  version: number
  access: 'account' | 'paid'
  priceUsd?: string
  /** The door — the orch's display name. The roster behind it is never listed. */
  door: string
  agents: number
}

export type Settle = 'ok' | 'refused' | 'unverifiable'

export interface ServedEndpointDeps {
  issuer: {
    challenge(binding: string): string
    consumeChallenge(value: string, binding?: string): boolean
    mint(sub: string, scope: string): string
    verifyToken(token: string): { sub: string; workspace: string } | null
  }
  callers: ServedCallers
  admit(serviceId: string, sub: string): Promise<{ workspaceId: string; sessionId: string; created: boolean }>
  /** Does this account hold an OPEN session? Open = already paid for. */
  hasOpenSession(serviceId: string, sub: string): boolean
  conductorFor(sessionId: string): string | null
  /** Run the prompt against the conductor's terminal; resolves to raw output. */
  ask(conductorId: string, prompt: string): Promise<string>
  /** M1 dev facilitator. 'bad-…' refuses, 'iffy-…' is unverifiable, else ok. */
  settle(txRef: string, amountUsd: string): Settle
  crewFace(template: ServedTemplate): CrewFace
}

const json = (status: number, body: unknown, headers?: Record<string, string>): ServedResponse =>
  headers ? { status, headers, body } : { status, body }

/** The dev facilitator, importable so index and tests agree on the prefixes. */
export function devSettle(txRef: string): Settle {
  if (txRef.startsWith('bad-')) return 'refused'
  if (txRef.startsWith('iffy-')) return 'unverifiable'
  return txRef.length > 0 ? 'ok' : 'refused'
}

/**
 * Handle one request addressed at a served slug. Returns null for a path this
 * surface does not own (the caller 404s it); otherwise the full answer.
 */
export async function handleServedRoute(
  deps: ServedEndpointDeps,
  template: ServedTemplate,
  method: string,
  pathname: string,
  input: { headers: Record<string, string | undefined>; body: unknown }
): Promise<ServedResponse | null> {
  const { serviceId } = template

  if (method === 'GET' && pathname === '/crew') {
    // The public face — the ADD BY LINK preview. Free to read: it is exactly
    // what the owner chose to publish, and nothing else.
    return json(200, deps.crewFace(template))
  }

  if (method === 'POST' && pathname === '/api/call/challenge') {
    return json(200, { challenge: deps.issuer.challenge(serviceId) })
  }

  if (method === 'POST' && pathname === '/api/call/assert') {
    const result = deps.callers.assert(
      serviceId,
      (input.body ?? {}) as Record<string, unknown>,
      (value) => deps.issuer.consumeChallenge(value, serviceId)
    )
    // One 401 for every failure — which half of a forgery was wrong is not
    // something a stranger gets to learn (the ceremony's own rule).
    if (!result.ok) return json(401, {})
    return json(200, { ok: true, token: deps.issuer.mint(result.sub, serviceId) })
  }

  if (method === 'POST' && pathname === '/ask') {
    return askRoute(deps, template, input)
  }

  return null
}

async function askRoute(
  deps: ServedEndpointDeps,
  template: ServedTemplate,
  input: { headers: Record<string, string | undefined>; body: unknown }
): Promise<ServedResponse> {
  const { serviceId } = template

  // ── identity ──
  const auth = input.headers['authorization'] ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  const claims = token === null ? null : deps.issuer.verifyToken(token)
  if (claims === null) {
    // Absence and forgery are one answer; the header names the ceremony.
    return json(401, {}, {
      'www-authenticate': `Cookrew realm="${template.slug}", challenge=${deps.issuer.challenge(serviceId)}`
    })
  }
  // A genuine token for another service is 403, never 401 — re-authenticating
  // with the same key cannot fix a scope, and a client must not loop.
  if (claims.workspace !== serviceId) return json(403, { reason: 'workspace' })

  // ── the 402, at session START only ──
  if (template.access === 'paid' && !deps.hasOpenSession(serviceId, claims.sub)) {
    const payment = input.headers['x-payment']
    if (payment === undefined || payment.length === 0) {
      return json(402, {
        terms: {
          amount: template.priceUsd,
          asset: 'USDC',
          chain: 'dev',
          payTo: `@${template.slug}`,
          nonce: randomUUID(),
          expiry: Date.now() + 5 * 60 * 1000
        }
      })
    }
    const settled = deps.settle(payment, template.priceUsd ?? '')
    if (settled === 'refused') {
      // The accusation voice: the payment is at fault, nothing was charged here.
      return json(402, { reason: 'invalid', retryable: false })
    }
    if (settled === 'unverifiable') {
      // The apology voice: WE could not check; retrying will not double-charge.
      return json(402, { reason: 'unverifiable', retryable: true })
    }
  }

  // ── the prompt, refused not stripped ──
  const body = (input.body ?? {}) as Record<string, unknown>
  const verdict = validateCallPrompt(body.prompt)
  if (!verdict.ok) return json(400, { error: verdict.reason })

  // ── mint or reuse, then the one door ──
  const { sessionId, created } = await deps.admit(serviceId, claims.sub)
  const conductorId = deps.conductorFor(sessionId)
  if (conductorId === null) {
    // A minted session with no door is our failure, not the caller's.
    return json(503, { error: 'the crew is not answering — try again shortly' })
  }
  const raw = await deps.ask(conductorId, verdict.text)
  // A reply leaves as TEXT: this lands in someone else's terminal, and pty
  // bytes are a command language (the outbound-injection rule).
  const reply = safeCallReply(raw)
  return json(200, { reply: reply.text, sessionId, created })
}
