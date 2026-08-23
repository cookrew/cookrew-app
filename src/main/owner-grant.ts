/**
 * Granting: the owner deciding who may call what.
 *
 * THE WIRE CARRIES THE CEREMONY AND THE CALL, NEVER THE GRANT.
 *
 * This surface is strictly MORE powerful than the gate it feeds — anyone who
 * can reach it enrols themselves and exports every agent in the workspace,
 * which makes every refusal downstream decorative. And a credential good
 * enough to enrol would have to be issued by something, and whatever issued it
 * becomes the real gate on the same 0.0.0.0 socket with every property to
 * prove all over again. So the trust root for granting is the one thing that
 * needs no credential because it is not reachable over a network at all: the
 * owner's own process.
 *
 * Two consequences this module exists to enforce rather than assert:
 *
 * NOT ON ANY LISTENER. No HTTP route may reach these operations, under any
 * slug, with any credential. tests/grant-surface-shape.test.ts fails if one
 * ever appears — a sweep, not a comment, because a comment does not fail.
 *
 * NOT DRIVABLE BY A RENDERED PAGE. The app renders content it does not trust:
 * browser cards, an install page, a preset that ships a URL. "Owner-only IPC"
 * is worth nothing if a page the app merely displays can reach the same
 * channel, so the caller identity is checked at the boundary (ownerSenderCheck)
 * rather than assumed from the fact that IPC is not HTTP.
 *
 * A GRANT IS A DECISION WITH A RECORD. Who, to whom, when — because M3's seats
 * and revocation are reads and writes of this same record, and a record that
 * cannot say when a grant was made cannot expire one.
 */

import type { AgentExportStore, AgentExport } from './agent-export'
import type { CallIdentity } from './call-inflight'
import type { Visibility } from '../shared/gate'

/** What a grant decision records beyond the grant itself. */
export interface GrantProvenance {
  /** Epoch ms the owner made the decision. M3 expires seats against this. */
  at: number
  /**
   * Free-form origin of the decision, for the audit line only — never
   * consulted by the gate. 'owner-ipc' today; M3 adds registry-vouched.
   */
  via: string
}

export interface GrantResult {
  ok: boolean
  /** Machine-readable, and distinct at THIS boundary — see the note below. */
  reason?: string
  /**
   * Calls that were RUNNING and were stopped by this decision.
   *
   * Present on the two operations that take access away. It exists because
   * "revoked" and "revoked, and stopped two calls that were running" are
   * different things to be told, and the second is the one that answers the
   * question the owner was actually asking when they reached for the control.
   */
  stopped?: number
}

/**
 * Grant reasons are distinct HERE and indistinguishable on the wire.
 *
 * The lane's ruling is that ceremony failures must not let a stranger
 * enumerate. That rule is about the LISTENER. This surface has no stranger on
 * it — the only caller is the owner at their own keyboard, and an owner who is
 * told "that caller already exists" can act on it while "no" leaves them
 * guessing at their own machine. Distinctness is required where the caller's
 * next action differs and forbidden where it would let a stranger enumerate;
 * this is the first half.
 */
export const GRANT_REASON = {
  incomplete: 'incomplete',
  callerExists: 'caller_exists',
  notEnrolled: 'not_enrolled',
  noCallers: 'no_callers'
} as const

export interface OwnerGrantDeps {
  store: AgentExportStore
  now?: () => number
  /**
   * Cut every call in flight that the predicate claims; returns how many.
   *
   * REVOKE STOPS CALLS ALREADY RUNNING (Velvet's ruling, owner-confirmed). The
   * control is one someone reaches for in a panic, and the only question they
   * are asking is MAKE IT STOP NOW — so a revoke that let the current call run
   * to completion would be a button whose words and whose behaviour disagree.
   *
   * Passed as a function rather than imported, for the same reason `audit` is:
   * this module stays thin, testable without a pty, and — not incidentally —
   * free of any edge that the listener-reach sweep would have to reason about.
   */
  cancelInFlight?: (match: (call: CallIdentity) => boolean) => number
  /** Appended for every decision. Metadata only — never keys, never prompts. */
  audit?: (line: {
    op: 'enrol' | 'revoke' | 'export' | 'unexport'
    workspaceId: string
    subject: string
    at: number
    via: string
  }) => void
}

/**
 * The owner's grant operations, over the same record the gate reads.
 *
 * Deliberately thin: it stamps provenance, refuses the shapes the gate would
 * later have to refuse anyway, and writes an audit line. It does NOT decide
 * authorization — that is the gate's job, and duplicating it here would be a
 * second implementation to keep in agreement.
 */
export class OwnerGrant {
  private readonly now: () => number

  constructor(private readonly deps: OwnerGrantDeps) {
    this.now = deps.now ?? ((): number => Date.now())
  }

  /**
   * Admit a caller's key at one workspace.
   *
   * A caller cannot enrol itself: it presents a key through the ceremony, and
   * the OWNER admits it here. That asymmetry is the whole trust root.
   */
  enrol(workspaceId: string, sub: string, jwk: Record<string, unknown>): GrantResult {
    const result = this.deps.store.enrol(workspaceId, sub, jwk)
    if (result.ok) this.note('enrol', workspaceId, sub)
    return result
  }

  /**
   * Forget a caller, and stop whatever it is doing right now.
   *
   * The record is written FIRST. If the process died between the two steps,
   * the surviving state must be the one where access is gone — a stopped call
   * with the grant intact is a caller who simply calls again.
   *
   * Outstanding credentials still expire on their own; what this guarantees is
   * that they no longer entitle anyone, including mid-call.
   */
  revoke(workspaceId: string, sub: string): GrantResult {
    this.deps.store.revoke(workspaceId, sub)
    const stopped = this.cut((call) => call.workspaceId === workspaceId && call.sub === sub)
    this.note('revoke', workspaceId, sub)
    return { ok: true, stopped }
  }

  /**
   * Make an agent callable by named callers.
   *
   * Refuses callers who are not enrolled at THIS workspace. The gate would
   * refuse the call anyway, so nothing is unsafe about allowing it — but a
   * grant that silently names a subject who can never use it is a grant the
   * owner believes they made and did not. Failing here is the difference
   * between a mistake and a misunderstanding.
   */
  exportAgent(
    workspaceId: string,
    nodeId: string,
    callers: readonly string[],
    // 'identified', never 'public' — a live call is never public (S3), and
    // the store's own isExport refuses a public grant. Defaulting to the safe
    // half means an omitted argument cannot widen reach.
    visibility: Visibility = 'identified'
  ): GrantResult {
    if (callers.length === 0) return { ok: false, reason: GRANT_REASON.noCallers }
    for (const sub of callers) {
      if (this.deps.store.enrolledKey(workspaceId, sub) === null) {
        return { ok: false, reason: GRANT_REASON.notEnrolled }
      }
    }
    const grant: AgentExport = { workspaceId, nodeId, visibility, callers: [...callers] }
    this.deps.store.exportAgent(grant)
    this.note('export', workspaceId, nodeId)
    return { ok: true }
  }

  /**
   * Stop answering for an agent. The address stops existing to the internet,
   * and every call already running against it stops with it.
   *
   * Every CALLER of that agent, not one: unexporting is the owner saying this
   * agent is not answering anyone, and leaving the calls that happened to be
   * mid-flight running would be the same disagreement between the words and
   * the behaviour that the revoke ruling ruled out.
   */
  unexport(workspaceId: string, nodeId: string): GrantResult {
    this.deps.store.unexport(workspaceId, nodeId)
    const stopped = this.cut((call) => call.workspaceId === workspaceId && call.nodeId === nodeId)
    this.note('unexport', workspaceId, nodeId)
    return { ok: true, stopped }
  }

  /**
   * Fire the cancellations, and never let them undo the decision.
   *
   * The same rule the audit line follows, and for a stronger reason: a revoke
   * that reported failure because a cleanup threw would leave the owner
   * believing access is still granted when the record already says it is not.
   * The written record is the truth; stopping the call is what this does about
   * it, and it reports 0 rather than pretending.
   */
  private cut(match: (call: CallIdentity) => boolean): number {
    try {
      return this.deps.cancelInFlight?.(match) ?? 0
    } catch {
      return 0
    }
  }

  private note(
    op: 'enrol' | 'revoke' | 'export' | 'unexport',
    workspaceId: string,
    subject: string
  ): void {
    try {
      this.deps.audit?.({ op, workspaceId, subject, at: this.now(), via: 'owner-ipc' })
    } catch {
      // An audit that throws must not undo a decision the owner already made.
    }
  }
}

/**
 * Is this IPC sender the owner's own window, top frame?
 *
 * The app renders content it does not trust. A browser card hosts arbitrary
 * pages; an install page comes from a registry; a preset can ship a URL. If any
 * of those can reach this channel then "owner-only IPC" is the listener hole
 * wearing different clothes — the grant would be reachable by whoever the owner
 * happened to browse to.
 *
 * So the check is positive: the sender must BE the main window's webContents,
 * and the frame must be the TOP frame — an iframe inside the owner's own page
 * is still not the owner. Anything else is refused, including a sender this
 * function cannot identify, because an unidentifiable sender on the surface
 * that decides who reaches the internet is not a tie to break generously.
 */
export function isOwnerSender(
  sender: unknown,
  senderFrame: { parent: unknown } | null | undefined,
  ownerWebContents: unknown
): boolean {
  if (ownerWebContents === undefined || ownerWebContents === null) return false
  if (sender !== ownerWebContents) return false
  // No frame at all means it could not be proven to be the top one.
  if (!senderFrame) return false
  return senderFrame.parent === null
}
