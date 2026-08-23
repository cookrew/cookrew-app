import { createHash } from 'node:crypto'
import type { AgentExport, EnrolledCaller } from './agent-export'
import type { CallIdentity } from './call-inflight'
import { fingerprintOfDigest, rawKeyOfJwk, type KeyFingerprint } from '../shared/key-fingerprint'

/**
 * WHAT THE OWNER CAN SEE ABOUT WHAT THEY GRANTED.
 *
 * The grant surface could already CHANGE things and could barely SHOW them:
 * `grant:list` handed back raw exports, which is the record's shape rather than
 * the question's. The owner's question is "who can reach my agents, and what is
 * happening right now", and the revoke ruling makes the second half
 * load-bearing — a control whose copy promises to stop calls already running is
 * unusable if the surface cannot say whether any are.
 *
 * TWO HALF-MADE GRANTS ARE RENDERED, NOT HIDDEN. A caller enrolled and exported
 * nowhere, and an agent exported to nobody, are both states an owner lands in by
 * accident and neither is visible from the record's own shape. Showing them is
 * the difference between a mistake the owner can see and a call that
 * mysteriously refuses.
 *
 * THIS DECIDES NOTHING. Every refusal still lives in the gate. Nothing here is
 * consulted by it, and duplicating any of it here would be a second
 * implementation to keep in agreement — which is the defect this lane keeps
 * finding in other people's code and should not introduce in its own.
 */

/** An enrolled caller, as the owner's surface needs to show it. */
export interface RosterCaller {
  sub: string
  /** What the owner called them. Display only, never consulted by the gate. */
  name?: string
  /** A short digest of the enrolled public key — see keyFingerprint. */
  keyFingerprint: string
  /**
   * The SPOKEN fingerprint — six words, 66 bits (deck §3).
   *
   * null when the enrolled key is not an ed25519 public key, which the paste
   * parser makes unreachable today. A fingerprint of the wrong bytes would be
   * compared and would appear to work, so there is no fallback rendering.
   */
  fingerprint: KeyFingerprint | null
  /** Agents in THIS workspace this caller may call. Empty is a real answer. */
  agents: readonly string[]
  /** Last time they actually called — the deck's LAST CALL column. */
  lastCallAt?: number
  /** Set only on the REVOKED section's rows. */
  revokedAt?: number
}

/** An exported agent, with what is happening to it right now. */
export interface RosterAgent {
  nodeId: string
  callers: readonly string[]
  /** Calls running against it at this instant. What a revoke would stop. */
  inFlight: number
}

export interface GrantRoster {
  workspaceId: string
  callers: readonly RosterCaller[]
  agents: readonly RosterAgent[]
  /**
   * Callers the owner revoked, with their last-call time (deck §6).
   *
   * "Revoking does not delete history" — who USED to have access is a security
   * question people ask after the fact, and a hard delete answers it with
   * silence. Kept separate from `callers` so the surface cannot accidentally
   * render a revoked caller as live.
   */
  revoked: readonly RosterCaller[]
  /** Every call running right now, because that is what a revoke stops. */
  live: readonly { sub: string; nodeId: string }[]
}

export interface GrantRosterDeps {
  workspaceId: string
  enrolledIn: (workspaceId: string) => readonly EnrolledCaller[]
  revokedIn?: (workspaceId: string) => readonly EnrolledCaller[]
  exportsIn: (workspaceId: string) => readonly AgentExport[]
  callsIn: (workspaceId: string) => readonly CallIdentity[]
}

/**
 * A short, stable digest of an enrolled public key.
 *
 * The raw JWK is a public key and safe to show, but it is unreadable, and what
 * the owner actually needs from it is a thing they can COMPARE — is this the
 * same caller I enrolled last week, and is this still the same key. So: sorted
 * keys before hashing, because two records of one key that happened to be
 * serialised in different orders must not read as a rotation that never
 * happened; and sixteen hex characters, which is short enough to read aloud and
 * long enough that two enrolled callers will not collide.
 */
function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest())
}

export function keyFingerprint(jwk: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(jwk).sort(([a], [b]) => a.localeCompare(b)))
  )
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}

export function buildGrantRoster(deps: GrantRosterDeps): GrantRoster {
  const { workspaceId } = deps
  const exports = deps.exportsIn(workspaceId)
  const live = deps.callsIn(workspaceId)

  const asRoster = (caller: EnrolledCaller): RosterCaller => {
    const raw = rawKeyOfJwk(caller.jwk)
    return {
      sub: caller.sub,
      ...(caller.name !== undefined ? { name: caller.name } : {}),
      keyFingerprint: keyFingerprint(caller.jwk),
      fingerprint: raw ? fingerprintOfDigest(sha256(raw)) : null,
      // Read from the exports rather than stored on the caller: the export is
      // the only record of who may call what, and a second copy here would be
      // a thing to keep in agreement with it.
      agents: exports.filter((e) => e.callers.includes(caller.sub)).map((e) => e.nodeId),
      ...(caller.lastCallAt !== undefined ? { lastCallAt: caller.lastCallAt } : {}),
      ...(caller.revokedAt !== undefined ? { revokedAt: caller.revokedAt } : {})
    }
  }

  return {
    workspaceId,
    callers: deps.enrolledIn(workspaceId).map(asRoster),
    revoked: (deps.revokedIn?.(workspaceId) ?? []).map(asRoster),
    agents: exports.map((e) => ({
      nodeId: e.nodeId,
      callers: [...e.callers],
      inFlight: live.filter((call) => call.nodeId === e.nodeId).length
    })),
    live: live.map((call) => ({ sub: call.sub, nodeId: call.nodeId }))
  }
}
