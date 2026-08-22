import { createPublicKey, verify } from 'node:crypto'
import type { CallIssuer } from './call-credential'

/**
 * THE CEREMONY (§9, ④ · S2) — how a caller turns a 401 into a credential.
 *
 * WHY THIS EXISTS IN THE SAME SLICE AS THE FIRST 401. A 401 is a promise that a
 * ceremony exists and this server can complete it. A1 refused to answer 401
 * before identity existed for exactly that reason — "a 401 invites a ceremony
 * the server can't complete, and lying in a status code is still lying" — and a
 * challenge nobody can spend is the same lie moved one file over. So the gate
 * emitting 401 and the route that answers it land together or neither lands.
 *
 * WHY A KEY AND NOT A PASSKEY. The caller here is a machine: §9's whole point
 * is that the caller's terminal sees an ordinary teammate, so the thing on the
 * other end is an agent or a CLI, not a human in front of an authenticator. A
 * WebAuthn ceremony requires user presence by design — it is the right
 * instrument for a person installing a preset and the wrong one for an agent
 * calling a teammate every few seconds. The caller proves possession of a key
 * the owner enrolled; the human passkey path joins it in M3 as a second issuer,
 * which the gate already supports because the issuer is a parameter.
 *
 * WHAT A CALLER PROVES: that it holds the private half of a key this owner
 * enrolled AT THIS WORKSPACE, right now, for a nonce this server issued moments
 * ago and has already spent. Not that it knows a secret — nothing here can be
 * replayed by someone who reads the disk, because the only thing stored is a
 * public key.
 */

/** Why a ceremony did not complete. For the log and the tests, never the wire. */
export type CeremonyFailure =
  | 'unknown_caller'
  | 'unknown_challenge'
  | 'bad_signature'
  | 'malformed'

export interface AssertInput {
  /** Who is asserting. Must already be enrolled at the addressed workspace. */
  sub: string
  /** The nonce from the 401, verbatim. */
  challenge: string
  /** base64url ed25519 signature over the SIGNED PAYLOAD below. */
  signature: string
}

export interface CallCeremonyDeps {
  issuer: CallIssuer
  /** The key this caller is enrolled with here, or null. Workspace-scoped. */
  enrolledKey: (workspaceId: string, sub: string) => Record<string, unknown> | null
}

/**
 * What the caller signs.
 *
 * The workspace is INSIDE the signed bytes as well as bound to the nonce. Two
 * independent reasons a signature cannot travel: the nonce is remembered
 * against the workspace that issued it, and the signature itself only verifies
 * against the workspace it was made for. Either alone would be enough; both
 * means a mistake in one is not a hole.
 */
export function callAssertionPayload(workspaceId: string, sub: string, challenge: string): string {
  return `cookrew-call/1\n${workspaceId}\n${sub}\n${challenge}`
}

export type AssertResult =
  | { ok: true; token: string }
  | { ok: false; reason: CeremonyFailure }

export interface CallCeremony {
  /** A nonce bound to this workspace, for a caller about to assert. */
  challenge: (workspaceId: string) => string
  assert: (workspaceId: string, input: AssertInput) => AssertResult
}

export function makeCallCeremony(deps: CallCeremonyDeps): CallCeremony {
  return {
    challenge: (workspaceId) => deps.issuer.challenge(workspaceId),

    assert: (workspaceId, input) => {
      if (
        typeof input?.sub !== 'string' ||
        typeof input?.challenge !== 'string' ||
        typeof input?.signature !== 'string' ||
        input.sub.length === 0
      ) {
        return { ok: false, reason: 'malformed' }
      }

      // SPENT FIRST, and spent whether or not anything below succeeds. A nonce
      // that survived a failed attempt is a nonce an attacker may keep trying
      // signatures against.
      if (!deps.issuer.consumeChallenge(input.challenge, workspaceId)) {
        return { ok: false, reason: 'unknown_challenge' }
      }

      const jwk = deps.enrolledKey(workspaceId, input.sub)
      if (jwk === null) return { ok: false, reason: 'unknown_caller' }

      const payload = Buffer.from(
        callAssertionPayload(workspaceId, input.sub, input.challenge),
        'utf8'
      )
      let good = false
      try {
        good = verify(
          null,
          payload,
          createPublicKey({ key: jwk as never, format: 'jwk' }),
          Buffer.from(input.signature, 'base64url')
        )
      } catch {
        // A malformed key or signature is a failed verification, not a crash.
        good = false
      }
      if (!good) return { ok: false, reason: 'bad_signature' }

      // The credential names this workspace and nothing else — see
      // call-credential.ts. The caller cannot ask for a broader one, because
      // the workspace here is the one it just proved itself against.
      return { ok: true, token: deps.issuer.mint(input.sub, workspaceId) }
    }
  }
}
