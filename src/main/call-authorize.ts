import { decideGate, type GateVerdict, type Visibility } from '../shared/gate'
import type { CallClaims, CallIssuer } from './call-credential'

/**
 * THE LIVE-CALL BINDING (§9, ④ · S1) — the app's half of the one gate.
 *
 * The decision is src/shared/gate.ts, the same function the registry's download
 * path uses. This file supplies only the three facts that differ: whether an
 * agent is exported from the addressed workspace at all, what a credential must
 * say to reach it, and who is entitled.
 *
 * MOUNTED PER WORKSPACE SESSION, NOT PER APP (§11). `POST
 * /<slug>/agents/<name>/ask` is answerable precisely because a workspace
 * instance is addressable, so the workspace being addressed is an argument to
 * every decision here rather than ambient state read from focus. There is no
 * path through this file that consults the focused session: an unslugged call
 * is not a call, and a slug that names a workspace this credential was not
 * minted for is refused rather than quietly answered by whichever workspace the
 * owner happens to be looking at.
 *
 * INDEPENDENT OF THE PAIRING GATE. The app's mobile listener binds 0.0.0.0 —
 * the LAN tier and the internet tier are the same socket — and the pairing gate
 * lets everything through when no token is configured. This gate therefore
 * never asks what the pairing gate decided and never asks which listener the
 * request arrived on. It distinguishes tiers by the credential presented.
 */

/**
 * What the route addressed: one agent NODE, in one workspace session.
 *
 * A node id, not a name, because the name has already been resolved inside the
 * addressed workspace by then (call-route.ts). By the time a decision is made
 * there is no name left to be ambiguous, and no lookup left that could reach
 * outside the scope.
 */
export interface CallTarget {
  /** The workspace the SLUG resolved to. Never the focused one. */
  workspaceId: string
  /** The terminal node the agent name resolved to, inside that workspace. */
  nodeId: string
}

export interface CallAuthorizeDeps {
  /**
   * Is this node exported from this workspace, and does calling it need
   * identity? `null` means "not callable here" and becomes a 404.
   *
   * A 404 rather than a 403 for the unexported case: a scoped URL must not
   * confirm what exists outside its scope, which is the same rule
   * mobile-server already applies to node routes. Export is explicit — an agent
   * nobody exported is not callable — so the honest default of this lookup is
   * null and never 'public'.
   */
  exportedVisibility: (target: CallTarget) => Visibility | null
  issuer: CallIssuer
  /**
   * Why this caller is not entitled to this agent, or null when they are.
   *
   * Required, no default — M1's honest answer for a listed caller is null, and
   * a binding has to write that down rather than inherit it. R5: the LIVE CALL
   * never answers 402. Per-call pricing settles from a prepaid balance bought
   * at install, so an exhausted balance surfaces HERE as a 403 with a reason
   * and a wallet sheet never interrupts a conversation. R12: the drawdown is
   * per turn, charged at turn accept, so this answers before a turn starts and
   * never interrupts a running one.
   */
  entitled: (claims: CallClaims, target: CallTarget) => string | null
}

/**
 * Decide one call.
 *
 * The verdict carries the caller's claims on a 200 so the route can bind the
 * conversation to its subject — which is what makes "one fork per caller
 * conversation, not per HTTP call" implementable. `claims` is null only when
 * the agent was exported publicly and nothing was asked of the caller; a route
 * that needs a subject must handle that rather than invent one.
 */
export function makeCallAuthorize(
  deps: CallAuthorizeDeps
): (target: CallTarget, credential: string | null) => GateVerdict<CallClaims> {
  return (target, credential) =>
    decideGate<CallClaims>({
      visibility: deps.exportedVisibility(target),
      credential,
      issuer: {
        // The challenge offered at 401 is BOUND to the workspace that emitted
        // it, so the nonce cannot be carried to another workspace's ceremony.
        // The gate itself takes no argument here and should not: it does not
        // know what a workspace is. The binding does, so the binding supplies
        // it — at the one place the addressed workspace is in hand.
        challenge: () => deps.issuer.challenge(target.workspaceId),
        verifyToken: (token) => deps.issuer.verifyToken(token)
      },
      covers: (claims) => {
        // A download token is not a call token even if some future issuer signs
        // both. Checked here rather than at verification so the refusal is a
        // 403 the client can act on instead of an indistinguishable 401.
        if (claims.scope !== 'call') return 'scope'
        // D4 / R9, and Magpie's R2: a genuine, unexpired credential minted
        // against another workspace session is 403 `workspace`, never 401. The
        // client cannot fix this by re-authenticating with the same key against
        // the same origin — it must obtain a credential for THIS workspace — so
        // telling it "your identity is the problem" would send it round a loop
        // that cannot terminate.
        if (claims.workspace !== target.workspaceId) return 'workspace'
        return null
      },
      entitled: (claims) => deps.entitled(claims, target)
    })
}
