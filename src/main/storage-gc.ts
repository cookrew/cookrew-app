/**
 * STORAGE GC — the sweep nothing else was doing.
 *
 * Every durable store under ~/.cookrew was written to and never read back for
 * removal. Two of them grow without bound because deleting the thing they
 * describe does not delete them:
 *
 *   TURN LEDGERS (~/.cookrew/turns/<terminalId>.jsonl) outlive their card. A
 *   terminal removed from the canvas leaves its ledger behind forever; measured
 *   on the author's machine, 397 of 454 ledgers belonged to terminals that
 *   exist on no canvas and in no saved team.
 *
 *   ATTACHMENTS (~/.cookrew/attachments) have a writer and no deleter at all —
 *   `attachments.ts` exposes saveAttachment and nothing else. An image pasted
 *   from the phone is kept whether or not anything ever points at it again.
 *
 * Deliberately NOT collected: the team session sidecars. They look like the
 * biggest consumer (1.0G by `du`) and are the obvious thing to delete, which is
 * exactly why this says so. They are APFS clones of the live Claude session
 * files and every one measured was an exact byte-prefix of its source, so their
 * blocks are shared and reclaiming them frees approximately nothing while
 * breaking fork-from-saved. `du` cannot see clone sharing; it reports the full
 * length of both copies. Delete them only when the source is gone.
 *
 * The planner is pure and total: it decides, it does not unlink. That is what
 * makes a dry run the same code path as the sweep.
 */

/** One reclaimable file. `key` is what the reference check is made against. */
export interface GcCandidate {
  /** Terminal id for a ledger; file name for an attachment. */
  key: string
  path: string
  bytes: number
  mtimeMs: number
}

export interface GcPlanInput {
  ledgers: readonly GcCandidate[]
  attachments: readonly GcCandidate[]
  /**
   * Canvas node ids UNION every saved team's node ids. A template you can still
   * fork from is a live reference even when its card is long gone, so the team
   * store has to be part of this set or the sweep eats forkable history.
   */
  liveTerminalIds: ReadonlySet<string>
  /** Attachment file names named by any note, turn, or saved team. */
  referencedAttachments: ReadonlySet<string>
  now: number
  /** Nothing younger than this is ever collected. */
  graceMs: number
}

export interface GcPlan {
  remove: readonly GcCandidate[]
  /** Bytes the plan would free — only what is in `remove`. */
  bytes: number
  kept: { live: number; withinGrace: number }
}

/**
 * Old enough to be abandoned rather than merely unreferenced.
 *
 * A future mtime answers false. Clock skew and a restored backup both produce
 * timestamps ahead of now, and the safe reading of "I cannot tell how old this
 * is" is to keep it: this function's mistakes are unrecoverable in one
 * direction only.
 */
function pastGrace(candidate: GcCandidate, now: number, graceMs: number): boolean {
  const age = now - candidate.mtimeMs
  return age > graceMs
}

export function planStorageGc(input: GcPlanInput): GcPlan {
  const { now, graceMs } = input
  const remove: GcCandidate[] = []
  let live = 0
  let withinGrace = 0

  const consider = (candidate: GcCandidate, referenced: boolean): void => {
    if (referenced) {
      live += 1
      return
    }
    if (!pastGrace(candidate, now, graceMs)) {
      withinGrace += 1
      return
    }
    remove.push(candidate)
  }

  for (const ledger of input.ledgers) {
    consider(ledger, input.liveTerminalIds.has(ledger.key))
  }
  for (const attachment of input.attachments) {
    consider(attachment, input.referencedAttachments.has(attachment.key))
  }

  return {
    remove,
    bytes: remove.reduce((sum, c) => sum + c.bytes, 0),
    kept: { live, withinGrace }
  }
}
