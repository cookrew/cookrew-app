import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { cardPlacement, clampSpot, nameTagSpot, petClick, petHome, readSpot, type PetSpot } from './pet-pick'
import { CONTENT_FRAMES, MORPH_EASE, MORPH_MS, morphFrames } from './pet-morph'
import { CARD_PARTS, FACE_PARTS, FULL_PARTS, findParts, pageZoomEnv, waitFor, zoomStep } from './pet-zoom'
import { dockedSpot, nearDock, sheetBox, type Box } from './pet-dock'
import './pets.css'

/**
 * ONE TROOP OF PETS, WHATEVER IT CARRIES (AgentPets.tsx, ItemPets.tsx).
 *
 * Round faces in a pill that floats over every page: the agents on the right,
 * the browsers and notes on the left. Both behave the same, so they are one
 * component, in three steps (the owner's sketch, 2026-10-31): rest a pointer
 * on a face and it grows into a pill with its name; click it and its card
 * opens beside it (the synopsis, and for an agent a box to prompt it); click
 * it again and it opens in full. A finger has no hover, so on a phone the
 * first tap is the card. Drag the troop anywhere and it remembers; the grip
 * tucks it into one coin; the "+N" coin shows everyone else. A card stays
 * until a tap outside (unless it holds a draft), Escape or its ×.
 *
 * They stand in columns, the agents down the right, the browsers and notes
 * down the left, in the gutters the stage keeps clear for them, so they cover
 * nothing until they are dragged.
 *
 * With a full view up they ATTACH to its panel (pet-dock.ts): each column
 * stands beside the sheet, centred on it, and moves with it. Dragged off, the
 * troop floats where it is put; dragged back to the panel's side, it snaps on.
 */

const DRAG_PX = 5
/** The glide between floating and attached, as long as the demo's step into the full view. */
const DOCK_MS = 420

const boxOf = (rect: DOMRect): Box => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })

/** The full view on screen, its sheet, and the lanes the attached troops take beside it (zoom/full-views.css). */
const fullViewNow = (): { full: Box; sheet: Box } | null => {
  const el = document.querySelector<HTMLElement>('.zv-fullview')
  if (!el) return null
  const full = boxOf(el.getBoundingClientRect())
  if (full.width <= 0 || full.height <= 0) return null
  const style = getComputedStyle(el)
  const lane = (name: string): number => Number.parseFloat(style.getPropertyValue(name)) || 0
  return { full, sheet: sheetBox(full, { left: lane('--fv-lane-left'), right: lane('--fv-lane-right') }) }
}

export interface TroopMember {
  readonly id: string
  /** Its look: `cr-pet <className>`. */
  readonly className: string
  /** What a screen reader says: name and state. */
  readonly label: string
  /** What the face says when a pointer rests on it. */
  readonly name: string
  readonly face: React.ReactNode
}

/** What a card's content may do to its frame. */
export interface CardControls {
  /** The draft, so a tap outside does not throw it away. */
  readonly draft: (text: string) => void
  readonly open: () => void
  readonly close: () => void
}

const stored = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}
const store = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Private mode: the troop forgets where it sat, and that is all.
  }
}

/** The bed's height above the window's bottom: where the stage ends. */
const bedGap = (): number => {
  const stage = document.querySelector('.cr-stage')
  return stage ? window.innerHeight - stage.getBoundingClientRect().bottom : 0
}

export function PetTroop({
  side,
  storageKey,
  label,
  members,
  more,
  onOpen,
  onShown,
  cardClass,
  cardLabel = () => '',
  renderCard,
  onCard,
  dockable = false
}: {
  side: 'left' | 'right'
  /** Where it remembers its spot and whether it is tucked. */
  storageKey: string
  label: string
  members: readonly TroopMember[]
  more: readonly TroopMember[]
  onOpen: (id: string) => void
  /** The faces on screen, for whoever feeds them pictures. */
  onShown?: (ids: readonly string[]) => void
  cardClass?: (id: string) => string
  cardLabel?: (id: string) => string
  /** The troop's own card for a face; absent when the card lives elsewhere (onCard). */
  renderCard?: (id: string, controls: CardControls) => React.ReactNode
  /**
   * A face's card is not the troop's to draw: a click hands it here (the
   * agents: the zoom view opens ITS card, the one instance, zoom-store · openCard).
   */
  onCard?: (id: string) => void
  /** A full view is up: the troop may attach to its panel (pet-dock.ts). */
  dockable?: boolean
}): React.JSX.Element | null {
  const spotKey = `${storageKey}.spot`
  const tuckedKey = `${storageKey}.tucked`
  const attachedKey = `${storageKey}.attached`
  const [openId, setOpenId] = useState<string | null>(null)
  /** The card shrinking back into its face (pet-morph.ts); gone when the morph ends. */
  const [leavingId, setLeavingId] = useState<string | null>(null)
  /** The card a semantic zoom grew (pet-zoom.ts): its frame plays no grow of its own. */
  const [zoomedId, setZoomedId] = useState<string | null>(null)
  const openRef = useRef<string | null>(null)
  openRef.current = openId
  /** The face a pointer (or the keyboard) rests on: it shows its name. */
  const [hoverId, setHoverId] = useState<string | null>(null)
  /** Where that face's name tag is pinned on the screen, read from the face when it is named. */
  const [tagSpot, setTagSpot] = useState<ReturnType<typeof nameTagSpot> | null>(null)
  const nameFace = (id: string, face: HTMLElement): void => {
    setTagSpot(nameTagSpot(face.getBoundingClientRect(), side, window.innerWidth))
    setHoverId(id)
  }
  const [expanded, setExpanded] = useState(false)
  const [tucked, setTucked] = useState(() => stored(tuckedKey) === '1')
  const [saved, setSaved] = useState<PetSpot | null>(() => readSpot(stored(spotKey)))
  const [home, setHome] = useState<PetSpot>(() => petHome(bedGap(), window.innerWidth))
  const spot = saved ?? home
  const troopRef = useRef<HTMLDivElement>(null)
  const petRefs = useRef(new Map<string, HTMLButtonElement>())
  const drag = useRef<{ x: number; y: number; spot: PetSpot; moved: boolean; id: number } | null>(null)
  /** Attached to the full view when one is up; a drag off the panel lets go, and that is remembered. */
  const [attached, setAttached] = useState(() => stored(attachedKey) !== '0')
  const docked = dockable && attached
  /** Where the attached column stands, measured off the full view (null until measured). */
  const [dockAt, setDockAt] = useState<{ left: number; top: number } | null>(null)
  /** A drag has brought the troop close enough to the panel to snap on when let go. */
  const [near, setNear] = useState(false)
  const swallowClick = useRef(false)
  const draft = useRef('')

  const shown = tucked ? members.slice(0, 1) : expanded ? [...members, ...more] : members
  const shownKey = shown.map((member) => member.id).join(' ')
  useEffect(() => {
    onShown?.(shownKey ? shownKey.split(' ') : [])
  }, [shownKey, onShown])

  const close = useCallback((): void => {
    draft.current = ''
    const id = openRef.current
    if (id) setLeavingId(id)
    setOpenId(null)
  }, [])

  // Home follows the stage (the dock comes and goes); a saved spot stays put,
  // kept on screen when the window shrinks or the phone turns.
  useEffect(() => {
    const keep = (): void => {
      setHome(petHome(bedGap(), window.innerWidth))
      const el = troopRef.current
      if (!el) return
      setSaved((at) => (at ? clampSpot(at, el.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }) : at))
    }
    keep()
    window.addEventListener('resize', keep)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(keep) : null
    const stage = document.querySelector('.cr-stage')
    if (ro && stage) ro.observe(stage)
    return () => {
      window.removeEventListener('resize', keep)
      ro?.disconnect()
    }
  }, [shown.length, tucked])

  // Attached: the column follows the sheet (it moves when the window, the
  // header or the dock does). The full view is a lazy chunk, so it is looked
  // for again until it is there.
  useLayoutEffect(() => {
    if (!docked) {
      setDockAt(null)
      return
    }
    let retry: ReturnType<typeof setTimeout> | null = null
    let ro: ResizeObserver | null = null
    let watching: Element | null = null
    const measure = (): void => {
      const view = fullViewNow()
      const el = troopRef.current
      if (!view || !el) {
        retry = setTimeout(measure, 120)
        return
      }
      const fullEl = document.querySelector('.zv-fullview')
      if (ro && fullEl && fullEl !== watching) {
        ro.observe(fullEl)
        watching = fullEl
      }
      const rect = el.getBoundingClientRect()
      const next = dockedSpot(side, view.full, view.sheet, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight })
      setDockAt((at) => (at && at.left === next.left && at.top === next.top ? at : next))
    }
    ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : null
    if (ro && troopRef.current) ro.observe(troopRef.current)
    measure()
    window.addEventListener('resize', measure)
    return () => {
      if (retry) clearTimeout(retry)
      ro?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [docked, side, shown.length])

  // The sheet makes room for an attached column (zoom/full-views.css reads this).
  useEffect(() => {
    if (!docked) return
    const name = `cr-docked-${side}`
    document.body.classList.add(name)
    return () => document.body.classList.remove(name)
  }, [docked, side])

  // THE GLIDE: between floating and attached each face travels from where it
  // was to where it stands now (FLIP: transform only), as the demo's crew
  // walks into its column. A face that was not there fades in. The faces are
  // measured only when the troop attaches or lets go — read here, while the
  // page still shows them where they were — never on every render.
  const glideFrom = useRef<Map<string, DOMRect> | null>(null)
  const wasDocked = useRef(docked)
  if (wasDocked.current !== docked) {
    wasDocked.current = docked
    const from = new Map<string, DOMRect>()
    for (const [id, el] of petRefs.current) from.set(id, el.getBoundingClientRect())
    glideFrom.current = from
  }
  useLayoutEffect(() => {
    const from = glideFrom.current
    if (!from || (docked && dockAt === null)) return
    glideFrom.current = null
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    for (const [id, el] of petRefs.current) {
      const was = from.get(id)
      const now = el.getBoundingClientRect()
      if (!was) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DOCK_MS / 2, easing: 'ease-out' })
        continue
      }
      const dx = was.left - now.left
      const dy = was.top - now.top
      if (Math.abs(dx) + Math.abs(dy) > 1) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: DOCK_MS, easing: MORPH_EASE })
    }
  }, [docked, dockAt])

  useEffect(() => {
    if (!openId) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (!target || troopRef.current?.contains(target) || document.querySelector('.cr-pet-card:not(.leaving)')?.contains(target)) return
      if (draft.current.trim().length > 0) return
      close()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [openId, close])

  if (members.length === 0) return null

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    drag.current = { x: event.clientX, y: event.clientY, spot, moved: false, id: event.pointerId }
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const at = drag.current
    if (!at || at.id !== event.pointerId) return
    const dx = event.clientX - at.x
    const dy = event.clientY - at.y
    if (!at.moved && Math.hypot(dx, dy) < DRAG_PX) return
    if (!at.moved) {
      at.moved = true
      setHoverId(null)
      close()
      event.currentTarget.setPointerCapture(event.pointerId)
      // Off the panel: the troop floats from where it stood in its column.
      const el = troopRef.current
      if (docked && el) {
        const rect = el.getBoundingClientRect()
        at.spot = { x: side === 'right' ? window.innerWidth - rect.right : rect.left, bottom: window.innerHeight - rect.bottom }
        setSaved(at.spot)
        setAttached(false)
      }
    }
    const el = troopRef.current
    if (!el) return
    const x = side === 'right' ? at.spot.x - dx : at.spot.x + dx
    setSaved(clampSpot({ x, bottom: at.spot.bottom - dy }, el.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }))
    if (dockable) {
      const view = fullViewNow()
      setNear(view !== null && nearDock(side, boxOf(el.getBoundingClientRect()), view.full, view.sheet))
    }
  }
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const at = drag.current
    drag.current = null
    if (!at?.moved) return
    swallowClick.current = true
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const el = troopRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const x = side === 'right' ? window.innerWidth - rect.right : rect.left
    store(spotKey, JSON.stringify({ x: Math.round(x), bottom: Math.round(window.innerHeight - rect.bottom) }))
    // Let go by the panel's side: it snaps on. Anywhere else: it floats there.
    if (dockable) {
      const view = fullViewNow()
      const snap = view !== null && nearDock(side, boxOf(rect), view.full, view.sheet)
      setNear(false)
      setAttached(snap)
      store(attachedKey, snap ? '1' : '0')
    }
  }
  /** A press that was the end of a drag is not a click. */
  const consumed = (): boolean => {
    if (!swallowClick.current) return false
    swallowClick.current = false
    return true
  }

  const clickPet = (id: string): void => {
    if (consumed()) return
    if (tucked) {
      setTucked(false)
      store(tuckedKey, '0')
      return
    }
    // The card lives elsewhere: hand the click over, draw nothing here.
    if (onCard) {
      onCard(id)
      return
    }
    // Once: its card. Again, on the same face: in full. Each step is a
    // semantic zoom (pet-zoom.ts) where the browser can draw one.
    if (petClick(openId, id) === 'full') {
      zoomToFull(id)
      return
    }
    draft.current = ''
    const face = petRefs.current.get(id) ?? null
    const zoomed = zoomStep(pageZoomEnv(), {
      from: findParts(face, FACE_PARTS, true),
      update: () =>
        flushSync(() => {
          // The card this face left goes at once; the zoom draws the change.
          setLeavingId(null)
          setZoomedId(id)
          setOpenId(id)
        }),
      to: () => findParts(document.querySelector('.cr-pet-card:not(.leaving)'), CARD_PARTS, true)
    })
    if (zoomed) return
    setZoomedId(null)
    // Another face's card shrinks home while this one grows; the same face
    // clicked mid-shrink grows straight back (PetCardFrame reverses).
    if (openId && openId !== id) setLeavingId(openId)
    else if (leavingId === id) setLeavingId(null)
    setOpenId(id)
  }
  /** The card zooms into the full view: it becomes the stage's middle, its turn the transcript, its name the route's. */
  const zoomToFull = (id: string): void => {
    const card = document.querySelector('.cr-pet-card:not(.leaving)')
    const zoomed = zoomStep(pageZoomEnv(), {
      from: findParts(card, CARD_PARTS, true),
      update: async () => {
        flushSync(() => {
          draft.current = ''
          setOpenId(null)
          setLeavingId(null)
          onOpen(id)
        })
        // The stage first, then the route's agent: the name and the face land there.
        await waitFor(
          () =>
            document.querySelector('.cr-stage-main > .stg-item-pane') !== null ||
            (document.querySelector('.cr-stage-main > .cr-stage-term') !== null && document.querySelector('.cr-route-agent .cr-route-here') !== null)
        )
      },
      to: () => findParts(document, FULL_PARTS, false)
    })
    if (zoomed) return
    close()
    onOpen(id)
  }
  const tuck = (): void => {
    if (consumed()) return
    const next = !tucked
    setTucked(next)
    setExpanded(false)
    close()
    store(tuckedKey, next ? '1' : '0')
  }
  const toggleMore = (): void => {
    if (consumed()) return
    setExpanded((on) => !on)
  }

  const hidden = more.length + (tucked ? members.length - 1 : 0)
  const anchor = openId ? (petRefs.current.get(openId) ?? null) : null
  const controls: CardControls = {
    draft: (text) => void (draft.current = text),
    open: () => {
      if (openId) zoomToFull(openId)
    },
    close
  }
  const grip = (
    <button type="button" className="cr-pets-grip" title={tucked ? `Show the ${label}` : `Tuck the ${label} away (drag to move)`} aria-label={tucked ? `Show the ${label}` : `Tuck the ${label} away`} onClick={tuck}>
      <span aria-hidden="true">⋮⋮</span>
    </button>
  )

  return createPortal(
    <>
      <div
        ref={troopRef}
        className={`cr-pets ${side}${tucked ? ' tucked' : ''}${expanded ? ' expanded' : ''}${docked ? ' docked' : ''}${near ? ' snap' : ''}`}
        style={
          docked && dockAt
            ? { left: dockAt.left, top: dockAt.top }
            : side === 'right'
              ? { right: spot.x, bottom: spot.bottom }
              : { left: spot.x, bottom: spot.bottom }
        }
        role="toolbar"
        aria-label={label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null
          setNear(false)
        }}
      >
        {grip}
        {shown.map((member) => (
          <button
            key={member.id}
            ref={(el) => {
              if (el) petRefs.current.set(member.id, el)
              else petRefs.current.delete(member.id)
            }}
            type="button"
            className={`cr-pet ${member.className}${openId === member.id ? ' open' : ''}${hoverId === member.id && !tucked ? ' named' : ''}`}
            aria-label={member.label}
            aria-expanded={openId === member.id}
            onPointerEnter={(event) => {
              if (event.pointerType !== 'mouse' || tucked || drag.current?.moved) return
              nameFace(member.id, event.currentTarget)
            }}
            onPointerLeave={() => setHoverId((at) => (at === member.id ? null : at))}
            // The keyboard names a face as a pointer does; Enter is its click.
            onFocus={(event) => !tucked && event.currentTarget.matches(':focus-visible') && nameFace(member.id, event.currentTarget)}
            onBlur={() => setHoverId((at) => (at === member.id ? null : at))}
            onClick={() => clickPet(member.id)}
          >
            {member.face}
            {!tucked && (
              // Pinned to the screen (position: fixed) so neither the troop's scroll nor its edge cuts it.
              <span className="cr-pet-name" aria-hidden="true" style={hoverId === member.id && tagSpot ? { position: 'fixed', ...tagSpot } : undefined}>
                {member.name}
              </span>
            )}
            {tucked && hidden > 0 && <span className="cr-pet-count">{hidden + 1}</span>}
          </button>
        ))}
        {!tucked && more.length > 0 && (
          <button type="button" className="cr-pet more" title={expanded ? 'Fewer' : `${more.length} more`} onClick={toggleMore}>
            {expanded ? '–' : `+${more.length}`}
          </button>
        )}
      </div>
      {/* ONE keyed list, so a card going from open to leaving is the same
          card mid-morph, never a fresh one mounted unplaced. */}
      {[...(leavingId && leavingId !== openId ? [leavingId] : []), ...(openId && anchor ? [openId] : [])].map((id) => (
        <PetCardFrame
          key={id}
          anchor={petRefs.current.get(id) ?? null}
          side={side}
          className={cardClass?.(id) ?? ''}
          label={cardLabel(id)}
          leaving={id !== openId}
          zoomed={id === zoomedId && id === openId}
          onGone={() => setLeavingId((at) => (at === id ? null : at))}
        >
          {renderCard?.(id, controls)}
        </PetCardFrame>
      ))}
    </>,
    document.body
  )
}

/** Where a card sits, beside its face (pet-pick.ts · cardPlacement), and how it gets there: out of the face. */
function PetCardFrame({
  anchor,
  side,
  className,
  label,
  leaving = false,
  zoomed = false,
  onGone,
  children
}: {
  anchor: HTMLElement | null
  side: 'left' | 'right'
  className: string
  label: string
  /** Shrinking back into the face; onGone when the morph has ended. */
  leaving?: boolean
  /** A semantic zoom drew its arrival (pet-zoom.ts): no grow of its own. */
  zoomed?: boolean
  onGone?: () => void
  children: React.ReactNode
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const morph = useRef<Animation[]>([])
  const grown = useRef(false)
  // Read at the END of a morph, not when it began: a card closed mid-grow
  // must not snap back to full size for a frame before it goes.
  const leavingRef = useRef(leaving)
  leavingRef.current = leaving
  const goneRef = useRef(onGone)
  goneRef.current = onGone
  useLayoutEffect(() => {
    const card = ref.current
    if (!card || !anchor) return
    const measure = (): void => {
      const a = anchor.getBoundingClientRect()
      const c = card.getBoundingClientRect()
      const next = cardPlacement(a, { width: c.width, height: c.height }, { width: window.innerWidth, height: window.innerHeight }, side)
      // Only a real move is news: a fresh object every measure would re-run
      // the morph effect for nothing (and once looped the whole app).
      setPlace((at) => (at && at.left === next.left && at.top === next.top ? at : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(card)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [anchor, side])

  // GROW, once, on the first frame the card has its place: drawn as the
  // face, it becomes the card before the first paint shows anything else.
  // SHRINK when it leaves: the same frames backwards, and gone at the end.
  // A face clicked mid-shrink turns the running morph around.
  useLayoutEffect(() => {
    const card = ref.current
    if (!card || !place) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const running = morph.current.filter((one) => one.playState === 'running')
    if (running.length > 0) {
      const forward = (running[0].effect?.getTiming().direction ?? 'normal') === 'normal'
      if (forward === leaving) for (const one of running) one.reverse()
      return
    }
    if (leaving) {
      if (reduced || !anchor || !anchor.isConnected) {
        goneRef.current?.()
        return
      }
    } else if (grown.current || reduced || !anchor || zoomed) {
      grown.current = true
      return
    }
    grown.current = true
    const face = anchor.getBoundingClientRect()
    const box = { left: place.left, top: place.top, width: card.offsetWidth, height: card.offsetHeight }
    const radius = getComputedStyle(card).borderRadius || '14px'
    const timing: KeyframeAnimationOptions = { duration: MORPH_MS, easing: MORPH_EASE, direction: leaving ? 'reverse' : 'normal', fill: 'both' }
    const shell = card.animate(morphFrames(face, box, radius), timing)
    const inner = [...card.children].map((child) => child.animate(CONTENT_FRAMES, { ...timing, easing: 'linear' }))
    morph.current = [shell, ...inner]
    void shell.finished.then(
      () => {
        if (leavingRef.current) goneRef.current?.()
        // The grown card keeps no animation: hover and the stylesheet own it again.
        else for (const one of morph.current) one.cancel()
      },
      () => undefined
    )
  }, [place, leaving, anchor, zoomed])

  return (
    <div
      ref={ref}
      className={`cr-pet-card ${className}${leaving ? ' leaving' : ''}`}
      style={place ? { left: place.left, top: place.top } : { visibility: 'hidden', left: 0, top: 0 }}
      role="dialog"
      aria-label={label}
      aria-hidden={leaving ? true : undefined}
    >
      {children}
    </div>
  )
}
