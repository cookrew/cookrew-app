import type { ScrubReport } from './preset-manifest'

/**
 * THE REVIEW LIST — one truth, for the author and for the buyer.
 *
 * The author's walk (step 3) rules that the author's review sheet and the
 * buyer's review show THE SAME LIST. This is that list, computed once.
 *
 * WHY A SHARED FUNCTION AND NOT SHARED CHROME. The build note says the author's
 * sheet "reuses the install-review chrome", and it cannot: the buyer-facing page
 * at registry/src/install-page.ts is server-rendered, inert HTML in a different
 * process, and it deliberately REFUSES to be a review sheet — "a registry page
 * showing them would be asking to be believed about its own bytes, which is the
 * trust the whole signing design refuses to require" (A5). Copying its markup
 * would not achieve one truth anyway; it would produce two renderings that
 * agree today and drift the first time either is edited, with nothing failing
 * when they do. That is the species this program keeps finding.
 *
 * So the truth shared is the DATA. Both surfaces compute their rows here and
 * render them in their own chrome, and a row added for one appears in the other
 * without anybody remembering to mirror it.
 *
 * NO PROSE IN THIS FILE. The row values are facts — counts, flags, a verdict —
 * and the sentences are Velvet's. She has `mkt.review.blocked.*` for the
 * blocking states but no keys for these six rows yet; reported to her, and the
 * ids below are what those keys should hang off. A surface that needs a
 * sentence today writes its own and is visibly doing so, rather than this file
 * inventing a second voice next to hers.
 */

/** Stable ids — the copy keys hang off these, and both surfaces order by them. */
export type ReviewRowId = 'team' | 'paths' | 'commands' | 'notes' | 'urls' | 'scan' | 'signature'

export interface ReviewRow {
  id: ReviewRowId
  /**
   * The fact this row states. A count, or a verdict word.
   *
   * `null` means the row has no number to show and is a statement of kind —
   * paths are always rewritten, a signature is present or the package is not
   * publishable — so a surface must not render "null" as "0".
   */
  value: number | string | null
  /**
   * True when this row STOPS the walk on the side that is reading it.
   *
   * The author is blocked from signing; the buyer is blocked from installing.
   * Same row, same fact, and the demo is explicit that a dirty scan "blocks
   * here, loudly, on the AUTHOR's side of the wire" — the refusal lands on the
   * person who can fix it, which is the same rule as the payout checksum.
   */
  blocking: boolean
}

/** Which side is reading. The lists are identical except where noted. */
export type ReviewSide = 'author' | 'buyer'

export interface ReviewInput {
  scrub: ScrubReport
  /** Agents in the package — the TEAM row's count. */
  agents: number
  /** Whether the package carries a signature at all. */
  signed: boolean
}

/**
 * The rows, in order, for one side.
 *
 * THE TWO SIDES DIFFER IN EXACTLY ONE PLACE and it is worth stating why the
 * rest do not. Every other row is a fact about the package: how many agents,
 * how many paths were rewritten, whether the scan came back clean. Those cannot
 * legitimately differ — an author who sees "clean" and a buyer who sees
 * something else means one of them is being lied to, which is the failure the
 * one-truth rule exists to prevent.
 *
 * The signature row differs because the ACT differs: the author is signing, the
 * buyer is verifying. Same fact, opposite verbs, and a shared sentence there
 * would be wrong for both.
 */
export function reviewRows(input: ReviewInput, side: ReviewSide): ReviewRow[] {
  const { scrub } = input
  // A dirty scan stops the author from signing. It cannot stop a buyer for the
  // same reason it must stop an author: by the time a buyer sees a package, a
  // dirty one was never publishable — so a buyer meeting `blocked` here is
  // meeting a package that disagrees with its own report, which is
  // mkt.review.blocked.report_mismatch and not this row's business.
  const dirty = scrub.secretScan === 'blocked'
  return [
    { id: 'team', value: input.agents, blocking: false },
    { id: 'paths', value: null, blocking: false },
    { id: 'commands', value: scrub.commands, blocking: false },
    { id: 'notes', value: scrub.notes, blocking: false },
    { id: 'urls', value: scrub.urls, blocking: false },
    { id: 'scan', value: scrub.secretScan, blocking: side === 'author' && dirty },
    {
      id: 'signature',
      value: input.signed ? 'signed' : 'unsigned',
      // An unsigned package stops both sides, for different reasons that reach
      // the same place: the author has nothing to publish, the buyer has
      // nothing to verify.
      blocking: !input.signed
    }
  ]
}

/**
 * Do the two sides agree about the package?
 *
 * Exported so the disagreement is CHECKABLE rather than assumed. One truth is a
 * claim, and a claim nobody tests is the kind of guarantee this program keeps
 * finding to be decorative.
 */
export function sidesAgree(input: ReviewInput): boolean {
  const author = reviewRows(input, 'author')
  const buyer = reviewRows(input, 'buyer')
  return author.every((row, at) => {
    const other = buyer[at]
    if (row.id !== other.id || row.value !== other.value) return false
    // The signature row is the one legitimate difference, and only in whether
    // it blocks — never in the fact it states.
    return row.id === 'scan' || row.blocking === other.blocking
  })
}

/**
 * WHAT IS NOT IN THIS LIST, and why saying so is part of the design.
 *
 * The demo's line — "Your conversations are not in this list because they are
 * never in the package" — is doing real work: an author scanning a list of what
 * leaves the machine is looking for the thing they are afraid of, and its
 * absence from a list reads as an omission unless the absence is stated. The
 * sentence is Velvet's to write; this constant is here so a surface cannot
 * quietly drop the reassurance while keeping the list.
 */
export const REVIEW_OMITS_CONVERSATIONS = true
