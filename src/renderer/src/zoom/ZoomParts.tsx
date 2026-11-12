import { memo, useState } from 'react'
import { sameProps } from './same-props'
import { InkAvatar } from './InkAvatar'
import { CardBody } from './CardBody'
import { QuickReply, useQuickReply } from './quick-reply'
import { typingOf } from './typing-line'
import './agent-card.css'
import type { AgentView, ItemView } from './zoom-model'
import { NEW_POSE } from './zoom-layout'
import { useNameEdit } from './NameEdit'
import { Counts, NOTE_GLYPH, Page, type Bind } from './page-parts'

export { Counts, NOTE_GLYPH, PAGE_GLYPH, Page, type Bind } from './page-parts'

/**
 * A workspace's newest browser beside its agents' stack (draft
 * group-motion-pivot.html): a thumbnail wearing its face as a coin, and a
 * caption. A press on it opens the workspace by its browsers. Kept out of the
 * stack's own button: the mark around it opens the crew on a click or Enter.
 */
export const NewestThumb = memo(function NewestThumb({ item, workspace, onOpen, thumbRef, caption = true }: { item: ItemView; workspace: string; onOpen: () => void; thumbRef?: (el: HTMLElement | null) => void; caption?: boolean }): React.JSX.Element {
  return (
    <>
      <button
        ref={thumbRef}
        type="button"
        className="zv-lk browser zv-wsnew"
        style={{ transform: `translate(${NEW_POSE.x}px, ${NEW_POSE.y}px) scale(${NEW_POSE.s})` }}
        title={`${item.title} · the newest browser of ${workspace}`}
        aria-label={`Open ${workspace} artifacts, newest ${item.title}`}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
      >
        <div className="zv-th browser">
          <Page item={item} />
        </div>
        <div className="zv-coin" style={{ transform: 'translate(-27px, -18px) scale(0.45)' }}>
          <div className="zv-face zv-face-item" style={{ background: item.tint }}>
            {item.initial}
          </div>
        </div>
      </button>
      {caption && (
        <div className="zv-newcap zv-wsnew-cap" style={{ transform: `translate(${NEW_POSE.x - 52}px, ${NEW_POSE.y + 40}px)` }}>
          newest · {item.title}
        </div>
      )}
    </>
  )
}, sameProps)

/**
 * The zoom's parts, drawn once; ZoomView's painter only moves them
 * (zoom-frame.ts). Each registers its elements through `bind`.
 */


/** A part that is drawn as a div but is a control: Enter and Space press it, as a button. */
const press = (onClick: () => void, label: string): React.HTMLAttributes<HTMLElement> => ({
  role: 'button',
  tabIndex: 0,
  'aria-label': label,
  onClick,
  onKeyDown: (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    onClick()
  }
})

/** A part's first frame, before the painter's: hidden, so a card opening never flashes its parts. */
const HIDDEN: React.CSSProperties = { opacity: 0 }


/** One agent–item link: a small thumbnail (on a card) over a two-faced coin (the item; flipped, the agent). */
export const LinkNode = memo(function LinkNode({ k, item, agent, shared, bind, onClick }: { k: string; item: ItemView; agent: AgentView; shared: number; bind: Bind; onClick: () => void }): React.JSX.Element {
  return (
    <div ref={bind(`link:${k}`)} className={`zv-lk ${item.kind}`} title={`${item.title} · ${agent.name}${shared > 1 ? ` · shared by ${shared}` : ''}`} {...press(onClick, `${item.title}, carried by ${agent.name}`)}>
      <div ref={bind(`link-th:${k}`)} className={`zv-th ${item.kind}`}>
        <Page item={item} />
        {shared > 1 && <em>×{shared}</em>}
      </div>
      <div ref={bind(`link-coin:${k}`)} className="zv-coin">
        <div className="zv-face zv-face-item" style={item.kind === 'browser' ? { background: item.tint } : undefined}>
          {item.kind === 'browser' ? item.initial : NOTE_GLYPH}
        </div>
        <div className="zv-face zv-face-agent">
          <InkAvatar id={agent.id} preset={agent.preset} orch={agent.orch} />
        </div>
      </div>
      {shared > 1 && (
        <div ref={bind(`link-badge:${k}`)} className="zv-badge">
          ×{shared}
        </div>
      )}
    </div>
  )
}, sameProps)

/** An item's own thumbnail in the thumbs grid: the page, its title, who uses it. */
export const ItemNode = memo(function ItemNode({ item, names, bind, onClick, onDelete }: { item: ItemView; names: string[]; bind: Bind; onClick: () => void; onDelete?: () => void }): React.JSX.Element {
  return (
    <div ref={bind(`item:${item.id}`)} className={`zv-ip ${item.kind}`} title={item.title} {...press(onClick, `${item.kind}: ${item.title}`)}>
      <div className={`zv-th zv-big ${item.kind}`}>
        <Page item={item} big />
      </div>
      {onDelete && (
        <button type="button" className="zv-del" title={`Remove ${item.title}`} aria-label={`Remove ${item.title}`} onClick={(e) => { e.stopPropagation(); onDelete() }}>
          ×
        </button>
      )}
      <div ref={bind(`item-ttl:${item.id}`)} className="zv-ttl">
        <b>{item.title}</b>
        <span>{item.kind === 'browser' ? item.host : 'note'}</span>
        <span className="zv-who">{names.length ? `${names.length > 1 ? `${names.length} agents · ` : ''}${names.join(', ')}` : 'no agent'}</span>
      </div>
    </div>
  )
}, sameProps)

/**
 * One agent: its ink face, name, state and counts, always (the crew draws
 * them), and the words it has typed unsent (typing-line.ts); and, when `card` (the open card, ZoomView · cardIds), the card's own
 * parts: its latest, the empty strip and the quick reply. One card instance,
 * not one per agent behind the crew; the pets open this same card.
 */
export const AgentNode = memo(function AgentNode({ agent, card = true, bind, onOpen, onDelete, onHoverIn, onHoverOut, onDragStart }: { agent: AgentView; card?: boolean; bind: Bind; onOpen: () => void; onDelete?: () => void; onHoverIn?: () => void; onHoverOut?: () => void; onDragStart?: (id: string, e: React.PointerEvent) => void }): React.JSX.Element {
  const reply = useQuickReply(agent.id, undefined, card)
  const typing = typingOf(reply.draft, agent.turn?.pendingInput, agent.name)
  // A click on the name opens, as the face does; a double-click renames it in place (NameEdit.tsx).
  const title = useNameEdit(agent.id, agent.name, { onPress: onOpen })
  return (
    <div ref={bind(`agent:${agent.id}`)} className={`zv-m ${agent.phase}`} data-card-id={agent.id}>
      {/* A pointer resting on the face, or the keyboard's focus, folds the space round it (zoom-frame.ts · foldAt); a finger never does. Dragged onto another face, it swaps places with it (crew-slots.ts). */}
      <div
        ref={bind(`agent-av:${agent.id}`)}
        className="zv-av"
        title={`${agent.name} · ${agent.word}`}
        onPointerEnter={(e) => e.pointerType !== 'touch' && onHoverIn?.()}
        onPointerLeave={(e) => e.pointerType !== 'touch' && onHoverOut?.()}
        onPointerDown={(e) => onDragStart?.(agent.id, e)}
        onFocus={onHoverIn}
        onBlur={onHoverOut}
        {...press(onOpen, `${agent.name}, ${agent.word}`)}
      >
        <InkAvatar id={agent.id} preset={agent.preset} orch={agent.orch} status={agent.status} weight="large" />
      </div>
      <div ref={bind(`agent-nm:${agent.id}`)} className="zv-nm" {...press(onOpen, `${agent.name}, ${agent.word}`)} {...title.hostProps}>
        {title.view}
      </div>
      {onDelete && (
        // Deletion is a small mark on the open card, never a stray click: the
        // app's own confirm dialog takes it from here.
        <button type="button" className="zv-del" title={`Remove ${agent.name}`} aria-label={`Remove ${agent.name}`} onClick={(e) => { e.stopPropagation(); onDelete() }}>
          ×
        </button>
      )}
      <div ref={bind(`agent-st:${agent.id}`)} className={`zv-st ${agent.status}`}>
        {agent.word}
      </div>
      <div ref={bind(`agent-cnt:${agent.id}`)} className="zv-cnt">
        <Counts browsers={agent.browsers} notes={agent.notes} />
      </div>
      {/* Always mounted, so the painter holds it; empty when nothing is typed. */}
      <div ref={bind(`agent-dft:${agent.id}`)} className="zv-dft" style={HIDDEN}>
        {typing && <span>{typing}</span>}
      </div>
      {/* The card's own parts: the open card only. Mounted hidden; the painter shows them. */}
      {card && (
        <>
        {/* Its latest turn, as the floating card says it too (quick-reply.tsx). */}
        <CardBody agent={agent} sent={reply.sent} roomy={agent.browsers + agent.notes === 0} style={HIDDEN} frameRef={bind(`agent-body:${agent.id}`)} />
        <QuickReply agent={agent} reply={reply} className="zv-reply" style={HIDDEN} formRef={bind(`agent-reply:${agent.id}`)} />
        </>
      )}
    </div>
  )
}, sameProps)

/**
 * This machine on the devices stop: its frame opens it. The frame's own button
 * has no handler: its press bubbles to the card, which is also what a press on
 * the words reaches. Its remote desktop is the view's toolbar's (ViewTools.tsx;
 * owner 2026-11-12: the button under the name took too much room).
 */
export function LocalMachine({ name, detail, bind, onOpen, gauge = null }: { name: string; detail: string; bind: Bind; onOpen: () => void; gauge?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="zv-machine" ref={bind('machine')} onClick={onOpen}>
      <button type="button" className="zv-machine-open" aria-label={`Open ${name}`} />
      <span className="zv-machine-deck" />
      <span className="zv-machine-label">
        <b>{name}</b>
        <small>{detail}</small>
        {gauge}
      </span>
    </div>
  )
}

