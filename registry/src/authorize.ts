import type { IncomingMessage } from 'node:http'
import { decideGate } from '../../src/shared/gate'
import type { RegistryStore } from './store'
import type { IdentityService, TokenClaims } from './identity'
import type { Verdict } from './server'

/**
 * THE DOWNLOAD BINDING (P2-A2) — the registry's half of the one gate.
 *
 * The decision itself moved to src/shared/gate.ts in S1 of the ④ lane, because
 * the live-call gate (§9) runs in the owner's app against a different issuer,
 * and "one protocol, two resources" is only true if there is one
 * implementation. What is left here is the binding: which store answers "does
 * it exist", which service verifies a credential, and what this resource
 * requires of a token. The order — exists? → public? → identity? →
 * entitlement? → [M2: priced?] → serve — lives there and is shared.
 *
 * The signature is unchanged on purpose. `makeAuthorize(store, identity)` is
 * what registry/src/main.ts and the A2/A3 suites already call, and those tests
 * passing untouched is the proof that the extraction changed nothing.
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
    const verdict = decideGate<TokenClaims>({
      visibility: store.visibilityOf(presetId),
      credential: bearer(request),
      issuer: identity,
      // D4 / R9: authenticated but the token does not cover this. 403, NEVER
      // 401 — a 401 tells the client its identity is the problem, so it
      // re-authenticates, presents the same token and loops.
      //
      // R26: `scope`, not a stand-in. The reason names what is actually wrong,
      // and it is the one 403 a client can resolve on its own — so naming it
      // precisely is what lets the client re-ceremony instead of surfacing.
      covers: (claims) => (claims.scope === 'download' ? null : 'scope'),
      // M1 has no entitlement service: a verified identity is entitled to every
      // identified preset. A3 puts the real check HERE, and M2's 402 goes below
      // it in the shared decision — this line is the seam, not a placeholder.
      entitled: () => null
    })
    // The registry's wire type carries no subject: its 200 is a manifest, and
    // who asked for it is the transparency log's business, not the response's.
    return verdict.code === 200 ? { code: 200 } : verdict
  }
}
