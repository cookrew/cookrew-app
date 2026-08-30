import { cutVersionPin, type VersionPinRecord } from '../shared/version-pin'

/**
 * A REMOTE CALL CUTS A VERSION (§10 · ④ · S3) — the fork and its pin, together.
 *
 * §10 READS LIKE PURITY AND IS ACTUALLY SAFETY. "Exporting or calling an agent
 * never mutates its original session" sounds like tidiness until you follow
 * what /ask does: it takes the producer lease and delivers a prompt as one
 * bracketed paste followed by a delayed Enter, up to 1.5 seconds later. A call
 * interrupted between the paste and the CR leaves the pasted text sitting
 * unsubmitted in the TUI's input box, and ask.ts marks the terminal
 * CONTAMINATED — every submit-capable write then refuses until the terminal is
 * RESTARTED, deliberately, because no control byte this code could send is
 * PROOF of a clean buffer.
 *
 * So without the fork, an internet caller whose connection drops at the wrong
 * moment can leave the owner's live terminal refusing the owner's own keyboard.
 * The fork is not hygiene. It is the reason a stranger cannot reach the input
 * box the owner is typing into.
 *
 * NON-SPLITTABLE (ruling). The fork and the pin land in one operation, because
 * a call that answered without cutting a version is a call whose §10 invariant
 * nothing can check — the fork would exist with no name, no number and nothing
 * on the rail to say where it came from.
 */

export interface CallVersion {
  /** The terminal the call will actually run against. Never the original. */
  forkId: string
  forkName: string
  /** The pin cut against the ORIGINAL, marking where this version came from. */
  pin: VersionPinRecord
}

export interface CallForkDeps {
  /**
   * The shipping fork engine (fork.ts) — a truncated session copy where the
   * harness supports one, a replayed preamble where it does not. Reused rather
   * than reimplemented: a second fork path would eventually differ from the
   * one the owner's own ⑂ button uses, and the marketplace copy would be the
   * one nobody noticed had drifted.
   */
  fork: (sourceId: string, turnIndex: number) => { id: string; name: string }
  /** Completed turns of a terminal, in order. The uuid rides along so the pin
   *  can be cut with its compaction-proof anchor (VersionPinRecord.atUuid). */
  turnsOf: (terminalId: string) => readonly { index: number; uuid?: string }[]
  /**
   * tmux history_size for a terminal right now, or null when it cannot be
   * read (no tmux, detached, disposed). Null becomes 0 — a jump coordinate
   * that is unknown, never a guess at one.
   */
  scrollLineOf: (terminalId: string) => number | null
  pins: {
    list: (terminalId: string) => VersionPinRecord[]
    add: (terminalId: string, pin: VersionPinRecord) => void
  }
  now: () => number
}

/**
 * Cut the version a remote call runs against.
 *
 * THE PIN GOES ON THE ORIGINAL, not on the fork. §10: a pin is "pinned at the
 * transcript point the version was cut" — that point exists on the source's
 * rail, which is where lineage has to read at a glance. A pin on the fork would
 * mark the fork's own beginning, which is a fact nobody needed.
 *
 * ORDER, and why it is this one. The pin record is computed BEFORE the fork
 * (pure, cannot fail) and persisted AFTER it (a version that names no fork is
 * a number burned for nothing, and would make the next cut skip). A failure
 * anywhere throws, and the caller is told the call did not happen rather than
 * being handed a fork with no version or a version with no fork.
 */
export function cutCallVersion(deps: CallForkDeps, sourceId: string): CallVersion {
  const history = deps.turnsOf(sourceId)
  if (history.length === 0) {
    // fork.ts refuses this too. Stated here as well because the message a
    // caller gets should say what is missing, not surface an engine's wording.
    throw new Error('no completed turns to cut a version from')
  }
  const atIndex = history[history.length - 1].index

  // Computed first: pure, so the only thing that can fail below is the fork
  // itself or the write, and neither can leave a half-formed record.
  const pin = cutVersionPin(deps.pins.list(sourceId), {
    atIndex,
    // The LATEST record's uuid is the same turn in ledger space and file
    // space (the two diverge only for older indices after a /compact —
    // checkpoint-session-alignment), so no trace plumbing is needed here.
    atUuid: history[history.length - 1].uuid,
    // The jump coordinate, not the rail anchor (R17). Unknown reads as 0.
    scrollLine: deps.scrollLineOf(sourceId) ?? 0,
    cutAt: deps.now()
  })

  const fork = deps.fork(sourceId, atIndex)
  deps.pins.add(sourceId, pin)

  return { forkId: fork.id, forkName: fork.name, pin }
}
