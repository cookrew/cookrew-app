import type { CallerKeyRefusal } from '../../shared/caller-key'
import { MKT_EXPORT } from '../../shared/marketplace-copy'

/**
 * Velvet's copy, verbatim (deck §4 and §7), with her ids.
 *
 * IN ONE FILE BECAUSE THE WORDS ARE THE DESIGN. This surface is strictly more
 * powerful than the gate it feeds, and the deck's argument throughout is that
 * its sentences carry the safety: a button labelled "Confirm" collects a
 * reflex, "I COMPARED THESE · ENROL" collects a statement. Copy scattered
 * through JSX gets softened one adjective at a time by people who never read
 * the reasoning; here it is one diff away from the person who wrote it.
 *
 * THE ONE RULE THAT IS NOT COSMETIC. Two of these strings branch on the
 * DIRECTION of the change rather than on the error. "Couldn't save those
 * grants — access is unchanged" is reassurance, and it is true when the staged
 * change ADDED access. When it REMOVED access, "unchanged" means they still
 * have what the owner just tried to take away, and the calm phrasing buries
 * exactly the fact that matters. Same code path, two strings, because the same
 * event means opposite things depending on which way the owner was moving.
 */

/** Deck §4 — what arrived in the paste box. */
export const PASTE_COPY: Record<CallerKeyRefusal['reason'], { id: string; text: string }> = {
  notakey: {
    id: 'mkt.grant.paste.notakey',
    text: "That doesn't look like a public key."
  },
  wrongtype: {
    // {type} is filled by pasteMessage — the deck is explicit that naming the
    // algorithm beats saying "invalid".
    id: 'mkt.grant.paste.wrongtype',
    text: 'That’s a {type} key. Cookrew callers use ed25519.'
  },
  malformed: {
    id: 'mkt.grant.paste.malformed',
    text: 'That key is incomplete — it may have been cut off when copied.'
  },
  private: {
    id: 'mkt.grant.paste.private',
    text:
      "That's a private key — don't share it. Cookrew hasn't stored it. Ask them for " +
      'their public key, and if they sent this to you over a channel someone else can read, ' +
      'they should replace the pair.'
  }
}

/** Already enrolled — a lookup, not a parse (deck §4, row 5). */
export const DUPLICATE_COPY = {
  id: 'mkt.grant.paste.duplicate',
  text: 'You already enrolled this key as {name}.'
}

export function pasteMessage(refusal: CallerKeyRefusal): { id: string; text: string } {
  const entry = PASTE_COPY[refusal.reason]
  if (refusal.reason === 'wrongtype') {
    return { id: entry.id, text: entry.text.replace('{type}', refusal.type) }
  }
  return entry
}

/**
 * A private key is the only refusal that CLEARS THE FIELD.
 *
 * Every other refusal leaves the paste in place so the owner can see what they
 * pasted and fix it. This one removes it, because leaving a private key sitting
 * in a text input on screen is the harm continuing after we have named it.
 */
export const clearsFieldOn = (refusal: CallerKeyRefusal): boolean => refusal.reason === 'private'

/** Deck §7 — empty, error, refusal. */
export const GRANT_COPY = {
  emptyNoExport: {
    id: 'mkt.grant.empty.noexport',
    title: 'No agents are exportable',
    body:
      'Mark one in the agents list first. Callers can only be given agents you have already ' +
      'opened up.'
  },
  emptyNoCallers: {
    id: 'mkt.grant.empty.nocallers',
    title: 'Nobody can call your agents',
    body: 'That is the default, and it stays that way until you enrol someone.',
    action: 'ENROL A CALLER'
  },
  emptyNoGrants: {
    id: 'mkt.grant.empty.nogrants',
    text: '{name} is enrolled but can’t call anything yet.'
  },
  errorEnrol: {
    id: 'mkt.grant.error.enrol',
    text: 'Couldn’t enrol {name} — nothing was granted and no key was stored.',
    action: 'RETRY'
  },
  // The direction split. See the header note — this is the pair that matters.
  errorCommitAdd: {
    id: 'mkt.grant.error.commit.add',
    text: 'Couldn’t save those grants — {name} was not given anything.',
    action: 'RETRY'
  },
  errorCommitRemove: {
    id: 'mkt.grant.error.commit.remove',
    text:
      'Couldn’t remove those grants — {name} still has access. Try again, or ' +
      'un-export the agents to cut it off now.',
    action: 'RETRY'
  },
  errorRevoke: {
    id: 'mkt.grant.error.revoke',
    // The frightening half FIRST. A soft failure on a revoke is the one error
    // in this surface where a reassuring tone would be a lie with consequences.
    text:
      'Couldn’t revoke {name} — they still have access. Try again, or un-export ' +
      'the agents to cut it off now.',
    action: 'RETRY'
  },
  confirmUnexport: {
    id: 'mkt.grant.confirm.unexport',
    title: 'Stop exporting {agent}?',
    body: '{n} callers can call it today and will lose access immediately.',
    action: 'STOP EXPORTING'
  }
} as const

/** Fill {name}/{agent}/{n} without pulling in a template library. */
export function fill(text: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (out, [key, value]) => out.split(`{${key}}`).join(String(value)),
    text
  )
}

/**
 * The revoke line — the binding ruling, rendered (deck §6, §9).
 *
 * "Any call in progress stops." is not softened when nothing is running: the
 * sentence describes what the control DOES, and an owner who reads it while
 * idle is learning what will happen next time. What does change is the toast
 * afterwards, which reports what actually happened.
 */
export const REVOKE_COPY = {
  line: '{name} can’t call your agents. Any call in progress stops.',
  /** After the fact, and specific — "stopped 2 calls" is the answer they wanted. */
  stopped: (n: number): string =>
    n === 0
      ? 'No calls were running.'
      : `Stopped ${n} call${n === 1 ? '' : 's'} that ${n === 1 ? 'was' : 'were'} running.`,
  undo: 'UNDO'
} as const

/** How long the UNDO toast stands (deck §6). */
export const UNDO_WINDOW_MS = 10_000

/**
 * THE EXPORT STORY — the fear nobody answers (Velvet's vocabulary audit, §6).
 *
 * Her finding, and it is the one that makes this control an entry point rather
 * than a setting: exporting is safe by construction — a call forks the
 * transcript and a version pin marks the cut, so the original session is never
 * mutated — and version-pin.ts opens with exactly that sentence. IT IS A CODE
 * COMMENT. IT HAS NEVER BEEN SAID TO AN AUTHOR.
 *
 * That is the number-one reason not to export, it is already true, and stating
 * it costs nothing. So her sentence goes on the surface verbatim, at the moment
 * the author is deciding, rather than in a panel they would have to already
 * trust us enough to open.
 */
export const EXPORT_COPY = {
  /**
   * Sentence 6 — READ FROM VELVET'S FILE, not transcribed beside it.
   *
   * This was a hand-copy until her marketplace-copy.ts landed with the keyed
   * originals. The two were character-identical, which is exactly why the
   * duplicate had to go: a copy that agrees today is a copy that drifts the
   * first time she edits hers, and nothing would fail when it did. One source,
   * one diff away from the person who wrote it — the rule this file's own
   * header states, applied to itself.
   */
  safety: MKT_EXPORT['mkt.export.safety'],

  /**
   * Access, legible AT REST (her §6 again), in her words and her keys.
   *
   * 'Not exportable' is MINE and stays local: her pair answers "who can call
   * this" for an agent that IS exportable, and there is no key for the state
   * before that decision because her audit predates this control existing.
   * Flagged for her, rather than filed under a key of hers that does not exist.
   */
  atRest: (callers: number, exportable: boolean): string =>
    !exportable
      ? 'Not exportable'
      : callers === 0
        ? MKT_EXPORT['mkt.export.access.none']
        : // ONE DEVIATION FROM HER FILE, DELIBERATE AND FLAGGED.
          // 'mkt.export.access.some' is '{n} callers' — always plural — so a
          // single caller reads "1 callers". Her file has no singular key,
          // which is a gap rather than a decision: this line is read at rest
          // by an author glancing at a row, and "1 callers" is exactly the
          // unpolish a first-time reader notices and we do not.
          //
          // Reported to her rather than silently rewritten. Until she adds a
          // key, the singular is produced HERE and the plural still comes from
          // her string, so her edit continues to reach this surface.
          callers === 1
          ? '1 caller'
          : fill(MKT_EXPORT['mkt.export.access.some'], { n: callers }),

  /** The control itself. An invitation when off, a fact when on. */
  turnOn: 'Let people call this agent',
  turnOff: 'Stop exporting',
  onHint: 'Exportable — nobody can call it until you grant someone.',
  next: 'WHO CAN CALL →',

  /**
   * THE HONEST SEAM (Chief's scope stop).
   *
   * Grant is this lane; PUBLISH — price, payout address, push to the registry —
   * is a lane nobody has been assigned yet. Magpie's audit found zero of forty
   * controls mentioning publish or sell, and the fix for that is NOT a button
   * here that opens nothing. So the surface says what does not exist rather
   * than implying it does: an author who reads this knows where they are, and
   * an author who reads a dead "Publish…" control learns we are unreliable.
   *
   * Velvet's scrub line — "Cookrew strips secrets and folder paths before
   * anything is published, and shows you the report first" — belongs to that
   * lane and is deliberately NOT shown here. Exporting publishes nothing, so
   * promising a scrub report at this control would be a string whose behaviour
   * does not exist, which is the defect this program keeps finding.
   */
  publishSeam:
    'Selling this — a price, a payout address, a listing others can find — isn’t built yet.'
} as const

/**
 * When the export toggle itself fails.
 *
 * DERIVED FROM VELVET'S RULE, NOT INVENTED BESIDE IT — flagged for her sign-off
 * because she owns copy. Her deck has no string for this control (it predates
 * the toggle being an entry point), but §7 states the principle plainly and it
 * applies unchanged: the same failure means opposite things depending on which
 * way the owner was moving.
 *
 * Turning export ON and failing is a nuisance — nothing was opened up, and the
 * reassuring phrasing is the true one. Turning it OFF and failing means the
 * agent IS STILL REACHABLE and whoever could call it still can, which is the
 * fact that has to come first. Same event, two strings.
 *
 * A silent failure is the one option ruled out. A control that does nothing and
 * says nothing reads as broken, and the author's next move is to press it
 * again.
 */
export const EXPORT_ERROR = {
  on: {
    id: 'mkt.grant.error.exportable.on',
    text: 'Couldn’t make {agent} exportable — nothing was opened up.'
  },
  off: {
    id: 'mkt.grant.error.exportable.off',
    // The frightening half first, the same shape as the revoke failure.
    text:
      'Couldn’t stop exporting {agent} — it is still exportable and anyone you ' +
      'granted can still call it. Try again.'
  }
} as const
