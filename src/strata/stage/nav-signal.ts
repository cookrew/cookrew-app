// Did the browser already animate this history step (motion.html §6)? The iOS
// edge swipe and Chrome's gesture navigation slide a snapshot themselves; a
// flight after that would play the move twice. The stage does not own history
// (the levels part does), so it only listens. Installed at import time, before
// any component's popstate listener, so the flag is set by the time React
// renders the new path.

/** A touch that began this close to the left edge is the OS's back swipe, not ours. */
const EDGE_PX = 20
const EDGE_WINDOW_MS = 600
/** A press, a key or the embed's strata:out this recently means the page itself asked for the Back. */
const INTENT_WINDOW_MS = 800
const HINT_TTL_MS = 1500

export interface PopFacts {
  /** PopStateEvent.hasUAVisualTransition; undefined where the browser does not report it (older Safari). */
  ua: boolean | undefined
  /** A coarse pointer (a phone or tablet): the platform owns an edge swipe that is Back. */
  coarse: boolean
  /** ms since a touch that began at the left edge ended (Infinity: none seen). */
  sinceEdgeTouch: number
  /** ms since the page itself showed intent: pointer-down, key-down, or the embed's strata:out (Infinity: none). */
  sinceIntent: number
}

/**
 * Did the browser already animate this pop? The browser's own flag wins. Without
 * it, an edge touch we saw counts, and so does a pop on a coarse pointer that
 * nothing in the page asked for: the platform edge swipe over the terminal's
 * embed happens inside the iframe, where this document sees no touch at all.
 * The failure mode is chosen on purpose: a missed flight is a cut, a wrong
 * flight is the move played twice.
 */
export const judgePop = (f: PopFacts): boolean => {
  if (f.ua !== undefined) return f.ua
  if (f.sinceEdgeTouch < EDGE_WINDOW_MS) return true
  return f.coarse && f.sinceIntent >= INTENT_WINDOW_MS
}

let animatedHref: string | null = null
let animatedAt = -Infinity
let edgeTouch = false
let edgeTouchEndedAt = -Infinity
let intentAt = -Infinity

const now = () => (typeof performance === 'undefined' ? Date.now() : performance.now())

if (typeof window !== 'undefined') {
  const intent = () => {
    intentAt = now()
  }
  window.addEventListener('pointerdown', intent, { capture: true, passive: true })
  window.addEventListener('keydown', intent, { capture: true, passive: true })
  window.addEventListener('message', (e) => {
    if (e.origin === location.origin && (e.data as { type?: unknown } | null)?.type === 'strata:out') intent()
  })
  window.addEventListener(
    'touchstart',
    (e) => {
      edgeTouch = e.touches.length === 1 && e.touches[0].clientX <= EDGE_PX
    },
    { capture: true, passive: true }
  )
  const end = () => {
    if (edgeTouch) edgeTouchEndedAt = now()
    edgeTouch = false
  }
  window.addEventListener('touchend', end, { capture: true, passive: true })
  window.addEventListener('touchcancel', end, { capture: true, passive: true })
  window.addEventListener(
    'popstate',
    (e) => {
      const t = now()
      const animated = judgePop({
        // Typed as always there, but older Safari has no such field: feature-detect.
        ua: 'hasUAVisualTransition' in e ? e.hasUAVisualTransition : undefined,
        coarse: matchMedia('(pointer: coarse)').matches,
        sinceEdgeTouch: edgeTouch ? 0 : t - edgeTouchEndedAt,
        sinceIntent: t - intentAt
      })
      if (animated) {
        animatedHref = location.href
        animatedAt = t
      }
    },
    { capture: true }
  )
}

/** True while the URL is still the one a browser-animated popstate brought. Pure read: safe in render. */
export const browserAnimatedNow = (): boolean =>
  typeof location !== 'undefined' && animatedHref === location.href && now() - animatedAt < HINT_TTL_MS
