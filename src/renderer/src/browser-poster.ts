import { decodeBase64 } from './base64'
import type { KeyedStore } from './keyed-store'

/**
 * THE LAST PICTURE YOU SAW IS THE PICTURE THE CARD KEEPS.
 *
 * A browser card has two pictures and, until this, no handover between them.
 * Zoomed in, the live screencast paints frames; zoomed out, the card shows
 * whatever the thumbnail poll last put in the store — minutes old, or nothing
 * at all if the poll was skipped (every card at mini), backed off (no engine
 * yet) or impossible (the relay carries no WebSocket, and over it the poll is
 * all there is). The frame the owner was looking at a second ago was thrown
 * away at the exact moment it became the best picture of that page anyone
 * had.
 *
 * Three rules, and none of them fetches anything:
 *
 *   POSTER. While the live view has no decoded frame — connecting, stalled,
 *   or unavailable — the zoomed surface shows the card's stored picture under
 *   the status chip, the way a <video> shows its poster. Over the relay that
 *   is the difference between the page and a black box reading UNAVAILABLE.
 *
 *   HAND-OFF. On the zoom-out edge the last PAINTED live frame becomes the
 *   card's thumbnail. Once, at the edge, never per frame: the screencast runs
 *   at up to 12 fps and the store notifies the card on every set.
 *
 *   AS A BLOB. A live frame is a data: URL; the store holds blob: URLs so the
 *   browser keeps decoded bytes rather than base64 strings in JS memory —
 *   the phone's ceiling, which is why the poll path decodes the same way.
 *   One decode at the edge, the previous blob revoked.
 */

/** Which picture the zoomed surface shows: the live frame, else the poster, else nothing. */
export function posterSource(input: {
  streaming: boolean
  frameUrl: string | null
  poster: string | undefined
}): string | null {
  // A frame left in state from the socket's last life is not the stream's to
  // show once it is no longer streaming; the poster is the honest picture.
  if (input.streaming) return input.frameUrl
  return input.poster ?? null
}

/** The zoom-out edge, and only when there is a painted frame to hand over. */
export function shouldHandOff(input: { wasOpen: boolean; open: boolean; painted: boolean }): boolean {
  return input.wasOpen && !input.open && input.painted
}

const DATA_URL = /^data:(image\/[a-z+.-]+);base64,(.*)$/s

/**
 * Hand a live frame to the card: decoded once into a blob URL, the previous
 * blob revoked. A frame that is already a URL is kept as it is; one that will
 * not decode leaves the store exactly as it was — a card that keeps its last
 * good picture beats one that loses it to a bad frame.
 */
export function handOffFrame(store: KeyedStore<string>, id: string, frameUrl: string): void {
  const match = DATA_URL.exec(frameUrl)
  let next = frameUrl
  if (match) {
    try {
      next = URL.createObjectURL(new Blob([decodeBase64(match[2])], { type: match[1] }))
    } catch {
      return
    }
  }
  const old = store.get(id)
  if (old?.startsWith('blob:') && old !== next) URL.revokeObjectURL(old)
  store.set(id, next)
}
