import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from 'react'
import type { BrowserNodeData, TerminalNodeData } from '../../shared/model'
import { isRemoteMode } from './api'
import { useLodLayout } from './zoom-lod'
/**
 * THE TERMINAL OVERLAY IS A CHUNK OF ITS OWN. It carries xterm and its addons
 * (WebGL, fit, clipboard, serialize) — a third of the bundle for a surface a
 * phone reaches only by zooming into a terminal. Through the relay every byte
 * of the boot crosses two hops, so it is fetched the first time a terminal is
 * actually zoomed, and not at all on a canvas that is only looked at (perf
 * lane L7). The layer is mounted only while some terminal is active; before
 * that the primary is reported as null directly.
 */
const TerminalOverlayLayer = lazy(() =>
  import('./TerminalOverlay').then((m) => ({ default: m.TerminalOverlayLayer }))
)
import { BrowserLayer, type InteractiveBrowserCapability } from './BrowserLayer'

/**
 * The one component that watches the viewport every frame.
 *
 * useLodLayout subscribes to the React Flow viewport, so whatever calls it
 * re-renders on every animation frame. That used to be Canvas itself — the
 * whole app tree — and a Canvas render is not cheap: its inline callbacks
 * give React Flow's node renderer new props, which re-renders every visible
 * card, and the browser layer re-renders every offscreen-hosted browser view.
 * All of it on the thread the zoom animation is running on. Measured on the
 * owner's canvas: three 40–90ms stalls inside the 280ms zoom-to-card, the
 * animation's completion promise firing 120–250ms late, and the full view
 * mounting at 400–530ms instead of ~300 (scratchpad/zoom-latency).
 *
 * Moving the subscription here confines the per-frame render to this leaf.
 * The two layers under it are memoised and receive the same `lod` object
 * until the arbitration actually changes (zoom-lod sameLayout), so a frame
 * that changes nothing costs one small render and two bail-outs.
 *
 * Canvas still needs the winner — for the dock's browser target and to hide
 * the clipboard bar under a full view — and gets it by callback from a LAYOUT
 * effect, so Canvas re-renders inside the same commit and no painted frame
 * shows the stale winner.
 *
 * Two invariants, both load-bearing and both invisible by construction:
 *   - NOT memoised. Canvas sets the refs below and starts the animation
 *     without rendering; this component must re-render whenever Canvas does
 *     (any state change) OR the viewport moves, and a memo would remove the
 *     first of those. That is what guarantees the phone's pinned full view
 *     releases the moment zoomBack clears the refs.
 *   - NOT conditionally mounted. The one-shot arrival bypass is tracked here
 *     while `arrivedId` lives in Canvas; an unmount would re-arm the bypass
 *     without clearing arrivedId — the shape of the 2026-08-27 remount loop.
 */
interface LodOverlaysProps {
  terminals: TerminalNodeData[]
  browsers: BrowserNodeData[]
  /**
   * Refs, not values, on purpose: zoomToNode sets them and starts the
   * animation without a Canvas render, and this component reads them fresh on
   * the viewport frames that follow — the same moments the old Canvas-level
   * call read them.
   */
  deliberateOpen: MutableRefObject<boolean>
  focused: MutableRefObject<string | null>
  arrivedId: string | null
  /** The one-shot arrival bypass has been used up; Canvas clears arrivedId. */
  onArrivalConsumed: () => void
  /** The shared winner (terminal OR browser), reported to Canvas. */
  onPrimaryChange: (id: string | null) => void
  /** The zoomed TERMINAL — the dock composer's target. */
  onPrimaryTerminalChange: (id: string | null) => void
  onThumb: (id: string, dataUrl: string) => void
  isPhoneViewing: (browserId: string) => boolean
  interactiveCapability: InteractiveBrowserCapability | null
}

export function LodOverlays({
  terminals,
  browsers,
  deliberateOpen,
  focused,
  arrivedId,
  onArrivalConsumed,
  onPrimaryChange,
  onPrimaryTerminalChange,
  onThumb,
  isPhoneViewing,
  interactiveCapability
}: LodOverlaysProps): React.JSX.Element {
  // ONE shared overlay arbitration across terminals AND browsers — per-kind
  // instances each picked their own remote fullscreen winner, stacking a
  // browser view over the zoomed terminal (Magpie E2 HIGH 2).
  const overlayNodes = useMemo(() => [...terminals, ...browsers], [terminals, browsers])
  // Desktop always allows the passive coverage-open (zoom into a card to open
  // it). On a phone only a deliberate tap opens one — see deliberateOpenRef in
  // App. The zoomed card is passed through so the arbiter can honour the
  // user's choice: geometry alone cannot tell the card they tapped from a card
  // that happens to be big, which is how the full view ended up on a card off
  // in the corner while the focused one filled the stage.
  const lod = useLodLayout(
    overlayNodes,
    !isRemoteMode() || deliberateOpen.current,
    focused.current,
    arrivedId
  )

  // Layout effect, not passive: a passive one runs after paint, and that one
  // frame would show the clipboard bar over a fresh full view and the dock in
  // the wrong state on a browser open. Winner changes are rare, so the
  // synchronous Canvas re-render costs nothing on the per-frame path.
  useLayoutEffect(() => {
    onPrimaryChange(lod.primaryId)
  }, [lod.primaryId, onPrimaryChange])

  // The arrival bypass is ONE-SHOT: once the arrived card has actually held
  // primary and then lost it, the bypass must not re-admit it on the very
  // next render after a drop — that zero-cooldown remount was the loop engine
  // (Pilot's phone-crash hunt, 2026-08-27, section 2). Consumption is tracked
  // so a slow first admission can't burn the bypass before it ever lands: the
  // clear fires only after primaryId has EQUALLED arrivedId at least once.
  const arrivalConsumedRef = useRef(false)
  useEffect(() => {
    if (arrivedId === null) {
      arrivalConsumedRef.current = false
      return
    }
    if (lod.primaryId === arrivedId) {
      arrivalConsumedRef.current = true
      return
    }
    if (arrivalConsumedRef.current) {
      arrivalConsumedRef.current = false
      onArrivalConsumed()
    }
  }, [lod.primaryId, arrivedId, onArrivalConsumed])

  const anyTerminalActive = terminals.some((t) => lod.activeIds.has(t.id) && lod.rects[t.id])
  useEffect(() => {
    if (!anyTerminalActive) onPrimaryTerminalChange?.(null)
  }, [anyTerminalActive, onPrimaryTerminalChange])
  return (
    <>
      {anyTerminalActive && (
        <Suspense fallback={null}>
          <TerminalOverlayLayer
            terminals={terminals}
            lod={lod}
            onPrimaryChange={onPrimaryTerminalChange}
          />
        </Suspense>
      )}
      <BrowserLayer
        browsers={browsers}
        lod={lod}
        onThumb={onThumb}
        isPhoneViewing={isPhoneViewing}
        interactiveCapability={interactiveCapability}
      />
    </>
  )
}
