import { InkAvatar } from './InkAvatar'
import { Page } from './ZoomParts'
import { deckView } from './machine-view'
import { badgeOf } from './bar-reach'
import { sinceWord } from './bar-inbox'
import { BarAwayCard } from './BarCards'
import { machineMark, remoteAgentLabel, remoteItemLabel, type RemoteAgentEntry, type RemoteItemEntry } from './remote-hitl'

/**
 * A FACE OF ANOTHER MACHINE IN THE BAR'S GROUPS, AND ITS CARD (phase 6, plan
 * docs/hitl-cross-workspace-2026-11-15 · v6.2; remote-hitl.ts). It wears its
 * workspace's mark, as another workspace's face does, and its machine's: the
 * seal's dashed ring and the machine's initial. Its card is read-only, "in
 * <workspace> · on <machine>"; the box never speaks to it.
 */

const wsFace = (e: { workspaceName: string; workspaceIcon: string | null }): { name: string; icon: string | null } => ({ name: e.workspaceName, icon: e.workspaceIcon })

function Marks({ entry }: { entry: RemoteAgentEntry | RemoteItemEntry }): React.JSX.Element {
  return (
    <>
      <span className="zv-gf-ws" aria-hidden="true">{badgeOf(wsFace(entry))}</span>
      <span className="zv-gf-mc" aria-hidden="true">{machineMark(entry.machineName)}</span>
    </>
  )
}

interface FaceProps<T> {
  entry: T
  /** ' in', ' out', ' open': how the stack draws it now. */
  state: string
  out: boolean
  faceRef: (el: HTMLButtonElement | null) => void
  onTap: (el: HTMLElement) => void
}

const avatarOf = (e: RemoteAgentEntry): React.JSX.Element => (
  <InkAvatar id={e.agentId} preset={e.harness} orch={e.orch} status={e.why === 'waiting' ? 'waiting' : 'done'} />
)

export function RemoteAgentFace({ entry, state, out, faceRef, onTap }: FaceProps<RemoteAgentEntry>): React.JSX.Element {
  const label = remoteAgentLabel(entry)
  return (
    <button ref={faceRef} type="button" tabIndex={out ? -1 : undefined} aria-hidden={out || undefined}
      className={`zv-gf agent ${entry.why} away remote${state}`} aria-label={label} title={label} onClick={(e) => onTap(e.currentTarget)}>
      {avatarOf(entry)}
      {entry.why === 'waiting' && <span className="zv-gf-dot" aria-hidden="true" />}
      <Marks entry={entry} />
    </button>
  )
}

const itemView = (e: RemoteItemEntry): ReturnType<typeof deckView> => deckView({ id: e.id, kind: e.kind, title: e.title })

export function RemoteItemFace({ entry, state, out, faceRef, onTap }: FaceProps<RemoteItemEntry>): React.JSX.Element {
  const label = remoteItemLabel(entry)
  const view = itemView(entry)
  return (
    <button ref={faceRef} type="button" tabIndex={out ? -1 : undefined} aria-hidden={out || undefined}
      className={`zv-gf item ${entry.kind} away remote${state}`} aria-label={label} title={label} onClick={(e) => onTap(e.currentTarget)}>
      <span className={`zv-th ${view.kind}`} aria-hidden="true">
        <Page item={view} words={false} />
      </span>
      <Marks entry={entry} />
    </button>
  )
}

interface CardProps<T> {
  entry: T
  anchor: HTMLElement | null
  onOpen: () => void
  onOutside: (target: EventTarget | null) => boolean
  onClose: () => void
}

export function RemoteAgentCard({ entry, anchor, onOpen, onOutside, onClose }: CardProps<RemoteAgentEntry>): React.JSX.Element {
  const word = entry.why === 'waiting' ? 'needs you' : 'replied'
  return (
    <BarAwayCard face={avatarOf(entry)} title={entry.name} where={entry.workspaceName} machine={entry.machineName}
      line={entry.line ? `${word} · ${entry.line}` : word} anchor={anchor} onOpen={onOpen} onOutside={onOutside} onClose={onClose} />
  )
}

export function RemoteItemCard({ entry, anchor, onOpen, onOutside, onClose, now }: CardProps<RemoteItemEntry> & { now: number }): React.JSX.Element {
  const view = itemView(entry)
  return (
    <BarAwayCard face={<span className={`zv-th ${view.kind}`}><Page item={view} words={false} /></span>} title={entry.title} where={entry.workspaceName}
      machine={entry.machineName} line={`${entry.kind === 'browser' ? 'Browser' : 'Note'} an agent changed`} since={sinceWord(entry.at, now)}
      anchor={anchor} onOpen={onOpen} onOutside={onOutside} onClose={onClose} />
  )
}
