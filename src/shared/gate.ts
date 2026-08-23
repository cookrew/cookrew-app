/**
 * THE GATE — one decision function, two resources (§2, §9).
 *
 * The marketplace has exactly one place where an answer is chosen, and this is
 * it. A download (a signed manifest, served by the registry) and a live call
 * (an exported agent, served by its owner's workspace session) are the same
 * state machine over different resources — that is what §9 means by "one
 * protocol, two resources", and it is only true if there is literally one
 * implementation. Two copies would drift, and the one that mattered less would
 * be the weaker.
 *
 * The order is fixed and each step answers before the next runs:
 *
 *   exists? → public? → identity? → covers? → entitled? → [M2: priced?] → serve
 *
 * WHAT MOVED HERE AND WHY (S1 of the ④ lane). Until now this lived inside
 * registry/src/authorize.ts, bound to the registry's own store and its own
 * IdentityService. The remote-call gate runs in a DIFFERENT process — the
 * owner's app — against a different issuer, so the decision had to become
 * transport-free and issuer-parameterized before it could mount twice.
 *
 * OWNER-AS-ISSUER (ruling, 2026-08-22). Each app instance is its own issuer;
 * the registry stays its own. The alternative — the app verifying
 * registry-signed tokens — would have made every call, including a call between
 * two machines on the same LAN, depend on a registry that is not deployed and
 * has no domain or TLS. Because the issuer is a parameter here, adding the
 * registry as a SECOND accepted issuer in M3 is an addition, not a migration.
 *
 * Nothing in this file touches HTTP, disk, or the clock. It is a pure function
 * of the facts its caller looked up, which is what lets both bindings be tested
 * without a server.
 */

/**
 * What a resource is, to the gate.
 *
 * There is deliberately no third value meaning "unknown" or "not configured".
 * A resource whose visibility could not be established is `null` — it does not
 * exist here — because the one thing this gate must never do is treat an
 * absence of information as permission.
 */
export type Visibility = 'public' | 'identified'

/**
 * The answer, carrying the identified caller when there is one.
 *
 * `claims` is null on a 200 if and only if the resource was public — the caller
 * proved nothing because nothing was asked of them. A binding that needs to
 * know WHO called (the remote-call path does: a conversation is bound to its
 * caller) must handle that null rather than invent a subject for it.
 */
export type GateVerdict<C> =
  | { code: 200; claims: C | null }
  | { code: 401; challenge: string }
  | { code: 403; reason: string }
  | { code: 404 }

/** Whatever can turn a presented credential into claims, and ask for one. */
export interface GateIssuer<C> {
  /** A fresh challenge to offer at 401. Single-use, and a real ceremony. */
  challenge(): string
  /**
   * Claims for a credential, or null. Malformed, mis-signed and EXPIRED are
   * one answer on purpose: they are all "your credential is not currently
   * good", the remedy is identical, and distinguishing them would tell an
   * attacker which half of a forgery was wrong.
   */
  verifyToken(token: string): C | null
}

export interface GateInputs<C> {
  /** Does this resource exist here, and does it need identity? null → 404. */
  visibility: Visibility | null
  /**
   * The credential the caller PRESENTED, verbatim; null when none was.
   *
   * Absence is a caller fact, never a server permission — see decideGate.
   */
  credential: string | null
  issuer: GateIssuer<C>
  /**
   * Why these claims do not cover this resource, or null when they do.
   *
   * This is the 403 a client can act on: the registry answers `scope` for a
   * publish token presented as a download, and the call gate answers
   * `workspace` for a token minted against a different workspace session
   * (D4/R9 — a valid token at the wrong slug is 403, never 401, because
   * re-authenticating cannot fix it and a client must not loop).
   */
  covers: (claims: C) => string | null
  /**
   * Why this caller is not entitled, or null when they are.
   *
   * REQUIRED, with no default, and that is the point. M1 has no entitlement
   * service and its honest answer is `() => null` — but a binding has to write
   * that down. A default here would let a future binding be silently permissive
   * by forgetting a field, which is the exact failure this lane exists to
   * prevent.
   */
  entitled: (claims: C) => string | null
}

/**
 * Choose the answer.
 *
 * THE RULE THIS FUNCTION IS SHAPED AROUND. The app's mobile listener binds
 * 0.0.0.0, so the internet tier and the LAN tier are the same socket, and the
 * pre-existing pairing-token gate lets everything through when no token is
 * configured. This gate therefore never delegates to another gate, never
 * distinguishes tiers by listener, and has no branch in which a MISSING
 * credential produces anything but a refusal: absence and forgery converge on
 * one line below, so there is no `if (no credential) …` for a permissive branch
 * to be written into later.
 *
 * The only unauthenticated 200 is `public`, and that is reachable solely
 * because the resource's owner published it as such.
 */
export function decideGate<C>(input: GateInputs<C>): GateVerdict<C> {
  const { visibility, credential, issuer, covers, entitled } = input

  if (visibility === null) return { code: 404 }

  // Discovery and free download are not things identity should cost (A2).
  if (visibility === 'public') return { code: 200, claims: null }

  // Absence and failure, one answer, one line. Nothing downstream can tell
  // which happened, so nothing downstream can be written to prefer one.
  const claims = credential === null ? null : issuer.verifyToken(credential)
  if (claims === null) {
    // The challenge rides in the response header the spec names, so a client
    // reads one place for "what next". A 401 is a promise that a ceremony
    // exists and this server can complete it — a binding that answers 401
    // without mounting that ceremony is lying in a status code (§2).
    return { code: 401, challenge: issuer.challenge() }
  }

  // Authenticated, but the credential does not reach this resource.
  const uncovered = covers(claims)
  if (uncovered !== null) return { code: 403, reason: uncovered }

  const unentitled = entitled(claims)
  if (unentitled !== null) return { code: 403, reason: unentitled }

  // M2's 402 inserts HERE, between entitlement and serve, and reads `X-Payment`
  // when present. Nothing above it moves. Ruling R5: the live-call binding does
  // NOT take that branch — per-call pricing settles from a prepaid balance
  // bought at install, so a wallet sheet never interrupts a conversation and
  // the call path answers 200 or 403 only.
  return { code: 200, claims }
}
