// Host selection with the herdr owner claim in front of it.
//
// A second Cookrew that finds a LIVE owner of the herdr session (another
// userData; see herdr-session-claim.ts) REFUSES to boot rather than falling
// back to the direct backend. Direct looked smaller, but a direct-hosted
// instance whose store names the owner's agents — a copied userData, or the
// real app opened while a QA run holds the session — would wake each card as
// a second `claude --resume` of the same conversation beside the live pane:
// a forked agent. Refusing touches nothing. A run that must boot beside the
// owner says so with COOKREW_MULTIPLEXER=direct; then herdr is dropped from
// its backends too, so not even the migration pass can kill a pane by name.

import { claimHerdrSession, inspectHerdrClaim, ownerFile, type ClaimDeps, type ClaimVerdict, type OwnerRecord } from './herdr-session-claim'
import { selectMultiplexers, type MultiplexerRoles } from './multiplexer-select'
import type { Multiplexer } from './multiplexer'

const HERDR_ID = 'herdr'

export interface HostPlan {
  roles: MultiplexerRoles
  /** Every backend this instance may ask about a session. */
  backends: Multiplexer[]
  /** The claim verdict when herdr was to host; null otherwise. */
  claim: ClaimVerdict | null
  /** Set when this instance must not boot; the line to log before exiting. */
  refusal: string | null
}

export interface HostPlanInput {
  /** Backends in preference order, as PtyManager builds them. */
  candidates: Multiplexer[]
  /** The backend a refused instance holds until it exits (never herdr). */
  inert: Multiplexer
  /** herdrSessionDir(...) — null when it cannot be derived. */
  claimDir: string | null
  deps: ClaimDeps
}

/** What the refused launch's dialog says. refusalLine, with its launch recipe, is the operator's, for the log. */
export const REFUSAL_FOR_A_PERSON = 'Another Cookrew already runs the terminals on this machine, so this one is closing. Use the one that is open.'

export function refusalLine(owner: OwnerRecord, claimDir: string, deps: ClaimDeps): string {
  return (
    `Another Cookrew owns its herdr session (pid ${owner.pid}, userData ${owner.instance}). ` +
    `This instance (pid ${deps.pid}, userData ${deps.instance}) will not touch that session and is exiting. ` +
    'To run beside it, launch with COOKREW_MULTIPLEXER=direct. ' +
    `If pid ${owner.pid} is not Cookrew, delete ${ownerFile(claimDir)}.`
  )
}

export function planHost(input: HostPlanInput): HostPlan {
  const roles = selectMultiplexers({ candidates: input.candidates })

  if (roles.host.id !== HERDR_ID) {
    // Not hosting on herdr: never WRITE a claim (it would lock the real owner
    // out), but stay away from a session somebody live owns.
    const owned = input.claimDir ? inspectHerdrClaim(input.claimDir, input.deps) : null
    const backends =
      owned?.kind === 'foreign' ? input.candidates.filter((m) => m.id !== HERDR_ID) : input.candidates
    return { roles, backends, claim: null, refusal: null }
  }

  const claim: ClaimVerdict = input.claimDir
    ? claimHerdrSession(input.claimDir, input.deps)
    : { kind: 'unknown', reason: 'no herdr session directory (HOME unset)' }

  if (claim.kind === 'foreign' && input.claimDir) {
    const inert = input.inert
    return {
      roles: { host: inert, reader: inert, readerReason: 'refused: another Cookrew owns the herdr session' },
      backends: [inert],
      claim,
      refusal: refusalLine(claim.owner, input.claimDir, input.deps)
    }
  }
  return { roles, backends: input.candidates, claim, refusal: null }
}
