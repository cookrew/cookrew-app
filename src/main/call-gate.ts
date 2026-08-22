import type { CanvasNode } from '../shared/model'
import type { GateVerdict } from '../shared/gate'
import { makeCallAuthorize, type CallTarget } from './call-authorize'
import { resolveAgentByName } from './call-route'
import type { CallClaims, CallIssuer } from './call-credential'
import type { AgentExport } from './agent-export'

/**
 * ONE CALL, DECIDED (§9 · ④ · S2) — resolution, then the gate.
 *
 * The order matters and it is the reverse of the obvious one. A name is
 * resolved INSIDE the addressed workspace before any credential is looked at,
 * so an address that does not resolve is 404 without the gate ever running.
 * That is deliberate: an unresolvable name and an unexported agent must be one
 * answer, and a caller must not be able to learn which agents exist in a
 * workspace by watching whether it gets 404 or 401.
 *
 * The whole thing is transport-free. The server renders what this returns; it
 * makes no decisions of its own.
 */

export interface CallGateDeps {
  /**
   * The nodes of ONE workspace — store.workspaceState(id).nodes, which reads
   * the active workspace from memory and any other from disk.
   *
   * Not store.nodeByName and not store.terminals(): both read focusedState, so
   * either would answer for whichever canvas the owner is looking at. That is
   * the defect that took /cwd off the scoped-route table, and a name-addressed
   * route is where it would be easiest to repeat.
   */
  nodesOf: (workspaceId: string) => readonly CanvasNode[]
  /** The owner's grant record, scoped by workspace in the lookup itself. */
  exportOf: (workspaceId: string, nodeId: string) => AgentExport | null
  issuer: CallIssuer
}

export interface CallDecision {
  verdict: GateVerdict<CallClaims>
  /**
   * The node the address resolved to — present only once it resolved AND the
   * gate served the call. A refusal never carries a node, so a caller cannot
   * read one out of an error.
   */
  target: CallTarget | null
}

const NOT_FOUND: CallDecision = { verdict: { code: 404 }, target: null }

export function makeCallGate(deps: CallGateDeps): (
  workspaceId: string,
  agent: string,
  credential: string | null
) => CallDecision {
  const authorize = makeCallAuthorize({
    exportedVisibility: (target) => deps.exportOf(target.workspaceId, target.nodeId)?.visibility ?? null,
    issuer: deps.issuer,
    entitled: (claims, target) => {
      const grant = deps.exportOf(target.workspaceId, target.nodeId)
      // Unreachable while the visibility lookup above sees the same record —
      // but the two lookups are separate reads and a grant can be withdrawn
      // between them. A withdrawn grant refuses; it does not fall through.
      if (grant === null) return 'entitlement'
      // M1's entitlement source is the owner's local allow-list (the ruling:
      // a signed receipt from the registry is M3's job). An export with no
      // callers listed entitles NOBODY — the closed default, stated at the one
      // place it is read.
      return grant.callers.includes(claims.sub) ? null : 'entitlement'
    }
  })

  return (workspaceId, agent, credential) => {
    const resolved = resolveAgentByName(deps.nodesOf(workspaceId), agent)
    // 'none' and 'ambiguous' are ONE answer on the wire. An ambiguity is the
    // owner's problem to fix by renaming, and telling a caller "there are two
    // of these" would confirm what lives in a workspace it has not been let
    // into.
    if (resolved.kind !== 'found') return NOT_FOUND

    const target: CallTarget = { workspaceId, nodeId: resolved.nodeId }
    const verdict = authorize(target, credential)
    return { verdict, target: verdict.code === 200 ? target : null }
  }
}
