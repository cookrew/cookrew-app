import { useState } from 'react'
import { cookrew } from '../api'
import { useThumb } from '../activity-thumb-store'
import { InkAvatar, InkRing } from './InkAvatar'
import type { AgentView, ItemView, MarkView, MachineView } from './zoom-model'

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

/** "▭ 2 ▤ 1": browsers and notes, zero counts left out; "nothing open" when both are. */
export function Counts({ browsers, notes, none = 'nothing open' }: { browsers: number; notes: number; none?: string }): React.JSX.Element {
  if (browsers + notes === 0) return <span className="zv-none">{none}</span>
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
}

/** A browser's picture: the live thumbnail when there is one, else a drawn page in its tint. */
function Page({ item, big = false }: { item: ItemView; big?: boolean }): React.JSX.Element {
  const thumb = useThumb(item.id)
  if (item.kind === 'note') {
    return (
      <div className="zv-nt">
        {big && NOTE_GLYPH}
        <b>{item.title}</b>
        <span>{item.line || 'empty note'}</span>
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
        {item.host}
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
}

/** One agent–item link: a small thumbnail (on a card) over a two-faced coin (the item; flipped, the agent). */
export function LinkNode({ k, item, agent, shared, bind, onClick }: { k: string; item: ItemView; agent: AgentView; shared: number; bind: Bind; onClick: () => void }): React.JSX.Element {
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
}

/** An item's own thumbnail in the thumbs grid: the page, its title, who uses it. */
export function ItemNode({ item, names, bind, onClick }: { item: ItemView; names: string[]; bind: Bind; onClick: () => void }): React.JSX.Element {
  return (
    <div ref={bind(`item:${item.id}`)} className={`zv-ip ${item.kind}`} title={item.title} {...press(onClick, `${item.kind}: ${item.title}`)}>
      <div className={`zv-th zv-big ${item.kind}`}>
        <Page item={item} big />
      </div>
      <div ref={bind(`item-ttl:${item.id}`)} className="zv-ttl">
        <b>{item.title}</b>
        <span>{item.kind === 'browser' ? item.host : 'note'}</span>
        <span className="zv-who">{names.length ? `${names.length > 1 ? `${names.length} agents · ` : ''}${names.join(', ')}` : 'no agent'}</span>
      </div>
    </div>
  )
}

/** One agent: its card (drawn under), its ink face, its words, and the card's quick reply. */
export function AgentNode({ agent, bind, onOpen }: { agent: AgentView; bind: Bind; onOpen: () => void }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const send = (): void => {
    const text = draft.trim()
    if (!text) return
    // The same two writes the voice bar makes: the words, then Enter on its own.
    cookrew().ptyInput(agent.id, text)
    cookrew().ptyInput(agent.id, '\r')
    setDraft('')
    setSent(text)
    window.setTimeout(() => setSent((at) => (at === text ? null : at)), 4000)
  }
  return (
    <div ref={bind(`agent:${agent.id}`)} className={`zv-m ${agent.phase}`}>
      <div ref={bind(`agent-av:${agent.id}`)} className="zv-av" title={`${agent.name} · ${agent.word}`} {...press(onOpen, `${agent.name}, ${agent.word}`)}>
        <InkAvatar id={agent.id} preset={agent.preset} orch={agent.orch} />
      </div>
      <div ref={bind(`agent-nm:${agent.id}`)} className="zv-nm" {...press(onOpen, `${agent.name}, ${agent.word}`)}>
        {agent.name}
      </div>
      <div ref={bind(`agent-st:${agent.id}`)} className={`zv-st ${agent.phase}`}>
        {agent.word}
      </div>
      <div ref={bind(`agent-cnt:${agent.id}`)} className="zv-cnt">
        <Counts browsers={agent.browsers} notes={agent.notes} />
      </div>
      <div ref={bind(`agent-body:${agent.id}`)} className="zv-body">
        {sent !== null ? (
          <>
            <b>You</b> · {sent}
          </>
        ) : (
          agent.line
        )}
      </div>
      {agent.browsers + agent.notes === 0 && (
        <div ref={bind(`agent-emp:${agent.id}`)} className="zv-emp">
          no browser or note
        </div>
      )}
      <form
        ref={bind(`agent-reply:${agent.id}`)}
        className="zv-reply"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <input
          type="text"
          value={draft}
          placeholder={`Reply to ${agent.name}…`}
          aria-label={`Quick reply to ${agent.name}`}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <button type="submit" aria-label="Send" disabled={!draft.trim()}>
          ➜
        </button>
        {sent !== null && <span className="zv-sent">sent ✓</span>}
      </form>
    </div>
  )
}

/** Another workspace on the device: its ring, its agents' stack, its seal and name. */
export function MarkNode({ mark, bind, onOpen }: { mark: MarkView; bind: Bind; onOpen: () => void }): React.JSX.Element {
  const n = mark.presets.length
  const shown = mark.presets.slice(0, 9)
  const mid = (shown.length - 1) / 2
  return (
    <div ref={bind(`mark:${mark.id}`)} className="zv-mark" title={`${mark.name} · ${n} agent${n === 1 ? '' : 's'} · open`} {...press(onOpen, `${mark.name}, ${n} agents`)}>
      <div className="zv-wash" style={{ transform: 'translate(0px, -10px) scale(0.2, 0.42)', opacity: 0.6 }} />
      <div className="zv-ring" style={{ transform: 'translate(0px, -10px)' }}>
        <InkRing seed={3 + mark.name.length} />
      </div>
      {shown.map((preset, i) => {
        const k = i - mid
        return (
          <div key={i} className="zv-av zv-mark-av" style={{ transform: `translate(${k * 8}px, ${-10 - (mid - Math.abs(k)) * 2.5}px) rotate(${k * 6}deg) scale(0.84)`, zIndex: i }}>
            <InkAvatar id={`${mark.id}:${i}`} preset={preset} />
          </div>
        )
      })}
      {n === 0 && <div className="zv-none zv-mark-none">no agents</div>}
      {mark.waiting && <span className="zv-dot zv-mark-dot" />}
      <div className="zv-grp zv-mark-label">
        <span className="zv-seal">{n}</span>
        <span>{mark.name}</span>
      </div>
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
