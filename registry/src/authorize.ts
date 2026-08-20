import type { IncomingMessage } from 'node:http'
import type { RegistryStore } from './store'
import type { IdentityService } from './identity'
import type { Verdict } from './server'

/**
 * THE DECISION FUNCTION (P2-A2) — the only place an answer is chosen.
 *
 * The order is fixed and each step answers before the next runs:
 *
 *   exists? → public? → identity? → entitlement? → [M2: priced?] → serve
 *
 * M2 inserts 402 between entitlement and serve, reads `X-Payment` when present,
 * and lets the client retry the same idempotent GET. Nothing above it moves.
 */

function bearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token.length > 0 ? token : null
}

export function makeAuthorize(
  store: RegistryStore,
  identity: IdentityService
): (presetId: string, request: IncomingMessage) => Verdict {
  return (presetId, request) => {
    const visibility = store.visibilityOf(presetId)
    if (visibility === null) return { code: 404 }
    // A public preset never sees the gate. Discovery and free download are not
    // things identity should cost (A2).
    if (visibility === 'public') return { code: 200 }

    const token = bearer(request)
    if (token === null) {
      // No credential offered: ask for one. The challenge rides in the header
      // the spec names, so a client reads one place for "what next".
      return { code: 401, challenge: identity.challenge() }
    }

    const claims = identity.verifyToken(token)
    if (claims === null) {
      // Malformed, mis-signed and EXPIRED are one answer on purpose. They are
      // all "your credential is not currently good", the remedy is identical,
      // and distinguishing them would tell an attacker which half of a forgery
      // was wrong.
      return { code: 401, challenge: identity.challenge() }
    }

    // D4 / R9: authenticated but the token does not cover this. 403, NEVER 401.
    // A 401 tells the client its identity is the problem, so it re-authenticates,
    // presents the same token and loops. 401 means prove who you are; 403 means
    // you did, and it is still no — a client may retry the first and must never
    // retry the second.
    if (claims.scope !== 'download') return { code: 403, reason: 'version_gate' }

    // M1 has no entitlement service: a verified identity is entitled to every
    // identified preset. A3 puts the real check HERE, and M2's 402 goes below
    // it — this line is the seam, not a placeholder for one.
    return { code: 200 }
  }
}
