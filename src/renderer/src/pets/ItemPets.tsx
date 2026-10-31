import { useCallback, useMemo, useState } from 'react'
import { useBusyAgents, useThumb } from '../activity-thumb-store'
import { activeBrowserTab, type WorkspaceState } from '../../../shared/model'
import type { AttachmentIndex } from '../terminal-attachments'
import { firstLine, hostPath, ownersOf } from '../stage/stage-select'
import { faviconOf, petMax, pickItems } from './pet-pick'
import { dockedCount, dockedOrder } from './pet-dock'
import { PetTroop, type CardControls } from './PetTroop'
import { thumbWants } from './thumb-wants'
import { InkAvatar } from '../zoom/InkAvatar'
import { Page } from '../zoom/ZoomParts'
import { itemViewOf, type ItemView } from '../zoom/zoom-model'
import '../zoom/zoom.css'
import '../zoom/agent-card.css'

/**
 * THE BROWSERS AND NOTES AS PETS — the left-hand troop (PetTroop.tsx).
 *
 * The stage's item column is retired with the canvas: the workspace's
 * browsers and notes ride over every page here instead. A browser's face is a
 * tiny picture of its page (the thumbnail store, fed for exactly these faces
 * through thumb-wants.ts); a note's is its first letter on note paper. The
 * card is the bigger picture, the address and whose it is, or the note's
 * opening lines; open, it is the browser or the note in full.
 */

export interface ItemFace {
  readonly id: string
  readonly kind: 'browser' | 'note'
  readonly title: string
  readonly sub: string
  readonly owners: readonly string[]
  /** A browser's site icon, for when the Mac has no picture of the page. */
  readonly icon?: string | null
  /** A note's opening lines. */
  readonly body?: string
  /** As the navigator draws it: the page thumbnail on its card and in the attached column. */
  readonly view: ItemView
}

/** An agent as an item card names it: face and name, to open it from there. */
export interface CrewFace {
  readonly name: string
  readonly preset: string
  readonly orch: boolean
}

const NOTE_LINES = 8

export function ItemPets({
  workspace,
  attachIndex,
  onStage,
  onOpen,
  dock = null
}: {
  workspace: WorkspaceState | null
  attachIndex: AttachmentIndex
  /** The agent whose terminal the stage shows: its items ride first. */
  onStage: string | null
  onOpen: (id: string, owners: readonly string[]) => void
  /**
   * A full view is up: the troop attaches to it (pet-dock.ts), without the
   * browser or note the panel shows; the agent on stage's own lead, the rest dimmed.
   */
  dock?: { readonly exclude: string | null } | null
}): React.JSX.Element | null {
  // Only who is busy, not every activity event (activity-thumb-store.ts · useBusyAgents).
  const busy = useBusyAgents()
  const owners = useMemo(() => ownersOf(attachIndex), [attachIndex])
  const crew = useMemo(
    () => new Map<string, CrewFace>((workspace?.nodes ?? []).flatMap((n) => (n.kind === 'terminal' ? [[n.id, { name: n.name, preset: n.preset, orch: n.orch }] as const] : []))),
    [workspace]
  )
  // Newest first: nodes are kept in creation order.
  const items = useMemo<ItemFace[]>(() => {
    const out: ItemFace[] = []
    for (const n of [...(workspace?.nodes ?? [])].reverse()) {
      if (n.kind === 'browser') {
        const tab = activeBrowserTab(n)
        const ids = owners.get(n.id) ?? []
        const view = itemViewOf(n, ids)
        if (view) out.push({ id: n.id, kind: 'browser', title: tab.title?.trim() || n.name, sub: hostPath(tab.url), owners: ids, icon: faviconOf(tab.url), view })
      } else if (n.kind === 'note') {
        const content = n.content ?? ''
        const ids = owners.get(n.id) ?? []
        const view = itemViewOf(n, ids)
        if (view) out.push({ id: n.id, kind: 'note', title: n.name, sub: firstLine(content), owners: ids, body: content.split('\n').slice(0, NOTE_LINES).join('\n'), view })
      }
    }
    return out
  }, [workspace, owners])
  // The agent on stage, then the agents that are working or need you.
  const focus = useMemo(() => (onStage ? [onStage, ...busy.filter((id) => id !== onStage)] : [...busy]), [busy, onStage])
  const picked = useMemo(() => pickItems(items, { owners, focus, max: petMax(window.innerWidth) }), [items, owners, focus])
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const onShown = useCallback(
    (ids: readonly string[]) => thumbWants.claim('troop', ids.filter((id) => byId.get(id)?.kind === 'browser')),
    [byId]
  )
  // In a full view the column is the demo's: the card on the panel is not in it, the agent's own lead.
  const column = useMemo(() => {
    if (!dock) return { shown: picked.shown, more: picked.more, dim: new Set<string>() }
    const all = [...picked.shown, ...picked.more]
    const order = dockedOrder(all, { exclude: dock.exclude, first: onStage ? all.filter((item) => item.owners.includes(onStage)).map((item) => item.id) : [] })
    const count = dockedCount(picked.shown.filter((item) => item.id !== dock.exclude).length, 'left', window.innerWidth)
    return { shown: order.members.slice(0, count), more: order.members.slice(count), dim: order.dim }
  }, [picked, dock, onStage])
  const member = useCallback((item: ItemFace) => ({
    id: item.id,
    className: `item ${item.kind}${onStage && item.owners.includes(onStage) ? ' mine' : ''}${column.dim.has(item.id) ? ' dim' : ''}`,
    label: `${item.kind === 'browser' ? 'Browser' : 'Note'}: ${item.title}`,
    name: item.title,
    face: (
      <>
        {/* Floating: a coin. Attached to the full view: the page thumbnail, as
            group-motion-pivot.html stands the other items beside the panel. */}
        <span className="cr-pet-coin">
          {item.kind === 'browser' ? (
            <BrowserFace id={item.id} icon={item.icon ?? null} title={item.title} />
          ) : (
            // A note's face is its first letter on paper, as the item coin draws it.
            <span className="cr-pet-note-face">{item.title.trim().charAt(0).toUpperCase() || '·'}</span>
          )}
        </span>
        <span className={`zv-th cr-pet-page ${item.kind}`} aria-hidden="true">
          <Page item={item.view} />
        </span>
      </>
    )
  }), [onStage, column.dim])
  // Built when the column changes, not on every render: the overflow alone is hundreds of items.
  const shownMembers = useMemo(() => column.shown.map(member), [column.shown, member])
  const moreMembers = useMemo(() => column.more.map(member), [column.more, member])
  return (
    <PetTroop
      side="left"
      storageKey="cookrew.pets.items"
      label="browsers and notes"
      members={shownMembers}
      more={moreMembers}
      dockable={dock !== null}
      onShown={onShown}
      onOpen={(id) => onOpen(id, byId.get(id)?.owners ?? [])}
      cardClass={(id) => `ag-ink item-card item ${byId.get(id)?.kind ?? ''}`}
      cardLabel={(id) => byId.get(id)?.title ?? 'Item'}
      renderCard={(id, controls) => {
        const item = byId.get(id)
        return item ? (
          <ItemCard
            item={item}
            crew={crew}
            controls={controls}
            onAgent={(agentId) => {
              controls.close()
              onOpen(agentId, [])
            }}
          />
        ) : null
      }}
    />
  )
}

/**
 * A browser's face: a tiny picture of its page; the site's icon while the Mac
 * has none (pet-pick.ts · faviconOf); the globe when there is neither.
 */
function BrowserFace({ id, icon, title }: { id: string; icon: string | null; title: string }): React.JSX.Element {
  const thumb = useThumb(id)
  const [iconFailed, setIconFailed] = useState(false)
  if (thumb) return <img className="cr-pet-thumb" src={thumb} alt="" draggable={false} />
  if (icon && !iconFailed) return <img className="cr-pet-icon" src={icon} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setIconFailed(true)} />
  // No picture and no favicon: its own seal, as the navigator's coin draws it.
  return <span className="cr-pet-note-face browser">{title.trim().replace(/^[^A-Za-z0-9]*/, '').charAt(0).toUpperCase() || '·'}</span>
}

/**
 * A browser's or note's card, in the agent card's ink (zoom/agent-card.css):
 * its seal and name, the page itself as a big thumbnail — the same Page the
 * navigator and the agent card draw — the address or the note's opening
 * lines, and the agents that use it, each a way to that agent.
 */
export function ItemCard({
  item,
  crew,
  controls,
  onAgent
}: {
  item: ItemFace
  crew: ReadonlyMap<string, CrewFace>
  controls: CardControls
  onAgent: (id: string) => void
}): React.JSX.Element {
  const users = item.owners.flatMap((id) => {
    const face = crew.get(id)
    return face ? [{ id, ...face }] : []
  })
  return (
    <>
      <div className="cr-pet-card-head">
        <span className={`cr-pet-card-face item-seal ${item.kind}`} style={item.kind === 'browser' ? { background: item.view.tint } : undefined} aria-hidden="true">
          {item.kind === 'browser' ? item.view.initial || '·' : '¶'}
        </span>
        <span className="cr-pet-card-who">
          <span className="cr-pet-card-name">{item.title}</span>
          <span className="cr-pet-card-meta">
            <span className="cr-pet-mood">{item.kind}</span>
            <span>{users.length === 0 ? 'no agent' : `used by ${users.length}`}</span>
          </span>
        </span>
        <button type="button" className="cr-pet-card-open" onClick={controls.open} title={item.kind === 'browser' ? 'Open the page (or click its face again)' : 'Open the note (or click its face again)'}>
          OPEN
        </button>
        <button type="button" className="cr-pet-card-x" onClick={controls.close} aria-label="Close">
          ×
        </button>
      </div>
      <button type="button" className={`zv-th zv-big item-page ${item.kind}`} title={item.title} aria-label={`Open ${item.kind}: ${item.title}`} onClick={controls.open}>
        <Page item={item.view} big />
      </button>
      {item.kind === 'browser' ? (
        <div className="item-line" title={item.view.line}>
          {item.sub || 'about:blank'}
        </div>
      ) : (
        item.body?.trim() && <pre className="item-note">{item.body.trim()}</pre>
      )}
      {users.length > 0 && (
        <div className="item-users">
          <em>used by</em>
          {users.slice(0, 4).map((user) => (
            <button key={user.id} type="button" className="item-user" title={`Open ${user.name}`} onClick={() => onAgent(user.id)}>
              <InkAvatar id={user.id} preset={user.preset} orch={user.orch} />
              <span>{user.name}</span>
            </button>
          ))}
          {users.length > 4 && <span className="item-more">+{users.length - 4}</span>}
        </div>
      )}
    </>
  )
}
