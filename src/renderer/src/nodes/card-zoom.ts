/**
 * Semantic-zoom rules for terminal cards. Pure arithmetic, no React — the
 * card subscribes to these through the flow store, so they have to be cheap
 * and quantized (see cardTypeScale).
 */

/** Below this zoom the card degrades to a minimal tile (dot + name). */
export const MINI_ZOOM = 0.28

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
