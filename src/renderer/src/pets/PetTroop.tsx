import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cardPlacement, clampSpot, petClick, petHome, readSpot, type PetSpot } from './pet-pick'
import { CONTENT_FRAMES, MORPH_EASE, MORPH_MS, morphFrames } from './pet-morph'
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
 */

const DRAG_PX = 5

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
  cardLabel,
  renderCard
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
  cardLabel: (id: string) => string
  renderCard: (id: string, controls: CardControls) => React.ReactNode
}): React.JSX.Element | null {
  const spotKey = `${storageKey}.spot`
  const tuckedKey = `${storageKey}.tucked`
  const [openId, setOpenId] = useState<string | null>(null)
  /** The card shrinking back into its face (pet-morph.ts); gone when the morph ends. */
  const [leavingId, setLeavingId] = useState<string | null>(null)
  const openRef = useRef<string | null>(null)
  openRef.current = openId
  /** The face a pointer (or the keyboard) rests on: it shows its name. */
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [tucked, setTucked] = useState(() => stored(tuckedKey) === '1')
  const [saved, setSaved] = useState<PetSpot | null>(() => readSpot(stored(spotKey)))
  const [home, setHome] = useState<PetSpot>(() => petHome(bedGap(), window.innerWidth))
  const spot = saved ?? home
  const troopRef = useRef<HTMLDivElement>(null)
  const petRefs = useRef(new Map<string, HTMLButtonElement>())
  const drag = useRef<{ x: number; y: number; spot: PetSpot; moved: boolean; id: number } | null>(null)
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
    }
    const el = troopRef.current
    if (!el) return
    const x = side === 'right' ? at.spot.x - dx : at.spot.x + dx
    setSaved(clampSpot({ x, bottom: at.spot.bottom - dy }, el.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }))
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
    // Once: its card. Again, on the same face: in full.
    if (petClick(openId, id) === 'full') {
      close()
      onOpen(id)
      return
    }
    draft.current = ''
    // Another face's card shrinks home while this one grows; the same face
    // clicked mid-shrink grows straight back (PetCardFrame reverses).
    if (openId && openId !== id) setLeavingId(openId)
    else if (leavingId === id) setLeavingId(null)
    setOpenId(id)
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
      const id = openId
      close()
      if (id) onOpen(id)
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
        className={`cr-pets ${side}${tucked ? ' tucked' : ''}${expanded ? ' expanded' : ''}`}
        style={side === 'right' ? { right: spot.x, bottom: spot.bottom } : { left: spot.x, bottom: spot.bottom }}
        role="toolbar"
        aria-label={label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => void (drag.current = null)}
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
            // An expanded troop scrolls, and its scroll would clip the name tag.
            title={expanded ? member.name : undefined}
            onPointerEnter={(event) => {
              if (event.pointerType !== 'mouse' || tucked || drag.current?.moved) return
              setHoverId(member.id)
            }}
            onPointerLeave={() => setHoverId((at) => (at === member.id ? null : at))}
            // The keyboard names a face as a pointer does; Enter is its click.
            onFocus={(event) => !tucked && event.currentTarget.matches(':focus-visible') && setHoverId(member.id)}
            onBlur={() => setHoverId((at) => (at === member.id ? null : at))}
            onClick={() => clickPet(member.id)}
          >
            {member.face}
            {!tucked && (
              <span className="cr-pet-name" aria-hidden="true">
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
          onGone={() => setLeavingId((at) => (at === id ? null : at))}
        >
          {renderCard(id, controls)}
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
  onGone,
  children
}: {
  anchor: HTMLElement | null
  side: 'left' | 'right'
  className: string
  label: string
  /** Shrinking back into the face; onGone when the morph has ended. */
  leaving?: boolean
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
    } else if (grown.current || reduced || !anchor) {
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
  }, [place, leaving, anchor])

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
