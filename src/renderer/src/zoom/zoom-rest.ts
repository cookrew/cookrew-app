/**
 * THE LAYERS RIDE THE MOTION ONLY (owner's screenshots, 2026-11-01: parts of
 * the crew missing, the device view's marks blank).
 *
 * `will-change: transform` tells Chromium a layer's scale is about to move,
 * so it keeps the sharpest raster it has made of it. A dive to the card
 * magnifies the wash and every part, and back at the crew they still held
 * tiles at that size: in the demo the renderer's tile memory went from 14 MB
 * to 358 MB over one round of the stops, and once it runs out Chromium leaves
 * holes — an avatar here, a name there, a band of the page without its paint.
 *
 * So the root carries `data-moving` while the frame loop runs, and a moment
 * after it settles the flag goes (zoom.css drops every hint without it): at
 * rest each part is drawn at the scale it is shown, and no old tile is kept.
 * The moment of grace keeps a click's snap (use-zoom-motion · go) from
 * dropping and rebuilding the layers between two legs of one move.
 */
export const REST_MS = 400

export interface RestFlag {
  /** A frame of motion: the hints are on. */
  moving(): void
  /** The loop settled: the hints go after REST_MS, unless it moves again first. */
  settled(): void
  dispose(): void
}

export function createRestFlag(root: () => HTMLElement | null, wait = REST_MS): RestFlag {
  let timer: ReturnType<typeof setTimeout> | null = null
  const stop = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return {
    moving() {
      stop()
      const el = root()
      if (el && el.dataset.moving !== 'true') el.dataset.moving = 'true'
    },
    settled() {
      if (timer) return
      const el = root()
      if (!el || el.dataset.moving === undefined) return
      timer = setTimeout(() => {
        timer = null
        delete root()?.dataset.moving
      }, wait)
    },
    dispose: stop
  }
}
