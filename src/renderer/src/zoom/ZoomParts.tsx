import { memo, useState } from 'react'
import { sameProps } from './same-props'
import { useThumb } from '../activity-thumb-store'
import { InkAvatar, InkRing } from './InkAvatar'
import { CardBody } from './CardBody'
import { QuickReply, useQuickReply } from './quick-reply'
import { typingOf } from './typing-line'
import './agent-card.css'
import type { AgentView, ItemView, MachineView } from './zoom-model'
import { NEW_POSE } from './zoom-layout'
import { useNameEdit } from './NameEdit'

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

export type Bind = (key: string) => (el: HTMLElement | null) => void

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

export const PAGE_GLYPH = (
  <svg className="zv-glyph" viewBox="0 0 12 12" aria-hidden="true">
    <rect x="1" y="1.5" width="10" height="9" rx="1.2" />
    <path d="M1 4h10" />
  </svg>
)
export const NOTE_GLYPH = (
  <svg className="zv-glyph" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2 1h5.5L10 3.5V11H2z" />
    <path d="M7.5 1v2.5H10M4 6h4M4 8h3" />
  </svg>
)

/**
 * "▭ 2 ▤ 1": browsers and notes, zero counts left out. When both are, `none`
 * if one is given, else nothing: under an agent's face "nothing open" was
 * noise (owner, 2026-11-01).
 */
export const Counts = memo(function Counts({ browsers, notes, none }: { browsers: number; notes: number; none?: string }): React.JSX.Element | null {
  if (browsers + notes === 0) return none ? <span className="zv-none">{none}</span> : null
  return (
    <>
      {browsers > 0 && (
        <span title={`${browsers} browser${browsers === 1 ? '' : 's'}`}>
          {PAGE_GLYPH}
          {browsers}
        </span>
      )}
      {notes > 0 && (
        <span title={`${notes} note${notes === 1 ? '' : 's'}`}>
          {NOTE_GLYPH}
          {notes}
        </span>
      )}
    </>
  )
}, sameProps)

/**
 * A browser's picture: the live thumbnail when there is one, else a drawn page in its tint.
 * `words={false}`: the page without its address or a note's lines, for a face
 * too small to set them legibly (the side group's column, UI/UX QA 2026-11-01:
 * "file://age..." at about 6px). Its name is the face's own tag.
 */
export const Page = memo(function Page({ item, big = false, words = true }: { item: ItemView; big?: boolean; words?: boolean }): React.JSX.Element {
  const thumb = useThumb(item.id)
  if (item.kind === 'note') {
    return (
      <div className="zv-nt">
        {big && NOTE_GLYPH}
        {words && <b>{item.title}</b>}
        {words && <span>{item.line || 'empty note'}</span>}
        <i />
        <i />
      </div>
    )
  }
  return (
    <>
      <div className="zv-bar">
        {big && (
          <i className="zv-fav" style={{ background: item.tint }}>
            {item.initial}
          </i>
        )}
        {words && item.host}
      </div>
      {thumb ? (
        <img className="zv-shot" src={thumb} alt="" draggable={false} />
      ) : (
        <div className="zv-pg">
          <b style={{ background: item.tint }} />
          <i />
          <i />
        </div>
      )}
    </>
  )
}, sameProps)

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
export const AgentNode = memo(function AgentNode({ agent, card = true, bind, onOpen, onDelete }: { agent: AgentView; card?: boolean; bind: Bind; onOpen: () => void; onDelete?: () => void }): React.JSX.Element {
  const reply = useQuickReply(agent.id, undefined, card)
  const typing = typingOf(reply.draft, agent.turn?.pendingInput, agent.name)
  // A click on the name opens, as the face does; a double-click renames it in place (NameEdit.tsx).
  const title = useNameEdit(agent.id, agent.name, { onPress: onOpen })
  return (
    <div ref={bind(`agent:${agent.id}`)} className={`zv-m ${agent.phase}`} data-card-id={agent.id}>
      <div ref={bind(`agent-av:${agent.id}`)} className="zv-av" title={`${agent.name} · ${agent.word}`} {...press(onOpen, `${agent.name}, ${agent.word}`)}>
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
 * This machine on the devices stop: its frame opens it, and the words under it
 * carry the way to share one of its windows. The frame's own button has no
 * handler: its press bubbles to the card, which is also what a press on the
 * words reaches, and the share button keeps its press to itself.
 */
export function LocalMachine({ name, detail, bind, onOpen, onShare }: { name: string; detail: string; bind: Bind; onOpen: () => void; onShare: (() => void) | null }): React.JSX.Element {
  return (
    <div className="zv-machine" ref={bind('machine')} onClick={onOpen}>
      <button type="button" className="zv-machine-open" aria-label={`Open ${name}`} />
      <span className="zv-machine-deck" />
      <span className="zv-machine-label">
        <b>{name}</b>
        <small>{detail}</small>
        {onShare && (
          <button
            type="button"
            className="zv-machine-share"
            onClick={(e) => {
              e.stopPropagation()
              onShare()
            }}
          >
            Share a window
          </button>
        )}
      </span>
    </div>
  )
}

/**
 * Another machine on the devices stop, from the real fleet: its frame, the
 * workspaces its feed seats (a ring and a name each; a listed-only desktop
 * shows names alone), and its own line. A machine that cannot be read says
 * "listed" rather than showing zeros it does not know.
 */
export function MachineNode({ machine, bind, onOpen }: { machine: MachineView; bind: Bind; onOpen: () => void }): React.JSX.Element {
  const known = machine.agents !== null
  return (
    <div ref={bind(`machinecard:${machine.id}`)} className={`zv-machinecard${machine.online ? '' : ' off'}`}
      title={`${machine.name} · ${machine.workspaces.length} workspaces${known ? ` · ${machine.agents} agents` : ' · listed only'}`}
      {...press(onOpen, `${machine.name}, ${machine.workspaces.length} workspaces`)}>
      <div className="zv-machinecard-screen">
        {machine.workspaces.slice(0, 6).map((w) => (
          <div key={w.id} className="zv-mws">
            <div className="zv-mws-ring"><InkRing seed={3 + w.name.length} /></div>
            <span>{w.name}</span>
            {w.waiting && <i className="zv-mws-dot" />}
          </div>
        ))}
        {machine.workspaces.length === 0 && <span className="zv-none">no workspaces listed</span>}
      </div>
      <div className="zv-machinecard-label">
        <b>{machine.name}</b>
        <small>
          {machine.local ? 'this desktop' : machine.detail} · {machine.workspaces.length} workspaces
          {known ? ` · ${machine.agents} agents` : ' · listed only'}
          {machine.waiting ? ` · ${machine.waiting} waiting` : ''}
        </small>
      </div>
    </div>
  )
}
