import { createPublicKey, verify } from 'node:crypto'
import { callAssertionPayload } from './call-ceremony'

/**
 * WHO HAS SIGNED IN to a served crew — the M1 "account", per service.
 *
 * R31's real accounts service is M3. Until it exists, a caller's account at a
 * served crew is an ed25519 key they present ON FIRST SIGN-IN — TOFU, exactly
 * the sign-up the deck already promises: "No account yet? Signing in makes one
 * — it takes the same tap." A known sub can never re-key here (the same rule
 * AgentExportStore enrolment holds): a rotated or stolen name must not silently
 * replace the key that owns the sessions.
 *
 * PER SERVICE, not per app: 'ana' at research-crew and 'ana' at triage are two
 * strangers unless they present the same key, because a service must not leak
 * who exists at another.
 */
export interface ServedAssertInput {
  sub: string
  challenge: string
  /** base64url ed25519 over `callAssertionPayload(serviceId, sub, challenge)`. */
  signature: string
  /** The public key — REQUIRED on first sign-in (that is the sign-up), ignored after. */
  jwk?: Record<string, unknown>
}

export type ServedAssertFailure = 'malformed' | 'unknown_challenge' | 'bad_signature' | 'no_key'

export class ServedCallers {
  /** serviceId → sub → jwk. In-memory M1; persistence rides the accounts work. */
  private readonly byService = new Map<string, Map<string, Record<string, unknown>>>()

  keyOf(serviceId: string, sub: string): Record<string, unknown> | null {
    return this.byService.get(serviceId)?.get(sub) ?? null
  }

  /**
   * Verify a sign-in, TOFU-enrolling an unknown sub's presented key. The nonce
   * is spent FIRST, whatever happens after — a nonce that survives a failed
   * attempt is a nonce an attacker keeps trying signatures against.
   */
  assert(
    serviceId: string,
    input: Partial<ServedAssertInput>,
    consumeChallenge: (value: string) => boolean
  ): { ok: true; sub: string } | { ok: false; reason: ServedAssertFailure } {
    if (
      typeof input?.sub !== 'string' ||
      input.sub.length === 0 ||
      typeof input.challenge !== 'string' ||
      typeof input.signature !== 'string'
    ) {
      return { ok: false, reason: 'malformed' }
    }
    if (!consumeChallenge(input.challenge)) return { ok: false, reason: 'unknown_challenge' }

    const known = this.keyOf(serviceId, input.sub)
    // A known sub verifies against the STORED key only — a presented jwk cannot
    // re-key an existing account (that would be the takeover TOFU forbids).
    const jwk = known ?? input.jwk ?? null
    if (jwk === null) return { ok: false, reason: 'no_key' }

    const payload = Buffer.from(callAssertionPayload(serviceId, input.sub, input.challenge), 'utf8')
    let good = false
    try {
      good = verify(
        null,
        payload,
        createPublicKey({ key: jwk as never, format: 'jwk' }),
        Buffer.from(input.signature, 'base64url')
      )
    } catch {
      good = false
    }
    if (!good) return { ok: false, reason: 'bad_signature' }

    if (known === null) {
      // First sight, proven possession: this IS the sign-up.
      const service = this.byService.get(serviceId) ?? new Map()
      service.set(input.sub, { ...(input.jwk as Record<string, unknown>) })
      this.byService.set(serviceId, service)
    }
    return { ok: true, sub: input.sub }
  }
}
