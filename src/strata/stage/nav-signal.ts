// Did the browser already animate this history step (motion.html §6)? The iOS
// edge swipe and Chrome's gesture navigation slide a snapshot themselves; a
// flight after that would play the move twice. The stage does not own history
// (the levels part does), so it only listens. Installed at import time, before
// any component's popstate listener, so the flag is set by the time React
// renders the new path.

/** A touch that began this close to the left edge is the OS's back swipe, not ours. */
const EDGE_PX = 20
const EDGE_WINDOW_MS = 600
const HINT_TTL_MS = 1500

let animatedHref: string | null = null
let animatedAt = -Infinity
let edgeTouch = false
let edgeTouchEndedAt = -Infinity

const now = () => (typeof performance === 'undefined' ? Date.now() : performance.now())

if (typeof window !== 'undefined') {
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
      // Typed as always there, but older Safari has no such field: feature-detect.
      const ua: boolean | undefined = 'hasUAVisualTransition' in e ? e.hasUAVisualTransition : undefined
      const edge = edgeTouch || now() - edgeTouchEndedAt < EDGE_WINDOW_MS
      if (ua === true || (ua === undefined && edge)) {
        animatedHref = location.href
        animatedAt = now()
      }
    },
    { capture: true }
  )
}

/** True while the URL is still the one a browser-animated popstate brought. Pure read: safe in render. */
export const browserAnimatedNow = (): boolean =>
  typeof location !== 'undefined' && animatedHref === location.href && now() - animatedAt < HINT_TTL_MS
