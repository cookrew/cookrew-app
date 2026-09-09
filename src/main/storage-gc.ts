/**
 * STORAGE GC — the sweep nothing else was doing.
 *
 * Every durable store under ~/.cookrew was written to and never read back for
 * removal. Three of them grow without bound because deleting the thing they
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
 *   TEAM SESSION SIDECARS (~/.cookrew/teams/<slug>-sessions/<id>.jsonl) are
 *   the biggest store by far — 1048 MB of 1422 MB measured 2026-09-06, of
 *   which 1014 MB was still named by a team and 32.7 MB (two files) was not —
 *   and the only thing that ever removed one was `TeamStore.pruneSessionSidecars`,
 *   which runs after a successful re-save of the SAME team. A deleted team
 *   JSON, a save that threw, or a canvas re-saved under another name leaves
 *   files no team can read. The app resolves a sidecar through
 *   `<fileSlug(team.name)>-sessions/<sessions[terminalId]>`, so that relative
 *   path is the candidate key and a file is live only when some readable team
 *   resolves to it — the same file name under another team's directory is not
 *   reachable and is not live.
 *
 *   The sidecars are APFS clones of the live Claude session file. Removing a
 *   clone whose source still exists frees only its unshared blocks, so the
 *   bytes a plan reports (file lengths, what `du` counts) are an upper bound
 *   on what the disk gives back. They are removed anyway: nothing can read
 *   them, and they hold the disk once the source is gone.
 *
 * Collected with its OWN live rule: the served-session sandboxes
 * (~/.cookrew/sessions/<service>/<session>, storage-gc-served.ts). A sandbox is
 * live while its session is OPEN in the running instantiator — a fact only the
 * app holds, handed in as a set — and an ended one is collected once its newest
 * write is past the grace period. A planner that was not told which sessions
 * are open plans nothing for the class: "no open set" is unknown, not empty.
 *
 * The planner is pure and total: it decides, it does not unlink. That is what
 * makes a dry run the same code path as the sweep. The scan decides one thing
 * the planner cannot — whether the store was READABLE — and expresses a
 * refusal as an empty candidate list, never as a policy of its own.
 */

/** One reclaimable file. `key` is what the reference check is made against. */
export interface GcCandidate {
  /**
   * Terminal id for a ledger; file name for an attachment; for a sidecar the
   * path relative to the teams root (`<slug>-sessions/<file>`); for a served
   * session `<service dir>/<session dir>` (servedSessionKey).
   */
  key: string
  path: string
  bytes: number
  mtimeMs: number
}

export interface GcPlanInput {
  ledgers: readonly GcCandidate[]
  attachments: readonly GcCandidate[]
  /**
   * Team session sidecar files. EMPTY when the scan could not read every team
   * JSON: an unreadable team is indistinguishable from one that names
   * everything, and the only safe plan for a store you cannot read is none.
   */
  sidecars: readonly GcCandidate[]
  /**
   * Canvas node ids UNION every saved team's node ids. A template you can still
   * fork from is a live reference even when its card is long gone, so the team
   * store has to be part of this set or the sweep eats forkable history.
   */
  liveTerminalIds: ReadonlySet<string>
  /** Attachment file names named by any note, turn, or saved team. */
  referencedAttachments: ReadonlySet<string>
  /**
   * Sidecar keys some readable team resolves to: for every team, for every
   * value of its sessions map, `<fileSlug(team.name)>-sessions/<value>`.
   */
  referencedSidecars: ReadonlySet<string>
  /**
   * Served-session sandbox DIRECTORIES, one candidate each, keyed by
   * servedSessionKey. Its `mtimeMs` is the newest write anywhere inside, so a
   * sandbox still being written to is inside grace by construction.
   */
  servedSessions?: readonly GcCandidate[]
  /**
   * Keys of the sessions OPEN in the running instantiator. Absent means the
   * caller could not say — and then every served candidate is kept, because
   * the difference between "none open" and "nobody told me" is a caller's
   * crew deleted out from under them.
   */
  openServedSessions?: ReadonlySet<string>
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
  for (const sidecar of input.sidecars) {
    consider(sidecar, input.referencedSidecars.has(sidecar.key))
  }
  // No open set = unknown = the class is not planned at all. Not even counted
  // as kept: a number that says "43 live" when the truth is "did not look"
  // would be the report lying in the safe direction, which is still lying.
  if (input.openServedSessions !== undefined) {
    for (const session of input.servedSessions ?? []) {
      consider(session, input.openServedSessions.has(session.key))
    }
  }

  return {
    remove,
    bytes: remove.reduce((sum, c) => sum + c.bytes, 0),
    kept: { live, withinGrace }
  }
}
