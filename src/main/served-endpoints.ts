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
  /**
   * May this service mint ANOTHER session under the owner's grant (R30 G2)?
   *
   * The owner's budget, not the caller's payment — a paid door and a lent key
   * bound two different people's spending, and collapsing them would let a
   * caller buy their way past a limit the owner set on their own credential.
   * True when nothing was lent: a crew that needs no key has no budget to
   * exceed.
   */
  grantBudget: { allowsNewSession(serviceId: string): boolean }
  /**
   * The payment rail, behind a seam the gate never sees through.
   *
   * ASYNC because a real rail is: verifying money has moved means asking
   * something outside this process. The three answers are all this surface
   * knows, and they are about FAULT, not mechanism — see x402-rail.ts.
   */
  settle(payment: string, amountUsd: string): Promise<Settle>
  /**
   * The 402 body: what this crew costs, in whatever shape the rail speaks.
   *
   * Also behind the seam. The quote used to be built here with `chain: 'dev'`
   * baked in, which meant the gate DID know the rail — swapping x402 for
   * anything else would have edited gate logic. Returns null when the price
   * cannot be quoted, which is a 503: our misconfiguration, not the caller's
   * problem, and admitting free would be worse.
   */
  paymentTerms(template: ServedTemplate): unknown | null
  crewFace(template: ServedTemplate): CrewFace
}

const json = (status: number, body: unknown, headers?: Record<string, string>): ServedResponse =>
  headers ? { status, headers, body } : { status, body }

/*
 * devSettle USED TO LIVE HERE, and it is deliberately gone rather than merely
 * unwired: it admitted any string starting 'tx-', so anything that could reach
 * the gate could buy a crew with a word. Leaving it exported would leave that
 * one line — `settle: devSettle` — available to anyone wiring this surface in a
 * hurry, and the failure would be silent and free.
 *
 * The real rail is x402-rail.ts. Tests supply their own stub against the
 * `settle` seam, which is what a seam is for.
 */

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

  // ── the owner's grant budget — BEFORE the money, deliberately ──
  //
  // A crew that cannot mint must not quote and must not settle. Checking this
  // after the 402 reads fine and takes a caller's payment for a session that
  // was never going to exist; the order is the whole correctness of it.
  //
  // Only a MINT spends the grant, so only a mint is bounded: a caller with an
  // open session is asking their existing crew a second question, and cutting
  // them off would end a conversation over a limit their message did not move.
  if (
    !deps.hasOpenSession(serviceId, claims.sub) &&
    !deps.grantBudget.allowsNewSession(serviceId)
  ) {
    // 429, not 503: nothing is broken. The owner lent this crew a fixed number
    // of sessions and they are gone — a limit a caller can understand and an
    // owner can raise, so it is named rather than hidden behind "try again
    // shortly", which would be a lie about a wait that never ends.
    return json(429, {
      reason: 'budget',
      error: 'this crew has used up what its owner lent it — ask them to raise it'
    })
  }

  // ── the 402, at session START only ──
  if (template.access === 'paid' && !deps.hasOpenSession(serviceId, claims.sub)) {
    const payment = input.headers['x-payment']
    if (payment === undefined || payment.length === 0) {
      const terms = deps.paymentTerms(template)
      // A crew we cannot price is not a crew a stranger may use for free.
      if (terms === null) {
        return json(503, { error: 'this crew is not taking payment right now' })
      }
      return json(402, { terms })
    }
    const settled = await deps.settle(payment, template.priceUsd ?? '')
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
