/**
 * Semantic-zoom rules for terminal cards. Pure arithmetic, no React — the
 * card subscribes to these through the flow store, so they have to be cheap
 * and quantized (see cardTypeScale).
 */

/** Below this zoom the card degrades to a minimal tile (dot + name). */
export const MINI_ZOOM = 0.28

/**
 * How long the zoom-to-card animation runs.
 *
 * Was 500ms, which put a floor under how fast a card could go live: the full
 * renderer only mounts once the viewport stops, so the animation is dead time
 * you cannot use the card during. 280ms still reads as motion rather than a
 * cut, and is the one number to change if it wants retuning.
 *
 * The overview fits (zoom OUT to the whole canvas) keep their own longer
 * duration — they traverse the entire workspace, not one card, and there is
 * nothing waiting to mount at the end of them.
 */
export const CARD_ZOOM_MS = 280

/**
 * Padding fitView/fitBounds leaves around a card zoomed to the stage: NONE.
 *
 * Zero is not a taste call, it is forced by the layout. Cards sit on a grid
 * whose vertical pitch EQUALS the card height — 560 tall, 560 apart — so a card
 * and the one below it share an edge with no gutter between them. Any padding
 * at all is therefore filled by the neighbour: the old 0.02 left 7px of slack
 * on a 1400x760 stage, and what rendered in those 7px was the next card's
 * header ("not zoomed in enough to show exactly the chosen card fullview").
 *
 * At 0 the card meets the stage edge to edge on its limiting axis, which puts
 * the neighbour exactly out of frame. It stays a contain-fit, so no part of the
 * chosen card is ever cropped to achieve that. See tests/zoom-fit.test.ts.
 */
export const CARD_FIT_PADDING = 0

/** Zoom at which card type reaches its designed size and stops growing. */
export const NATURAL_ZOOM = 0.95

/**
 * A card has two renderings and no more: the summary card, and the mini tile
 * it degrades to when the whole canvas is in view. Zooming past natural size
 * no longer swaps the body — the live terminal takes over as an LOD overlay
 * (TerminalOverlay.tsx) once the card covers the stage.
 */
export type CardZoomMode = 'card' | 'mini'

export function cardZoomMode(zoom: number): CardZoomMode {
  return zoom >= MINI_ZOOM ? 'card' : 'mini'
}

/**
 * Inverse type scale, quantized to 1/8 steps so cards don't re-render on
 * every animation frame while zooming — only when crossing a bucket.
 */
export function cardTypeScale(zoom: number): number {
  if (zoom >= NATURAL_ZOOM) return 1
  const inv = 1 / Math.max(zoom, 0.12)
  return Math.round(inv * 8) / 8
}
