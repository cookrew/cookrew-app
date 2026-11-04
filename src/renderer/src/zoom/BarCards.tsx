import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AgentCard } from './AgentCard'
import { eatNextClick } from './ShelfCard'
import { ItemCard, type CrewFace, type ItemFace } from '../pets/ItemPets'
import { draftKey, getDraft } from '../prompt/prompt-draft'
import type { AgentView, ItemView } from './zoom-model'
import type { FaceBox } from './bar-pick'
import { BarWaitCard } from './BarWaitCard'
import { useWaitAnswer } from '../prompt/wait-answer'
import { promptBox } from '../prompt/box-focus'
import '../pets/pets.css'
import './agent-card.css'

/**
 * A BAR GROUP'S CARD, ABOVE THE BAR (owner, 2026-11-04; cut e-groups ·
 * 9-taps): the troop's own cards, not a third kind. An agent's is the crew
 * card (AgentCard, as ShelfCard floats it over the artifacts); an artifact's
 * is the troop's item card (ItemCard: the picture, who made it). It stands
 * over the face it opened from, above the bar — and above the prompt box,
 * which an agent's card opens in the bar's place. A press outside, Esc or ×
 * closes it; a card holding a draft stays.
 */

const GAP = 10
const EDGE = 8

/**
 * Where the card stands: centred over the tapped face, kept on screen, its
 * foot `GAP` above whichever is higher, the face or the bar and the box (`floor`);
 * never above the stage's top (`ceiling`), where it is pinned instead.
 */
export function barCardSpot(face: FaceBox, card: { readonly width: number; readonly height: number }, viewportWidth: number, floor: number, ceiling: number): { left: number; top: number } {
  const centre = face.left + face.width / 2
  const left = Math.min(Math.max(EDGE, centre - card.width / 2), Math.max(EDGE, viewportWidth - card.width - EDGE))
  const top = Math.max(ceiling + EDGE, Math.min(face.top, floor) - GAP - card.height)
  return { left: Math.round(left), top: Math.round(top) }
}

const boxOf = (r: DOMRect): FaceBox => ({ left: r.left, top: r.top, width: r.width, height: r.height })

/** The highest of the bar and the open prompt box over it: the card stands clear of both. */
const boxTop = (): number => {
  const tops = ['.cr-dock .cr-prompt', '.cr-prompt-tray', '.zv-controls'].map((sel) => document.querySelector(sel)?.getBoundingClientRect()).filter((r): r is DOMRect => !!r && r.height > 0).map((r) => r.top)
  return Math.min(window.innerHeight, ...tops)
}

const stageTop = (): number => Math.max(0, document.querySelector('.cr-stage')?.getBoundingClientRect().top ?? 0)

/** Presses that keep the card: on it, on a group's face (its own tap decides), in the prompt box. */
const KEEPS = '.zv-gf, .zv-group-more, .cr-prompt, .cr-dock, .pf-who, .cr-prompt-menu'

function BarCardFrame({ anchor, className, label, keep, onOutside, onClose, children }: {
  /** The face it opened from; its last place stands in once it has left the stack. */
  anchor: HTMLElement | null
  className: string
  label: string
  /** The card holds a draft: a press outside does not close it. */
  keep: () => boolean
  onOutside: (target: EventTarget | null) => boolean
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const last = useRef<FaceBox | null>(null)
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const place = (): void => {
      const el = box.current
      if (!el) return
      if (anchor?.isConnected) {
        const r = anchor.getBoundingClientRect()
        if (r.width > 0) last.current = boxOf(r)
      }
      const face = last.current
      if (!face) return
      // The card's remove mark hangs past its corner (agent-card.css · .zv-del): it too stays on screen.
      const mark = el.querySelector<HTMLElement>('.zv-del')
      const over = mark ? Math.max(0, Math.ceil(mark.getBoundingClientRect().right - el.getBoundingClientRect().right)) : 0
      // A long menu scrolls inside its card (wait-choices.css): it never runs under the bar or off the top.
      if (el.classList.contains('wc-card')) el.style.maxHeight = `${Math.max(180, boxTop() - stageTop() - 20)}px`
      const next = barCardSpot(face, { width: el.offsetWidth + over, height: el.offsetHeight }, window.innerWidth, boxTop(), stageTop())
      setSpot((at) => (at && at.left === next.left && at.top === next.top ? at : next))
    }
    // The box opens behind an agent's card (its flight is 360 ms): follow it a moment, and on any resize.
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
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(again) : null
    if (ro && box.current) ro.observe(box.current)
    const prompt = document.querySelector('.cr-dock')
    if (ro && prompt) ro.observe(prompt)
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener('resize', again)
    }
  }, [anchor])

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return
      const t = e.target as Element | null
      if (!t || box.current?.contains(t) || t.closest?.(KEEPS) || keep()) return
      if (onOutside(t)) eatNextClick()
      onClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [keep, onOutside, onClose])

  return createPortal(
    <div ref={box} className={`cr-pet-card ag-ink zv-bar-card ${className}`} role="dialog" aria-label={label} style={spot ? { left: spot.left, top: spot.top } : { left: 0, top: 0, visibility: 'hidden' }}>
      {children}
    </div>,
    document.body
  )
}

/** The card's words live in the agent's draft store already (quick-reply.tsx): nothing more to keep. */
const KEEP_DRAFT = (): void => undefined

export function BarAgentCard({ agent, items, anchor, onOpen, onItem, onDelete, onOutside, onClose }: {
  agent: AgentView
  items: readonly ItemView[]
  anchor: HTMLElement | null
  onOpen: () => void
  onItem: (id: string) => void
  onDelete?: () => void
  onOutside: (target: EventTarget | null) => boolean
  onClose: () => void
}): React.JSX.Element {
  const keep = useRef(() => getDraft(draftKey(agent.id)).trim() !== '').current
  // Waiting on a menu: the card carries its rows (BarWaitCard.tsx), the box's own stand down.
  const wait = useWaitAnswer(agent.id, promptBox.focus)
  if (wait.view) {
    return (
      <BarCardFrame anchor={anchor} className="wc-card needs" label={`${agent.name} needs you`} keep={keep} onOutside={onOutside} onClose={onClose}>
        <BarWaitCard agent={agent} view={wait.view} wait={wait} onOpen={onOpen} onReply={promptBox.focus} onClose={onClose} />
      </BarCardFrame>
    )
  }
  return (
    <BarCardFrame anchor={anchor} className={`ag-card zv-shelf-card${agent.phase === 'waiting' ? ' needs' : ''}`} label={`${agent.name}'s card`} keep={keep} onOutside={onOutside} onClose={onClose}>
      <AgentCard agent={agent} items={items} onOpen={onOpen} onItem={onItem} onDelete={onDelete} onDraft={KEEP_DRAFT} />
    </BarCardFrame>
  )
}

const NEVER = (): boolean => false

export function BarItemCard({ item, crew, since, anchor, onOpen, onAgent, onOutside, onClose }: {
  item: ItemFace
  crew: ReadonlyMap<string, CrewFace>
  since?: string
  anchor: HTMLElement | null
  onOpen: () => void
  onAgent: (id: string) => void
  onOutside: (target: EventTarget | null) => boolean
  onClose: () => void
}): React.JSX.Element {
  return (
    <BarCardFrame anchor={anchor} className={`item-card item ${item.kind}`} label={item.title} keep={NEVER} onOutside={onOutside} onClose={onClose}>
      <ItemCard item={item} crew={crew} since={since} controls={{ draft: KEEP_DRAFT, open: onOpen, close: onClose }} onAgent={onAgent} />
    </BarCardFrame>
  )
}
