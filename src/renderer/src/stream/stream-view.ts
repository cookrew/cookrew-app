// ONE RENDERING PATH FOR LIVE AND REPLAY (one-stream v2, panel C "视图 v2").
//
// The rule the compare doc states outright: live and replay go through the
// SAME rendering code, distinguished ONLY by a source flag, and the view never
// parses a file. So a block becomes a view model here — once — whether it
// arrived in `/stream/open`, in a page the drawer fetched, or as a `tail`
// event off the live subscription. There is no "live turn" shape and no
// "checkpoint" shape to keep in step, because there is one shape.
//
// WHAT THE FLAG IS FOR. Not appearance — appearance is identical by
// construction. It gates SIDE EFFECTS: a page fetched because someone
// scrolled up must not steal the scroll position or announce itself, while
// the same block arriving as the open tail should. Suppression is stated as a
// predicate rather than scattered as `if (!fetching)` at each effect, because
// the last time it was scattered a far jump auto-scrolled itself back to the
// bottom halfway through landing.

import { checkpointViewModel, type TurnViewModel } from '../turn-view-model'
import type { StreamBlock, StreamMarks, StreamRenderSource, StreamTail } from './stream-types'

/**
 * Where a block sits in time: the OPEN tail is live, everything else — every
 * closed exchange, however recently it closed — is replay.
 *
 * The tail block that has SETTLED (final) is replay too. That is deliberate:
 * once a turn is finished, re-rendering it because a mark changed must not
 * re-fire whatever the arrival of a live turn fires.
 */
export function renderSourceOf(block: StreamBlock, tail: StreamTail | null): StreamRenderSource {
  if (tail === null || tail.block === null) return 'replay'
  return tail.block.id === block.id && !tail.final ? 'live' : 'replay'
}

/**
 * May this block's arrival move the view (auto-scroll) or make a noise?
 *
 * Only for a live tail. Everything a person fetched by scrolling is theirs to
 * look at, and moving it under them is the failure this predicate exists to
 * make impossible to reintroduce by accident.
 */
export function mayFireSideEffects(source: StreamRenderSource): boolean {
  return source === 'live'
}

/**
 * A stream block → the SAME view model a live turn binds to.
 *
 * The title comes from the MARK, not from the block: a Sous title is
 * attached to an identity and is not part of the conversation, which is the
 * whole reason marks exist as a side record.
 */
export function streamBlockViewModel(
  block: StreamBlock | null,
  marks?: StreamMarks
): TurnViewModel | null {
  if (block === null) return null
  return checkpointViewModel({
    prompt: block.prompt,
    reply: block.reply,
    ...(marks?.title !== undefined ? { title: marks.title } : {})
  })
}
