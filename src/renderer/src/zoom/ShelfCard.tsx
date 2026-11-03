import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AgentCard } from './AgentCard'
import { draftKey, getDraft } from '../prompt/prompt-draft'
import type { AgentView, ItemView } from './zoom-model'
import '../pets/pets.css'

/**
 * AN AGENT'S CARD OVER THE ARTIFACTS (owner, 2026-11-03: "a tap on an agent
 * should pop its card up on this page"). A tap on a face in the shelf, or on
 * a coin under a thumbnail, used to cross to the agents' side at its card
 * stop and leave the artifacts behind. Now the card floats where the tap was,
 * the artifacts still under it: the troop's card (AgentCard, the same classes,
 * so the same look), not a third one. Its face, or a second tap on the same
 * agent, opens the full view; a tap outside or Escape closes it (unless it
 * holds a draft, as the troop's does).
 */

export interface Rect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** The card's room from the face it opens from, and from the screen's edges. */
const GAP = 10
const EDGE = 8

/**
 * Where the card opens: under the tapped face, centred on it, kept on screen
 * and inside the stage (`band`: below the header, above the bottom bar);
 * above the face where there is no room under it, and pinned inside the band
 * where there is room on neither side.
 */
export function shelfCardSpot(face: Rect, card: { readonly width: number; readonly height: number }, viewport: { readonly width: number; readonly height: number }, band: { readonly top: number; readonly bottom: number }): { left: number; top: number } {
  const centre = face.left + face.width / 2
  const left = Math.min(Math.max(EDGE, centre - card.width / 2), Math.max(EDGE, viewport.width - card.width - EDGE))
  const below = face.top + face.height + GAP
  const above = face.top - GAP - card.height
  const lo = band.top + EDGE
  const hi = band.bottom - EDGE - card.height
  const top = below <= hi ? below : above >= lo ? above : Math.min(Math.max(lo, below), Math.max(lo, hi))
  return { left: Math.round(left), top: Math.round(top) }
}

/** The stage between the app's header and its bottom bar. */
const stageBand = (): { top: number; bottom: number } => {
  const r = document.querySelector('.cr-stage')?.getBoundingClientRect()
  return r ? { top: Math.max(0, r.top), bottom: Math.min(window.innerHeight, r.bottom) } : { top: 0, bottom: window.innerHeight }
}

/**
 * A tap outside on the artifacts only closes the card: the click it ends in is
 * eaten before anything under it (a thumbnail, the background's step out)
 * sees it. Once, until the next press or a moment later.
 */
function eatNextClick(): void {
  const done = (): void => {
    document.removeEventListener('click', eat, true)
    document.removeEventListener('pointerdown', next, true)
    clearTimeout(timer)
  }
  const eat = (e: MouseEvent): void => {
    e.stopPropagation()
    e.preventDefault()
    done()
  }
  // The next press is a new tap: it is its own.
  const next = (): void => done()
  document.addEventListener('click', eat, true)
  setTimeout(() => document.addEventListener('pointerdown', next, true), 0)
  const timer = setTimeout(done, 1500)
}

/** The card's words live in the agent's draft store already (quick-reply.tsx): nothing more to keep. */
const KEEP_DRAFT = (): void => undefined

/** A press on a face or a coin: the click that follows decides (open another card, or the full view). */
const AGENT_PARTS = '.zv-m .zv-av, .zv-m .zv-nm, .zv-lk'

export function ShelfCard({ agent, items, anchor, onOpen, onItem, onDelete, onDraft, onOutside, onClose }: {
  agent: AgentView
  items: readonly ItemView[]
  /** The face or coin it opened from. */
  anchor: HTMLElement | null
  onOpen: () => void
  onItem: (id: string) => void
  onDelete?: () => void
  onDraft?: (text: string) => void
  /** Whether a press there is on the artifacts' page (its click is eaten), not the bar or the header. */
  onOutside: (target: EventTarget | null) => boolean
  onClose: () => void
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const place = (): void => {
      const el = box.current
      if (!el || !anchor) return
      const r = anchor.getBoundingClientRect()
      const next = shelfCardSpot(r, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, stageBand())
      setSpot((at) => (at && at.left === next.left && at.top === next.top ? at : next))
    }
    // The painter may still be settling the face it opened from (a tap mid-zoom),
    // and a resize moves the face on the painter's next frame: follow it a moment.
    let raf = 0
    let until = performance.now() + 700
    const follow = (): void => {
      place()
      raf = performance.now() < until ? requestAnimationFrame(follow) : 0
    }
    const again = (): void => {
      until = performance.now() + 400
      if (!raf) raf = requestAnimationFrame(follow)
    }
    follow()
    window.addEventListener('resize', again)
    // The stage resizes without the window too (the dock, a phone's keyboard).
    const stage = document.querySelector('.cr-stage')
    const ro = stage && typeof ResizeObserver === 'function' ? new ResizeObserver(again) : null
    if (ro && stage) ro.observe(stage)
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener('resize', again)
    }
  }, [anchor, agent.id])

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      // A plain press only: a right or middle button is not a tap outside.
      if (e.button !== 0) return
      const t = e.target as Element | null
      // The draft is the agent's own (prompt-draft.ts), typed here or before: it keeps the card.
      if (!t || box.current?.contains(t) || t.closest?.(AGENT_PARTS) || getDraft(draftKey(agent.id)).trim()) return
      if (onOutside(t)) eatNextClick()
      onClose()
    }
    // Capture: the scene's own handlers must not hide the press from us.
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [agent.id, onClose, onOutside])

  return createPortal(
    <div
      ref={box}
      className={`cr-pet-card ag-ink ag-card zv-shelf-card${agent.phase === 'waiting' ? ' needs' : ''}`}
      role="dialog"
      aria-label={`${agent.name}'s card`}
      style={spot ? { left: spot.left, top: spot.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      <AgentCard
        agent={agent}
        items={items}
        onOpen={onOpen}
        onItem={onItem}
        onDelete={onDelete}
        onDraft={onDraft ?? KEEP_DRAFT}
      />
    </div>,
    document.body
  )
}
