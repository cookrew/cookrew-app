import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TeamMeta } from '../../shared/model'
import { WorkspaceCreateSheet, type CreateRequest } from './WorkspaceCreateSheet'
import {
  NEW_WORKSPACE_ID,
  flipOnto,
  openingPick,
  stepPick,
  wallView,
  withNewScreen,
  type DOMRectLike,
  type Snapshot,
  type WallScreen,
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
 * THE WALL IS THE WHOLE SWITCHER NOW. The dropdown it replaced was also where
 * a workspace was made, given directories, or removed, and where the activity
 * history lived — so those are here: an action strip under the picked
 * screen, and an empty NEW screen at the end of the row that opens the
 * create sheet. One chip in the header, one surface behind it.
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
 *
 * ON A PHONE the same wall answers to a thumb: a swipe anywhere — across the
 * screens, not just the floor — pans the row, a tap on a neighbour picks it,
 * a tap on the picked screen opens it, and the HUD says so instead of naming
 * keys the phone has not got.
 */

/** Long enough to read as a turn, short enough not to be a wait. */
const SQUARE_MS = 140
const FLIP_MS = 300
const FADE_MS = 130
/** A pointer that travels further than this is a swipe, not a tap. */
const SWIPE_PX = 6

export type WallSheet = 'create' | null

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
  /** The dropdown's jobs. */
  onCreate: (request: CreateRequest) => void
  onDirectories: (id: string) => void
  onRemove: (id: string) => void
  /** The activity history — a property of the live workspace, so one button. */
  onActivity?: () => void
  /** False with one workspace left: there must always be somewhere to stand. */
  canRemove?: boolean
  /** Saved teams the create sheet offers as templates. */
  teams?: readonly TeamMeta[]
  canPickDir?: boolean
  pickDir?: () => Promise<string | null>
  /** A coarse pointer (a thumb). Detected when not given. */
  touch?: boolean
  /** Test seam: the clock the age stamps are read against. */
  now?: number
  /** Test seams: open on a given screen, or with a sheet already up. */
  initialPick?: number
  initialSheet?: WallSheet
}

/** A thumb, not a mouse — decided once, and never at module load (tests render without a window). */
function coarsePointer(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  )
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
  onCreate,
  onDirectories,
  onRemove,
  onActivity,
  canRemove = true,
  teams = [],
  canPickDir = false,
  pickDir,
  touch,
  now,
  initialPick,
  initialSheet = null,
}: WorkspaceWallProps): React.JSX.Element | null {
  // INITIALISED, not corrected by an effect. Starting at 0 and letting the
  // open-effect move it renders one frame with the wrong screen facing you —
  // a visible flash of the composition this deliberately avoids.
  const [pick, setPick] = useState(() => initialPick ?? openingPick(workspaces.length))
  const [leaving, setLeaving] = useState<string | null>(null)
  const [sheet, setSheet] = useState<WallSheet>(initialSheet)
  const [confirming, setConfirming] = useState<string | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; pick: number; moved: boolean } | null>(null)
  /** Set by a swipe's release, read by the click that follows it. */
  const swiped = useRef(false)
  const detected = useMemo(coarsePointer, [])
  const thumb = touch ?? detected

  const faces = useMemo(() => withNewScreen(workspaces), [workspaces])
  const view = useMemo(
    () =>
      wallView({
        workspaces: faces,
        recent,
        activeId,
        pick,
        width: stage?.width ?? 1200,
        height: stage?.height,
        shots,
        now: now ?? Date.now(),
      }),
    [faces, recent, activeId, pick, stage?.width, stage?.height, shots, now]
  )

  // OPENS ON THE PREVIOUS WORKSPACE — see `openingPick`. Landing on the one
  // you are already in makes the first key a correction, and leaves the whole
  // left half of the wall empty every time. Counted over the REAL workspaces:
  // a wall of one plus NEW opens on the one, never on NEW.
  useEffect(() => {
    if (!open) return
    setPick(initialPick ?? openingPick(workspaces.length))
    // Only when the wall opens: re-running this on every pick would pin it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaces.length])
  // The sheet and the REMOVE question reset on OPEN alone — not when the list
  // changes under an open wall, or another device making a workspace would
  // close the sheet somebody here is typing into.
  useEffect(() => {
    if (!open) return
    setLeaving(null)
    setSheet(initialSheet)
    setConfirming(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const count = view.screens.length
  const picked = view.picked
  const liveDir = workspaces.find((w) => w.id === activeId)?.dir ?? ''

  /**
   * THE HANDOFF. Square up, measure both rects, carry the snapshot onto the
   * canvas, and let the workspace mount underneath while it is covered.
   */
  const enter = useCallback(
    (id: string) => {
      if (leaving !== null) return
      if (id === NEW_WORKSPACE_ID) {
        setSheet('create')
        return
      }
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
      // A sheet up owns the keyboard: its inputs take Enter, its own listener
      // takes Escape. The wall waits.
      if (leaving !== null || sheet !== null) return
      if (event.key === 'ArrowRight' || (event.key === 'Tab' && !event.shiftKey)) {
        event.preventDefault()
        setPick((at) => stepPick(at, count, 1))
      } else if (event.key === 'ArrowLeft' || (event.key === 'Tab' && event.shiftKey)) {
        event.preventDefault()
        setPick((at) => stepPick(at, count, -1))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        if (picked) enter(picked.id)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    // Capture, so a focused terminal does not eat the arrows this surface owns
    // for as long as it is up.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, count, picked, enter, onClose, leaving, sheet])

  // The pick moved: whatever REMOVE was asking about is no longer in front.
  useEffect(() => {
    setConfirming(null)
  }, [pick])

  /**
   * ONE SWIPE SURFACE, AND IT IS THE WHOLE WALL. The floor alone was not
   * enough: on a phone the screens fill the width, so a thumb always lands on
   * one, and a swipe that started on a screen has to pan the row just the
   * same. Handled at the root, where every screen's pointer events arrive —
   * except a press on a button or in the sheet, which is theirs.
   */
  const onPointerDown = (event: React.PointerEvent): void => {
    // Whatever click the last swipe's release produced has fired by now; a
    // pan that ended on the floor produces none, and must not eat this tap.
    swiped.current = false
    if (leaving !== null) return
    if ((event.target as Element).closest('button, input, .cr-wsw-sheet')) return
    drag.current = { x: event.clientX, pick, moved: false }
  }
  const onPointerMove = (event: React.PointerEvent): void => {
    const from = drag.current
    if (!from) return
    // A mouse released outside the wall never told us; the button is up, so
    // this hover is not a drag.
    if (event.pointerType === 'mouse' && event.buttons === 0) {
      drag.current = null
      return
    }
    const dx = from.x - event.clientX
    if (!from.moved && Math.abs(dx) > SWIPE_PX) drag.current = { ...from, moved: true }
    const step = Math.max(90, view.tier.stepA * 0.7)
    const next = Math.max(0, Math.min(count - 1, from.pick + Math.round(dx / step)))
    if (next !== pick) setPick(next)
  }
  const onPointerEnd = (): void => {
    swiped.current = drag.current?.moved ?? false
    drag.current = null
  }
  /** A tap is a click; the click after a swipe is the swipe's release, not a choice. */
  const tapped = (): boolean => {
    if (!swiped.current) return true
    swiped.current = false
    return false
  }

  // No workspace at all is nothing to draw — not a wall of one NEW screen.
  if (!open || workspaces.length === 0) return null

  const { tier } = view
  return (
    <div
      className={`cr-wsw${leaving ? ' cr-wsw-leaving' : ''}${thumb ? ' cr-wsw-touch' : ''}`}
      style={{
        perspective: `${tier.perspective}px`,
        ...(stage
          ? { left: stage.left, top: stage.top, width: stage.width, height: stage.height }
          : {}),
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Switch workspace"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onPointerLeave={onPointerEnd}
    >
      {/* Lights down. A cream canvas only reads as a LIT SCREEN in a dark
          room; without this the wall is a stack of paper again. */}
      <div className="cr-wsw-wash" onClick={() => tapped() && onClose()} />
      <div className="cr-wsw-track" ref={trackRef}>
        {view.screens.map((screen) => (
          <div
            key={screen.id}
            data-ws={screen.id}
            className={`cr-wsw-screen${screen.picked ? ' pick' : ''}${screen.live ? ' live' : ''}${screen.kind === 'new' ? ' new' : ''}`}
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
              if (!tapped() || leaving !== null) return
              if (screen.picked) enter(screen.id)
              else setPick(view.screens.indexOf(screen))
            }}
          >
            <div className="cr-wsw-bezel">
              <div className="cr-wsw-glass">
                {screen.kind === 'new' ? (
                  // Where a workspace gets made. Says so, in the same voice as
                  // a screen with no picture, because it is one.
                  <span className="cr-wsw-blank cr-wsw-plus">
                    <b>+</b>
                    NEW WORKSPACE
                  </span>
                ) : screen.snapshot.src ? (
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
      {picked && sheet === null && (
        <WallActions
          screen={picked}
          canRemove={canRemove}
          confirming={confirming === picked.id}
          onOpen={() => enter(picked.id)}
          onDirectories={() => onDirectories(picked.id)}
          onAskRemove={() => setConfirming(picked.id)}
          onRemove={() => {
            setConfirming(null)
            onRemove(picked.id)
          }}
          onActivity={onActivity}
        />
      )}
      <p className="cr-wsw-hud">
        {thumb ? (
          <>SWIPE TO LOOK · TAP TO OPEN</>
        ) : (
          <>
            <kbd>←</kbd> <kbd>→</kbd> PICK · <kbd>ENTER</kbd> OPEN · <kbd>ESC</kbd> CANCEL
          </>
        )}
      </p>
      {sheet === 'create' && (
        <div className="cr-wsw-sheet">
          <WorkspaceCreateSheet
            defaultDir={liveDir}
            teams={teams}
            canPickDir={canPickDir}
            pickDir={pickDir ?? (async () => null)}
            onCreate={(request) => {
              setSheet(null)
              onCreate(request)
            }}
            onCancel={() => setSheet(null)}
          />
        </div>
      )}
    </div>
  )
}

/**
 * The strip under the picked screen: what can be done to THIS one. The
 * dropdown's per-row buttons, with the confirmation the dropdown had —
 * REMOVE asks once, in place, and the answer is a second press.
 */
function WallActions({
  screen,
  canRemove,
  confirming,
  onOpen,
  onDirectories,
  onAskRemove,
  onRemove,
  onActivity,
}: {
  screen: WallScreen
  canRemove: boolean
  confirming: boolean
  onOpen: () => void
  onDirectories: () => void
  onAskRemove: () => void
  onRemove: () => void
  onActivity?: () => void
}): React.JSX.Element {
  if (screen.kind === 'new') {
    return (
      <div className="cr-wsw-actions">
        <button type="button" className="primary" onClick={onOpen}>
          CREATE…
        </button>
      </div>
    )
  }
  return (
    <div className="cr-wsw-actions">
      <button type="button" className="primary" onClick={onOpen}>
        {screen.live ? 'BACK' : 'OPEN'}
      </button>
      <button type="button" title="Manage this workspace's directories" onClick={onDirectories}>
        DIRECTORIES
      </button>
      {confirming ? (
        <button type="button" className="danger" title="Yes, remove it" onClick={onRemove}>
          REMOVE? YES
        </button>
      ) : (
        <button
          type="button"
          disabled={!canRemove}
          title={canRemove ? 'Remove this workspace' : 'Cannot remove the last workspace'}
          onClick={onAskRemove}
        >
          REMOVE
        </button>
      )}
      {onActivity && (
        <button type="button" title="Activity and history" onClick={onActivity}>
          HISTORY
        </button>
      )}
    </div>
  )
}
