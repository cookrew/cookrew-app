import type { Box } from './face-flip'

/**
 * WHERE THE FOLDED FACE'S TIP STANDS (owner design 2026-11-04, "Nobody
 * selected. The shipped bar, the ＋ face at its end. Hover: click, or press
 * Enter."): above the face, its right edge on the face's (the face ends the
 * bar), never under the cursor: the gap clears the face and its 5px touch
 * ring. Kept on the screen; below the face only where the top has no room.
 */

/** Face to tip: past the 5px ring round the face that a pointer on it may be in. */
export const TIP_GAP = 12
/** Never closer than this to the screen's edges. */
export const TIP_MARGIN = 8

export interface TipPlace {
  readonly left: number
  readonly top: number
  readonly side: 'above' | 'below'
}

export function tipPlace(
  face: Box,
  tip: { readonly width: number; readonly height: number },
  view: { readonly width: number; readonly height: number }
): TipPlace {
  const right = face.left + face.width
  const left = Math.max(TIP_MARGIN, Math.min(right - tip.width, view.width - TIP_MARGIN - tip.width))
  const above = face.top - TIP_GAP - tip.height
  if (above >= TIP_MARGIN) return { left, top: above, side: 'above' }
  return { left, top: face.top + face.height + TIP_GAP, side: 'below' }
}
