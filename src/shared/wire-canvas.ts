import type { NoteNodeData, WorkspaceState } from './model'

/**
 * THE FIRST FRAME OF A WORKSPACE SWITCH — the canvas, minus the reading.
 *
 * Switching workspace from the phone delivers the whole canvas in one SSE
 * frame. Measured on the owner's machine (2026-09-28): 722 KB raw, 280 KB
 * gzipped, and 82% of it NOTE BODIES — 584 KB of markdown across 75 notes,
 * two of which hold 242 KB between them. Over the relay that is the wait.
 *
 * NONE OF IT IS DRAWN when it lands. A note renders as a mini tile until it
 * is zoomed to a readable size — "a note's content is a full design doc, and
 * mounting 28 of those markdown DOM trees at the fit-to-view overview is what
 * OOMs a phone" (NoteNode.tsx). So the reader is waiting on bytes that will
 * not be looked at, to see a canvas that does not need them.
 *
 * So a switch sends the canvas TWICE: once light, which is what the canvas is
 * drawn from, and once whole a beat behind it, so nothing is missing and no
 * client has to ask for anything. The client already handles repeated
 * workspace frames — it reconciles them — so the second is a no-op except for
 * the bodies it fills in.
 *
 * ONLY ON A SWITCH. Every other canvas change sends one frame exactly as
 * before: two-framing a card drag would double the traffic of moving a card.
 *
 * A LIGHTENED NOTE SAYS SO, in `contentBytes` — the whole length, beside a
 * body shorter than it. Nothing has to infer it from a truncation, and
 * nothing may write over a note it only half has (`noteIsWhole`; NoteNode
 * refuses to edit one).
 */

/**
 * How much of a note the light frame carries.
 *
 * Enough to be the card's opening lines and the board row's excerpt, so the
 * light canvas is not visibly poorer than the full one at the size anything
 * is actually read at; small enough that the giants stop dominating the
 * frame. At this head the measured switch frame falls from 280 KB gzipped to
 * about 53 KB.
 */
export const NOTE_WIRE_HEAD = 512

/** Does this note carry its whole body? A note nobody cut always does. */
export function noteIsWhole(note: Pick<NoteNodeData, 'content' | 'contentBytes'>): boolean {
  return typeof note.contentBytes !== 'number' || note.content.length >= note.contentBytes
}

/**
 * The canvas with its long note bodies cut to a head, or NULL when there was
 * nothing to cut — a caller that gets null sends one frame, because two
 * identical copies of a canvas help nobody.
 *
 * Never mutates: the full frame follows this one and must still be full.
 */
export function lightenCanvas(state: WorkspaceState, head = NOTE_WIRE_HEAD): WorkspaceState | null {
  let cut = false
  const nodes = state.nodes.map((node) => {
    if (node.kind !== 'note') return node
    const note = node as NoteNodeData
    const content = note.content ?? ''
    if (content.length <= head) return node
    cut = true
    return { ...note, content: content.slice(0, head), contentBytes: content.length }
  })
  return cut ? { ...state, nodes } : null
}
