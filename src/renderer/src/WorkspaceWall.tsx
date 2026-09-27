import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  flipOnto,
  openingPick,
  stepPick,
  wallView,
  type DOMRectLike,
  type Snapshot,
  type WorkspaceFace,
} from './workspace-wall-store'
import './workspace-wall.css'

/**
 * THE SCREEN WALL — pick a workspace by looking at it.
 *
 * Switching used to be a dropdown of names, and a name is the one thing about
 * a workspace nobody remembers. People know "the one with three agents and a
 * browser on the right", so the wall puts that on screen: each workspace is a
 * tilted screen carrying a snapshot of its canvas, and you pick the picture.
 *
 * NOTHING HERE IS LIVE. Every screen is one <img>; no workspace but the
 * current one is ever mounted. That is the whole reason this is affordable —
 * a wall of real canvases would be N ReactFlow instances at once.
 *
 * WHERE IT DECIDES NOTHING: every number — offset, depth, angle, which screen
 * reflects, how old each picture is — comes from workspace-wall-store.ts and
 * is asserted without a DOM. This file sets the values it is handed.
 *
 * THE HANDOFF IS THE POINT. Entering does not cut to the canvas: the chosen
 * screen squares up, then a FLIP carries it exactly onto the canvas viewport
 * while the real workspace mounts underneath it, hidden. Switching rebuilds a
 * canvas and its PTYs, and that 300ms is where the cost is spent. If the
 * rebuild outlasts the animation the snapshot STAYS — a held picture is
 * honest, a cut to an empty canvas is not.
 */

/** Long enough to read as a turn, short enough not to be a wait. */
const SQUARE_MS = 140
const FLIP_MS = 300
const FADE_MS = 130

export interface WorkspaceWallProps {
  open: boolean
  workspaces: readonly WorkspaceFace[]
  activeId: string
  /** Ids newest-first; the wall opens on the live one and orders by recency. */
  recent: readonly string[]
  shots: Readonly<Record<string, Snapshot>>
  /** The canvas area this wall covers and hands back to. */
  stage: DOMRectLike | null
  onEnter: (id: string) => void
  onClose: () => void
  /** Test seam: the clock the age stamps are read against. */
  now?: number
}

export function WorkspaceWall({
  open,
  workspaces,
  activeId,
  recent,
  shots,
  stage,
  onEnter,
  onClose,
  now,
}: WorkspaceWallProps): React.JSX.Element | null {
  // INITIALISED, not corrected by an effect. Starting at 0 and letting the
  // open-effect move it renders one frame with the wrong screen facing you —
  // a visible flash of the composition this deliberately avoids.
  const [pick, setPick] = useState(() => openingPick(workspaces.length))
  const [leaving, setLeaving] = useState<string | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; pick: number } | null>(null)
  /** Did the gesture that is ending move? A tap must not be read as a swipe. */
  const dragged = useRef(false)

  const view = useMemo(
    () =>
      wallView({
        workspaces,
        recent,
        activeId,
        pick,
        width: stage?.width ?? 1200,
        shots,
        now: now ?? Date.now(),
      }),
    [workspaces, recent, activeId, pick, stage?.width, shots, now]
  )

  // OPENS ON THE PREVIOUS WORKSPACE — see `openingPick`. Landing on the one
  // you are already in makes the first key a correction, and leaves the whole
  // left half of the wall empty every time.
  useEffect(() => {
    if (!open) return
    setPick(openingPick(workspaces.length))
    setLeaving(null)
    // Only when the wall opens: re-running this on every pick would pin it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaces.length])

  const count = view.screens.length

  /**
   * THE HANDOFF. Square up, measure both rects, carry the snapshot onto the
   * canvas, and let the workspace mount underneath while it is covered.
   */
  const enter = useCallback(
    (id: string) => {
      if (leaving !== null) return
      setLeaving(id)
      const el = trackRef.current?.querySelector<HTMLElement>(`[data-ws="${CSS.escape(id)}"]`)
      if (!el || !stage) {
        onEnter(id)
        return
      }
      el.style.willChange = 'transform'
      el.style.transform = 'translateX(0px) translateZ(0px) rotateY(0deg) scale(1)'
      window.setTimeout(() => {
        const from = el.getBoundingClientRect()
        el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(.22,.72,.24,1), opacity ${FADE_MS}ms ease ${FLIP_MS}ms`
        el.style.transform = flipOnto(from, stage)
        el.classList.add('cr-wsw-landing')
        // The workspace mounts NOW, under a snapshot that covers it entirely.
        onEnter(id)
        window.setTimeout(() => {
          el.style.opacity = '0'
          window.setTimeout(() => {
            el.style.willChange = ''
            onClose()
          }, FADE_MS)
        }, FLIP_MS)
      }, SQUARE_MS)
    },
    [leaving, stage, onEnter, onClose]
  )

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (leaving !== null) return
      if (event.key === 'ArrowRight' || (event.key === 'Tab' && !event.shiftKey)) {
        event.preventDefault()
        setPick((at) => stepPick(at, count, 1))
      } else if (event.key === 'ArrowLeft' || (event.key === 'Tab' && event.shiftKey)) {
        event.preventDefault()
        setPick((at) => stepPick(at, count, -1))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        const chosen = view.picked
        if (chosen) enter(chosen.id)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    // Capture, so a focused terminal does not eat the arrows this surface owns
    // for as long as it is up.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, count, view.picked, enter, onClose, leaving])

  if (!open || count === 0) return null

  const { tier } = view
  return (
    <div
      className={`cr-wsw${leaving ? ' cr-wsw-leaving' : ''}`}
      /**
       * THE DRAG LIVES ON THE ROOT, not on a surface of its own.
       *
       * It WAS its own absolutely-positioned layer at `z-index:1`, and that
       * layer covered every screen: `.cr-wsw-track` carries
       * `transform-style:preserve-3d`, which establishes a stacking context,
       * so the screens' z-indexes are LOCAL to it and the track itself sits at
       * `auto`. One layer at 1 therefore painted over all of them, and tapping
       * a screen did nothing — on the phone AND on the desktop, where it went
       * unnoticed because the chip and the keyboard both worked.
       *
       * On the root the pointer reaches the screens first and their own
       * handlers run; a drag is recognised by MOVEMENT instead of by owning a
       * layer, and a tap that never moved is left alone to become a click.
       */
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, pick }
      }}
      onPointerMove={(e) => {
        const from = drag.current
        if (!from) return
        const step = Math.max(90, tier.stepA * 0.7)
        const moved = Math.round((from.x - e.clientX) / step)
        if (moved !== 0) dragged.current = true
        const next = Math.max(0, Math.min(count - 1, from.pick + moved))
        if (next !== pick) setPick(next)
      }}
      onPointerUp={() => {
        drag.current = null
        // Cleared after the click that follows this release has had its turn.
        window.setTimeout(() => {
          dragged.current = false
        }, 0)
      }}
      style={{
        perspective: `${tier.perspective}px`,
        ...(stage
          ? { left: stage.left, top: stage.top, width: stage.width, height: stage.height }
          : {}),
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Switch workspace"
    >
      {/* Lights down. A cream canvas only reads as a LIT SCREEN in a dark
          room; without this the wall is a stack of paper again. */}
      <div
        className="cr-wsw-wash"
        onClick={() => {
          if (!dragged.current) onClose()
        }}
      />
      <div className="cr-wsw-track" ref={trackRef}>
        {view.screens.map((screen) => (
          <div
            key={screen.id}
            data-ws={screen.id}
            className={`cr-wsw-screen${screen.picked ? ' pick' : ''}${screen.live ? ' live' : ''}`}
            style={{
              width: tier.screen.width,
              height: tier.screen.height,
              margin: `${-tier.screen.height / 2}px 0 0 ${-tier.screen.width / 2}px`,
              transform: screen.transform,
              zIndex: screen.zIndex,
              opacity: screen.opacity,
              // A screen past the visible depth is not merely transparent: it
              // must not swallow a click meant for the one in front of it.
              pointerEvents: screen.opacity === 0 ? 'none' : 'auto',
            }}
            onClick={() => {
              // A swipe ends over some screen; entering it would turn every
              // pan into a workspace switch.
              if (dragged.current) return
              if (screen.picked) enter(screen.id)
              else setPick(view.screens.indexOf(screen))
            }}
          >
            <div className="cr-wsw-bezel">
              <div className="cr-wsw-glass">
                {screen.snapshot.src ? (
                  <img src={screen.snapshot.src} alt="" draggable={false} />
                ) : (
                  // Never been left, so never photographed. Says so rather
                  // than showing a blank that reads as a broken image.
                  <span className="cr-wsw-blank">NO SNAPSHOT YET</span>
                )}
              </div>
              {screen.age && <span className="cr-wsw-stamp">{screen.age}</span>}
              <div className="cr-wsw-sheen" />
              <div className="cr-wsw-shade" style={{ opacity: screen.shade }} />
            </div>
            {screen.mirror && screen.snapshot.src && (
              <div className="cr-wsw-mirror" aria-hidden="true">
                <img src={screen.snapshot.src} alt="" draggable={false} />
              </div>
            )}
            <div className="cr-wsw-label">
              <b>
                {screen.icon} {screen.name}
              </b>
              <span>
                {screen.dir}
                {screen.live ? ' · here now' : ''}
              </span>
            </div>
          </div>
        ))}
      </div>
      <p className="cr-wsw-hud">
        <kbd>←</kbd> <kbd>→</kbd> PICK · <kbd>ENTER</kbd> OPEN · <kbd>ESC</kbd> CANCEL
      </p>
    </div>
  )
}
