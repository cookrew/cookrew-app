import { useCallback, useMemo, useState } from 'react'
import { useActivitiesSnapshot, useThumb } from '../activity-thumb-store'
import { CrIcon } from '../icons'
import { activeBrowserTab, type WorkspaceState } from '../../../shared/model'
import type { AttachmentIndex } from '../terminal-attachments'
import { firstLine, hostPath, ownersOf } from '../stage/stage-select'
import { faviconOf, petMax, pickItems } from './pet-pick'
import { PetTroop, type CardControls } from './PetTroop'
import { thumbWants } from './thumb-wants'

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

interface ItemFace {
  readonly id: string
  readonly kind: 'browser' | 'note'
  readonly title: string
  readonly sub: string
  readonly owners: readonly string[]
  /** A browser's site icon, for when the Mac has no picture of the page. */
  readonly icon?: string | null
  /** A note's opening lines. */
  readonly body?: string
}

const NOTE_LINES = 8

export function ItemPets({
  workspace,
  attachIndex,
  onStage,
  onOpen
}: {
  workspace: WorkspaceState | null
  attachIndex: AttachmentIndex
  /** The agent whose terminal the stage shows: its items ride first. */
  onStage: string | null
  onOpen: (id: string, owners: readonly string[]) => void
}): React.JSX.Element | null {
  const activities = useActivitiesSnapshot()
  const owners = useMemo(() => ownersOf(attachIndex), [attachIndex])
  const names = useMemo(() => new Map((workspace?.nodes ?? []).flatMap((n) => (n.kind === 'terminal' ? [[n.id, n.name] as const] : []))), [workspace])
  // Newest first: nodes are kept in creation order.
  const items = useMemo<ItemFace[]>(() => {
    const out: ItemFace[] = []
    for (const n of [...(workspace?.nodes ?? [])].reverse()) {
      if (n.kind === 'browser') {
        const tab = activeBrowserTab(n)
        out.push({ id: n.id, kind: 'browser', title: tab.title?.trim() || n.name, sub: hostPath(tab.url), owners: owners.get(n.id) ?? [], icon: faviconOf(tab.url) })
      } else if (n.kind === 'note') {
        const content = n.content ?? ''
        out.push({ id: n.id, kind: 'note', title: n.name, sub: firstLine(content), owners: owners.get(n.id) ?? [], body: content.split('\n').slice(0, NOTE_LINES).join('\n') })
      }
    }
    return out
  }, [workspace, owners])
  // The agent on stage, then the agents that are working or need you.
  const focus = useMemo(() => {
    const busy = Object.entries(activities)
      .filter(([, activity]) => activity.phase === 'waiting' || activity.phase === 'thinking')
      .sort(([, a], [, b]) => (a.phase === 'waiting' ? 0 : 1) - (b.phase === 'waiting' ? 0 : 1))
      .map(([id]) => id)
    return onStage ? [onStage, ...busy.filter((id) => id !== onStage)] : busy
  }, [activities, onStage])
  const picked = useMemo(() => pickItems(items, { owners, focus, max: petMax(window.innerWidth) }), [items, owners, focus])
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const onShown = useCallback(
    (ids: readonly string[]) => thumbWants.claim('troop', ids.filter((id) => byId.get(id)?.kind === 'browser')),
    [byId]
  )
  const member = (item: ItemFace) => ({
    id: item.id,
    className: `item ${item.kind}${onStage && item.owners.includes(onStage) ? ' mine' : ''}`,
    label: `${item.kind === 'browser' ? 'Browser' : 'Note'}: ${item.title}`,
    name: item.title,
    face:
      item.kind === 'browser' ? (
        <BrowserFace id={item.id} icon={item.icon ?? null} title={item.title} />
      ) : (
        // A note's face is its first letter on paper, as the item coin draws it.
        <span className="cr-pet-note-face">{item.title.trim().charAt(0).toUpperCase() || '·'}</span>
      )
  })
  return (
    <PetTroop
      side="left"
      storageKey="cookrew.pets.items"
      label="browsers and notes"
      members={picked.shown.map(member)}
      more={picked.more.map(member)}
      onShown={onShown}
      onOpen={(id) => onOpen(id, byId.get(id)?.owners ?? [])}
      cardClass={(id) => `item ${byId.get(id)?.kind ?? ''}`}
      cardLabel={(id) => byId.get(id)?.title ?? 'Item'}
      renderCard={(id, controls) => {
        const item = byId.get(id)
        return item ? <ItemCard item={item} names={names} controls={controls} /> : null
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

function ItemCard({ item, names, controls }: { item: ItemFace; names: ReadonlyMap<string, string>; controls: CardControls }): React.JSX.Element {
  const thumb = useThumb(item.id)
  const whose = item.owners.map((id) => names.get(id) ?? '…')
  return (
    <>
      <div className="cr-pet-card-head">
        <span className="cr-pet-card-face item">
          <CrIcon name={item.kind === 'browser' ? 'browser' : 'note'} />
        </span>
        <span className="cr-pet-card-who">
          <span className="cr-pet-card-name">{item.title}</span>
          <span className="cr-pet-card-meta">
            <span className="cr-pet-mood">{item.kind}</span>
            {whose.length > 0 && <span>{whose.join(', ')}</span>}
          </span>
        </span>
        <button type="button" className="cr-pet-card-open" onClick={controls.open} title={item.kind === 'browser' ? 'Open the page' : 'Open the note'}>
          OPEN
        </button>
        <button type="button" className="cr-pet-card-x" onClick={controls.close} aria-label="Close">
          ×
        </button>
      </div>
      {item.kind === 'browser' ? (
        <>
          <div className="cr-pet-card-shot">
            {thumb ? <img src={thumb} alt={item.title} draggable={false} /> : <span>No picture yet — the Mac takes one while the page is open</span>}
          </div>
          <div className="cr-pet-card-url" title={item.sub}>
            {item.sub || 'about:blank'}
          </div>
        </>
      ) : (
        <pre className="cr-pet-card-note">{item.body?.trim() || 'An empty note.'}</pre>
      )}
    </>
  )
}
