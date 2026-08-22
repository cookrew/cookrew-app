import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
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
  /**
   * Verify one signature. Injectable ONLY so a test can count the calls and
   * prove the unknown-caller path does the same work as the bad-signature one
   * — see the timing note below. Production always uses the default.
   */
  verifySignature?: (jwk: Record<string, unknown>, payload: Buffer, signature: Buffer) => boolean
}

/**
 * A key that is enrolled for nobody, used only to spend the same time.
 *
 * Generated once per process rather than per call, because generating one per
 * call would make the unknown-caller path SLOWER than the real one and simply
 * invert the oracle.
 */
let dummyKey: Record<string, unknown> | null = null
function dummyJwk(): Record<string, unknown> {
  if (dummyKey === null) {
    dummyKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<
      string,
      unknown
    >
  }
  return dummyKey
}

function verifyAgainst(
  jwk: Record<string, unknown>,
  payload: Buffer,
  signature: Buffer
): boolean {
  try {
    return verify(null, payload, createPublicKey({ key: jwk as never, format: 'jwk' }), signature)
  } catch {
    // A malformed key or signature is a failed verification, not a crash.
    return false
  }
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

      // THE ORACLE IS IN THE CLOCK, NOT ONLY IN THE BODY (Tinker MEDIUM-1).
      //
      // Returning early for an unknown caller made this path skip an Ed25519
      // verification that the bad-signature path performs, so the two answered
      // in measurably different times. The owner's ruling is that these must be
      // indistinguishable — a caller told "unknown_caller" versus
      // "bad_signature" learns whether an identity exists, which is the whole
      // enumeration attack, and its next action is identical either way. A
      // refusal that is uniform on the wire and distinguishable on a stopwatch
      // is not uniform.
      //
      // So the verification happens BEFORE the branch, against a key enrolled
      // for nobody when there is no real one. Structural rather than a rule to
      // remember: there is no early return left to reintroduce.
      const payload = Buffer.from(
        callAssertionPayload(workspaceId, input.sub, input.challenge),
        'utf8'
      )
      const verifier = deps.verifySignature ?? verifyAgainst
      const good = verifier(jwk ?? dummyJwk(), payload, Buffer.from(input.signature, 'base64url'))

      if (jwk === null) return { ok: false, reason: 'unknown_caller' }
      if (!good) return { ok: false, reason: 'bad_signature' }

      // The credential names this workspace and nothing else — see
      // call-credential.ts. The caller cannot ask for a broader one, because
      // the workspace here is the one it just proved itself against.
      return { ok: true, token: deps.issuer.mint(input.sub, workspaceId) }
    }
  }
}
