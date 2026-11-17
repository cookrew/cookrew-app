import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CanvasNode } from '../../../shared/model'
import { cookrew } from '../api'
import type { AgentRow } from '../agent-rows'
import type { AttachmentIndex } from '../terminal-attachments'
import { ownersOf } from '../stage/stage-select'
import { stripPage } from '../pets/pet-dock'
import { thumbWants } from '../pets/thumb-wants'
import { itemFaceOf, type CrewFace } from '../pets/ItemPets'
import { InkAvatar } from './InkAvatar'
import { Page } from './ZoomParts'
import { agentViewOf, itemViewOf, type AgentView, type ItemView } from './zoom-model'
import { BAR_SIDES, type ZoomDir } from './zoom-path'
import { zoomStore } from './zoom-store'
import { barSeen, machineSeen, useSeenBook } from './bar-seen'
import { artifactInbox, useArtifacts, type ArtifactEntry } from './hitl-artifacts'
import { badgeOf, inboxRows, secondTap, type WorkspaceFace } from './bar-reach'
import { deckView } from './machine-view'
import { agentInbox, groupSize, sinceWord, withHeld, type AgentEntry } from './bar-inbox'
import { barCard, useBarCard, type FaceBox } from './bar-pick'
import { BarAgentCard, BarAwayCard, BarItemCard } from './BarCards'
import { pageInView } from '../page-in-view'
import { oneOrder, useRemoteHitl, type RemoteAgentEntry, type RemoteItemEntry } from './remote-hitl'
import { openRemoteFace, readRemoteReply } from './remote-open'
import { RemoteAgentCard, RemoteAgentFace, RemoteItemCard, RemoteItemFace } from './BarRemote'
import './bar-groups.css'

/**
 * THE BAR'S GROUPS ARE THE HUMAN-IN-THE-LOOP INBOX (owner, 2026-11-04; cut
 * docs/avatar-send-tasks/e-groups). The zoom bar's AGENTS | ARTIFACTS pair is
 * two groups in the troop's own form (pets.css · STACKED): stacked
 * thumbnails, stacked faces, a "+N" coin. ARTIFACTS first, AGENTS next to the
 * prompt's face. Each group is still its stop (a tap on it, off its faces,
 * goes there), lit in ink when current; its word stays in the DOM and is its
 * name. What it holds is what needs you (bar-inbox.ts): a phone shows 3 and
 * "+N" (turning a page of the stack), the desktop the word and 5; empty, the
 * word alone, as the stops did.
 *
 * Taps are the troop's: an agent's face opens its card above the bar, which
 * selects it (bar-pick.ts), so the box opens and its face flies to the chip
 * from this face; again, its full view. An artifact opens its card; again,
 * its full view. Looked at, it is handled (bar-seen.ts) and leaves the stack
 * once its card closes, ~220 ms out, the next sliding in from the right.
 *
 * EVERY WORKSPACE (owner, 2026-11-16; plan docs/hitl-cross-workspace-2026-11-15
 * · v6.2): AGENTS reads the whole crew, ARTIFACTS the activity log's agent
 * changes (hitl-artifacts.ts). A face from another workspace wears its mark
 * (bar-reach.ts) and opens a read-only card; the second tap, or Open, jumps
 * there (onJump · canvas-ui.ts jumpToNode).
 *
 * EVERY MACHINE (phase 6): what needs you on the account's other machines is in
 * the same two groups, in one order with this machine's (remote-hitl.ts). Its
 * faces wear their machine's mark too (BarRemote.tsx), open a read-only card,
 * and the second tap, or Open, enters that machine (remote-open.ts).
 */

const STACK_MS = 220

/** Another workspace's agent holds no attachments here: its notes and browsers are another canvas's. */
const NO_ATTACHMENTS: AttachmentIndex = new Map()
/** A workspace the list does not name yet: its faces are still marked as away. */
const SOMEWHERE: WorkspaceFace = { name: 'another workspace', icon: '•' }
const kindWord = (kind: 'browser' | 'note'): string => (kind === 'browser' ? 'Browser' : 'Note')

/** The full view the zoom holds, if any, as one key: the groups do not redraw on every step of the zoom. */
function useFullView(): { full: 'agent' | 'item' | null; id: string | null } {
  const key = useSyncExternalStore(zoomStore.subscribe, () => {
    const z = zoomStore.get()
    return z.full === 'agent' ? `agent ${z.agent ?? ''}` : z.full === 'item' ? `item ${z.item ?? ''}` : ''
  }, () => '')
  const [full, id] = key.split(' ')
  return { full: full === 'agent' || full === 'item' ? full : null, id: id || null }
}

const boxOf = (r: DOMRect): FaceBox => ({ left: r.left, top: r.top, width: r.width, height: r.height })

/** The open card's face stays in the stack where it stood, though it was handled when the card opened. */
function useHeld(ids: readonly string[], held: string | null): string[] {
  const last = useRef<readonly string[]>([])
  const key = ids.join(' ')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const out = useMemo(() => withHeld(ids, last.current, held), [key, held])
  useEffect(() => {
    last.current = out
  }, [out])
  return out
}

/** The stack as drawn: who just came (slides in from the right), who just left (still drawn ~220 ms, going). */
function useStack(ids: readonly string[]): { order: readonly string[]; entering: ReadonlySet<string>; leaving: ReadonlySet<string> } {
  const prev = useRef<readonly string[]>(ids)
  const drawn = useRef<readonly string[]>(ids)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const [leaving, setLeaving] = useState<readonly string[]>([])
  const key = ids.join(' ')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const entering = useMemo(() => new Set(ids.filter((id) => !prev.current.includes(id))), [key])
  useLayoutEffect(() => {
    const gone = prev.current.filter((id) => !ids.includes(id))
    prev.current = ids
    if (gone.length === 0) return
    setLeaving((at) => [...at.filter((id) => !ids.includes(id) && !gone.includes(id)), ...gone])
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      setLeaving((at) => at.filter((id) => !gone.includes(id) || ids.includes(id)))
    }, STACK_MS)
    timers.current.add(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => {
    const all = timers.current
    return () => all.forEach(clearTimeout)
  }, [])
  const going = leaving.filter((id) => !ids.includes(id))
  const order = going.reduce<string[]>((acc, id) => withHeld(acc, drawn.current, id), [...ids])
  drawn.current = order
  return { order, entering, leaving: new Set(going) }
}

/** One group's page: as many as it shows, the "+N" that turns to the next, "–" back to the first. */
function usePage(total: number, size: number): { start: number; end: number; more: string | null; moreLabel: string; turn: () => void } {
  const [page, setPage] = useState(0)
  const paged = stripPage(total, size, page)
  useEffect(() => {
    if (total <= size) setPage(0)
  }, [total, size])
  const more = total <= size ? null : paged.last ? '–' : `+${paged.rest}`
  return { start: paged.start, end: paged.end, more, moreLabel: paged.last ? 'Back to the first' : `${paged.rest} more`, turn: () => setPage((p) => p + 1) }
}

export function BarGroups({ workspaceId, nodes, rows, all, workspaces, agents, attachIndex, side, narrow, onStop, onAgentFull, onItemFull, onJump, onDelete, onOutside }: {
  workspaceId: string | null
  /** The open workspace's cards: its artifacts' faces and cards draw from them. */
  nodes: readonly CanvasNode[] | null
  /** The open workspace's crew (agent-rows.ts · crewOf). */
  rows: readonly AgentRow[]
  /** Every workspace's agents (stage/crew-rows.ts · Crew.all). */
  all: readonly AgentRow[]
  /** Every workspace's name, icon and served mark, by id. */
  workspaces: ReadonlyMap<string, WorkspaceFace>
  agents: ReadonlyMap<string, AgentView>
  attachIndex: AttachmentIndex
  /** The side the view is in, once it is in the workspace; null above it. */
  side: ZoomDir | null
  narrow: boolean
  onStop: (v: number, dir: ZoomDir) => void
  onAgentFull: (id: string) => void
  onItemFull: (id: string) => void
  /** To a card of another workspace (canvas-ui.ts · jumpToNode). */
  onJump: (workspaceId: string, id: string) => void
  onDelete?: (id: string) => void
  /** Whether a press there is on the zoom's page (its click is eaten), not the bar or the header. */
  onOutside: (target: EventTarget | null) => boolean
}): React.JSX.Element {
  const book = useSeenBook()
  const artifacts = useArtifacts()
  const remote = useRemoteHitl()
  const card = useBarCard()
  const zoom = useFullView()
  const owners = useMemo(() => ownersOf(attachIndex), [attachIndex])
  // The open workspace's browsers and notes: their faces and cards are drawn from the nodes.
  const nodeOf = useMemo(() => new Map((nodes ?? []).filter((n) => n.kind === 'browser' || n.kind === 'note').map((n) => [n.id, n])), [nodes])
  const wsOf = (id: string): WorkspaceFace => workspaces.get(id) ?? SOMEWHERE

  // AGENTS: the open workspace's crew, then every other workspace's (bar-reach.ts).
  const reach = useMemo(() => inboxRows(rows, all, workspaceId, workspaces), [rows, all, workspaceId, workspaces])
  const rowById = useMemo(() => new Map(all.map((r) => [r.id, r])), [all])
  const awayViews = useMemo(
    () => new Map(reach.filter((r) => !agents.has(r.id)).map((r) => [r.id, agentViewOf(r, NO_ATTACHMENTS)])),
    [reach, agents]
  )
  /** This workspace's view of an agent, else one of another workspace's, from its row. */
  const viewOfAgent = (id: string): AgentView | null => {
    const own = agents.get(id) ?? awayViews.get(id)
    if (own) return own
    const row = rowById.get(id)
    return row ? agentViewOf(row, NO_ATTACHMENTS) : null
  }
  /** Another workspace's agent: the open workspace's are the ones its view draws. */
  const agentAway = (id: string): boolean => !agents.has(id)
  // An open-workspace row the view does not draw is no face of anywhere: left out, as before.
  const agentEntries = useMemo(
    () => agentInbox(reach).filter((e) => agents.has(e.id) || (rowById.has(e.id) && rowById.get(e.id)?.workspaceId !== workspaceId)),
    [reach, agents, rowById, workspaceId]
  )

  // ARTIFACTS: what an agent changed since you looked, every workspace (hitl-artifacts.ts).
  const itemEntries = useMemo(
    () => artifactInbox(artifacts.entries.values(), book, { workspaces, here: workspaceId, onCanvas: (id) => nodeOf.has(id) }),
    [artifacts, book, workspaces, workspaceId, nodeOf]
  )
  const entryOf = (id: string): ArtifactEntry | undefined => artifacts.entries.get(id)
  /** Another workspace's artifact: not on the open canvas, whatever the log named (a team move sends none). */
  const itemAway = (id: string): boolean => {
    const entry = entryOf(id)
    return !nodeOf.has(id) && entry !== undefined && entry.workspaceId !== workspaceId
  }
  // The book keeps only what is still an artifact, once it grows big: only once the
  // boot read has landed, or every card would look unknown and be forgotten.
  useEffect(() => {
    if (artifacts.ready) barSeen.prune((id) => artifacts.entries.has(id))
  }, [artifacts])
  // A full view opened is a look, and so is every change seen while it is open
  // with the window in view (page-in-view.ts). An agent's is its overlay's to say.
  const fullItem = zoom.full === 'item' ? zoom.id : null
  const fullAt = fullItem ? (entryOf(fullItem)?.at ?? null) : null
  useEffect(() => {
    if (fullItem && fullAt !== null && pageInView()) barSeen.mark(fullItem, fullAt)
  }, [fullItem, fullAt])

  const agentById = useMemo(() => new Map(agentEntries.map((e) => [e.id, e])), [agentEntries])
  // One order across this machine and the others: waiting first, then replies and news, newest first within.
  const reachAt = useMemo(() => new Map(reach.map((r) => [r.id, r.lastActivityAt])), [reach])
  const agentOrder = useMemo(
    () => oneOrder([...agentEntries.map((e) => ({ key: e.id, why: e.why, at: reachAt.get(e.id) ?? 0 })), ...remote.agents]).map((e) => e.key),
    [agentEntries, reachAt, remote.agents]
  )
  const itemOrder = useMemo(
    () => oneOrder([...itemEntries.map((e) => ({ key: e.id, at: e.at })), ...remote.items].map((e) => ({ key: e.key, why: 'news' as const, at: e.at }))).map((e) => e.key),
    [itemEntries, remote.items]
  )
  const agentIds = useHeld(agentOrder, card?.kind === 'agent' ? card.id : null)
  const itemIds = useHeld(itemOrder, card?.kind === 'item' ? card.id : null)
  // What each held face was when its card opened: still drawn, though no longer in the inbox.
  const lastAgent = useRef(new Map<string, AgentEntry>())
  for (const e of agentEntries) lastAgent.current.set(e.id, e)
  // Another machine's faces, by key; as with this machine's, the last of each stays drawn while its card is open.
  const lastRemoteAgent = useRef(new Map<string, RemoteAgentEntry>())
  const lastRemoteItem = useRef(new Map<string, RemoteItemEntry>())
  for (const e of remote.agents) lastRemoteAgent.current.set(e.key, e)
  for (const e of remote.items) lastRemoteItem.current.set(e.key, e)
  const remoteAgentOf = (key: string): RemoteAgentEntry | undefined => lastRemoteAgent.current.get(key)
  const remoteItemOf = (key: string): RemoteItemEntry | undefined => lastRemoteItem.current.get(key)

  const size = groupSize(narrow)
  const agentPage = usePage(agentIds.length, size)
  const itemPage = usePage(itemIds.length, size)
  const agentStack = useStack(agentIds.slice(agentPage.start, agentPage.end))
  const itemStack = useStack(itemIds.slice(itemPage.start, itemPage.end))

  // The open workspace's browsers want their pictures (thumb-wants.ts), as the troop's do.
  const shownBrowsers = itemStack.order.filter((id) => nodeOf.get(id)?.kind === 'browser').join(' ')
  useEffect(() => {
    thumbWants.claim('bar', shownBrowsers ? shownBrowsers.split(' ') : [])
  }, [shownBrowsers])
  useEffect(() => () => thumbWants.release('bar'), [])

  /** An artifact's face: its node here, else what the log named it (machine-view.ts · deckView). */
  const viewOf = (id: string): ItemView | null => {
    const n = nodeOf.get(id)
    if (n) return itemViewOf(n, owners.get(id) ?? [])
    const entry = entryOf(id)
    return entry ? deckView({ id, kind: entry.kind, title: entry.title }) : null
  }

  // The card closes when what it shows is gone, or the view leaves for a full view or another workspace.
  useEffect(() => {
    if (!card) return
    const here = card.kind === 'agent' ? agents.has(card.id) || rowById.has(card.id) : nodeOf.has(card.id) || artifacts.entries.has(card.id)
    // Another machine's stays while that machine still holds it, read or not.
    if ((!here && !remote.known.has(card.id)) || zoom.full !== null) barCard.close()
  }, [card, agents, rowById, nodeOf, artifacts, remote.known, zoom.full])
  useEffect(() => () => barCard.close(), [workspaceId])
  // An agent changing an artifact while its card is open: that change is seen too.
  const openItemAt = card?.kind === 'item' ? (entryOf(card.id)?.at ?? null) : null
  useEffect(() => {
    if (card?.kind === 'item' && openItemAt !== null) barSeen.mark(card.id, openItemAt)
  }, [card, openItemAt])
  // Another machine's, in that machine's own book.
  const openRemote = card?.kind === 'item' ? remote.items.find((e) => e.key === card.id) : undefined
  useEffect(() => {
    if (openRemote) machineSeen.mark(openRemote.machineId, openRemote.id, openRemote.at)
  }, [openRemote])

  const faces = useRef(new Map<string, HTMLButtonElement>())
  const faceRef = (key: string) => (el: HTMLButtonElement | null): void => {
    if (el) faces.current.set(key, el)
    else faces.current.delete(key)
  }
  /** The second tap: the full view here, or the jump to the workspace it is in. */
  const goTo = (itsWorkspace: string | undefined, id: string, full: (id: string) => void): void => {
    if (itsWorkspace && secondTap(itsWorkspace, workspaceId) === 'jump') return onJump(itsWorkspace, id)
    full(id)
  }
  /** Another machine's face: a read-only card, then into that machine. Never the box's. */
  const tapRemote = (kind: 'agent' | 'item', e: RemoteAgentEntry | RemoteItemEntry, face: Parameters<typeof openRemoteFace>[0]): void => {
    const open = barCard.get()
    if (open?.kind === kind && open.id === e.key) {
      barCard.close()
      return openRemoteFace(face)
    }
    barCard.open(kind === 'agent' ? { kind: 'agent', id: e.key, away: true } : { kind: 'item', id: e.key, away: true })
  }
  const agentFace = (e: RemoteAgentEntry): Parameters<typeof openRemoteFace>[0] => ({ ...e, kind: 'agent', id: e.agentId, name: e.name })
  const itemFace = (e: RemoteItemEntry): Parameters<typeof openRemoteFace>[0] => ({ ...e, kind: 'item', id: e.id, name: e.title, itemKind: e.kind })
  const tapAgent = (id: string, el: HTMLElement): void => {
    const far = remoteAgentOf(id)
    if (far) {
      tapRemote('agent', far, agentFace(far))
      if (far.why === 'reply' && barCard.get()?.id === id) readRemoteReply(far.machineId, far.agentId)
      return
    }
    const away = agentAway(id)
    const open = barCard.get()
    if (open?.kind === 'agent' && open.id === id) {
      barCard.close()
      return goTo(away ? rowById.get(id)?.workspaceId : (workspaceId ?? undefined), id, onAgentFull)
    }
    // Another workspace's card is read-only: it selects nobody for the box, and no face flies.
    if (away) barCard.open({ kind: 'agent', id, away: true })
    else barCard.open({ kind: 'agent', id }, boxOf(el.getBoundingClientRect()))
    if (agentById.get(id)?.why === 'reply') cookrew().turnSeen(id)
  }
  const tapItem = (id: string): void => {
    const far = remoteItemOf(id)
    if (far) {
      tapRemote('item', far, itemFace(far))
      if (barCard.get()?.id === id) machineSeen.mark(far.machineId, far.id, far.at)
      return
    }
    const open = barCard.get()
    const entry = entryOf(id)
    if (open?.kind === 'item' && open.id === id) {
      barCard.close()
      return goTo(itemAway(id) ? entry?.workspaceId : (workspaceId ?? undefined), id, onItemFull)
    }
    // No flight from a thumbnail: only an agent's card puts a face in the box.
    barCard.open(itemAway(id) ? { kind: 'item', id, away: true } : { kind: 'item', id })
    if (entry) barSeen.mark(id, entry.at)
  }

  const crewFaces = useMemo(() => new Map<string, CrewFace>([...agents].map(([id, a]) => [id, { name: a.name, preset: a.preset, orch: a.orch }])), [agents])
  const motionOf = (stack: { entering: ReadonlySet<string>; leaving: ReadonlySet<string> }, id: string): string =>
    stack.leaving.has(id) ? ' out' : stack.entering.has(id) ? ' in' : ''

  const isOpen = (kind: 'agent' | 'item', id: string): string => (card?.kind === kind && card.id === id ? ' open' : '')
  const agentFaces = agentStack.order.flatMap((id) => {
    const far = remoteAgentOf(id)
    if (far) {
      return [<RemoteAgentFace key={id} entry={far} state={`${motionOf(agentStack, id)}${isOpen('agent', id)}`} out={agentStack.leaving.has(id)} faceRef={faceRef(`agent:${id}`)} onTap={(el) => tapAgent(id, el)} />]
    }
    const a = viewOfAgent(id)
    const why = (agentById.get(id) ?? lastAgent.current.get(id))?.why ?? 'reply'
    if (!a) return []
    const word = why === 'waiting' ? 'needs you' : 'replied'
    const out = agentStack.leaving.has(id)
    const ws = agentAway(id) ? wsOf(rowById.get(id)?.workspaceId ?? '') : null
    const where = ws ? `, in ${ws.name}` : ''
    return [
      <button key={id} ref={faceRef(`agent:${id}`)} type="button" tabIndex={out ? -1 : undefined} aria-hidden={out || undefined}
        className={`zv-gf agent ${why}${ws ? ' away' : ''}${motionOf(agentStack, id)}${card?.kind === 'agent' && card.id === id ? ' open' : ''}`}
        aria-label={`${a.name}, ${word}${where}`} title={`${a.name} · ${word}${ws ? ` · ${ws.name}` : ''}`} onClick={(e) => tapAgent(id, e.currentTarget)}>
        <InkAvatar id={a.id} preset={a.preset} orch={a.orch} status={a.status} />
        {why === 'waiting' && <span className="zv-gf-dot" aria-hidden="true" />}
        {ws && <span className="zv-gf-ws" aria-hidden="true">{badgeOf(ws)}</span>}
      </button>
    ]
  })
  const itemFaces = itemStack.order.flatMap((id) => {
    const far = remoteItemOf(id)
    if (far) {
      return [<RemoteItemFace key={id} entry={far} state={`${motionOf(itemStack, id)}${isOpen('item', id)}`} out={itemStack.leaving.has(id)} faceRef={faceRef(`item:${id}`)} onTap={() => tapItem(id)} />]
    }
    const view = viewOf(id)
    if (!view) return []
    const ws = itemAway(id) ? wsOf(entryOf(id)?.workspaceId ?? '') : null
    const by = view.owners.map((o) => agents.get(o)?.name).filter((n): n is string => !!n)
    const label = `${kindWord(view.kind)}: ${view.title}${by.length ? `, made by ${by.join(', ')}` : ''}${ws ? `, in ${ws.name}` : ''}, new`
    const out = itemStack.leaving.has(id)
    return [
      <button key={id} ref={faceRef(`item:${id}`)} type="button" tabIndex={out ? -1 : undefined} aria-hidden={out || undefined}
        className={`zv-gf item ${view.kind}${ws ? ' away' : ''}${motionOf(itemStack, id)}${card?.kind === 'item' && card.id === id ? ' open' : ''}`}
        aria-label={label} title={label} onClick={() => tapItem(id)}>
        <span className={`zv-th ${view.kind}`} aria-hidden="true">
          <Page item={view} words={false} />
        </span>
        {ws && <span className="zv-gf-ws" aria-hidden="true">{badgeOf(ws)}</span>}
      </button>
    ]
  })

  const group = (s: (typeof BAR_SIDES)[number]): React.JSX.Element => {
    const isAgents = s.dir === 'agents'
    const stack = isAgents ? agentFaces : itemFaces
    const count = isAgents ? agentOrder.length : itemOrder.length
    const turn = isAgents ? agentPage : itemPage
    const lit = side === s.dir
    return (
      <div key={s.dir} className={`zv-group ${s.dir}${lit ? ' lit' : ''}${stack.length ? ' full' : ' empty'}`} role="group" aria-label={count ? `${s.name}: ${count} need you` : s.name}>
        <button type="button" className="zv-group-stop" aria-current={lit ? 'step' : undefined} aria-label={s.name} onClick={() => onStop(s.v, s.dir)}>
          <span className="zv-group-word">{s.name}</span>
        </button>
        {stack.length > 0 && <span className="zv-group-stack">{stack}</span>}
        {stack.length > 0 && turn.more && (
          <button type="button" className="zv-group-more" title={turn.moreLabel} aria-label={turn.moreLabel} onClick={turn.turn}>
            {turn.more}
          </button>
        )}
      </div>
    )
  }

  const now = Date.now()
  const cardAgent = card?.kind === 'agent' ? viewOfAgent(card.id) : null
  const cardNode = card?.kind === 'item' && card.away !== true ? (nodeOf.get(card.id) ?? null) : null
  const cardItem = cardNode ? itemFaceOf(cardNode, owners.get(cardNode.id) ?? []) : null
  const awayItem = card?.kind === 'item' && card.away === true ? viewOf(card.id) : null
  const awayEntry = card ? entryOf(card.id) : undefined
  const farAgent = card?.kind === 'agent' ? remoteAgentOf(card.id) : undefined
  const farItem = card?.kind === 'item' ? remoteItemOf(card.id) : undefined
  const closeAnd = (fn: () => void) => (): void => {
    barCard.close()
    fn()
  }
  return (
    <>
      <div className="zv-groups" role="group" aria-label="Artifacts or agents">
        {BAR_SIDES.map(group)}
      </div>
      {cardAgent && card?.away !== true && (
        <BarAgentCard
          key={`agent:${cardAgent.id}`}
          agent={cardAgent}
          items={(attachIndex.get(cardAgent.id) ?? []).flatMap((at) => itemViewOf(at.node, [cardAgent.id]) ?? [])}
          anchor={faces.current.get(`agent:${cardAgent.id}`) ?? null}
          onOpen={closeAnd(() => onAgentFull(cardAgent.id))}
          onItem={(itemId) => {
            barCard.close()
            onItemFull(itemId)
          }}
          onDelete={onDelete ? closeAnd(() => onDelete(cardAgent.id)) : undefined}
          onOutside={onOutside}
          onClose={barCard.close}
        />
      )}
      {cardAgent && card?.away === true && (
        <BarAwayCard
          key={`away-agent:${cardAgent.id}`}
          face={<InkAvatar id={cardAgent.id} preset={cardAgent.preset} orch={cardAgent.orch} status={cardAgent.status} />}
          title={cardAgent.name}
          where={wsOf(rowById.get(cardAgent.id)?.workspaceId ?? '').name}
          line={`${cardAgent.word} · ${cardAgent.line}`}
          anchor={faces.current.get(`agent:${cardAgent.id}`) ?? null}
          onOpen={closeAnd(() => goTo(rowById.get(cardAgent.id)?.workspaceId, cardAgent.id, onAgentFull))}
          onOutside={onOutside}
          onClose={barCard.close}
        />
      )}
      {cardItem && (
        <BarItemCard
          key={`item:${cardItem.id}`}
          item={cardItem}
          crew={crewFaces}
          since={sinceWord(entryOf(cardItem.id)?.at ?? null, now)}
          anchor={faces.current.get(`item:${cardItem.id}`) ?? null}
          onOpen={closeAnd(() => onItemFull(cardItem.id))}
          onAgent={(agentId) => {
            barCard.close()
            onAgentFull(agentId)
          }}
          onOutside={onOutside}
          onClose={barCard.close}
        />
      )}
      {awayItem && awayEntry && (
        <BarAwayCard
          key={`away-item:${awayItem.id}`}
          face={<span className={`zv-th ${awayItem.kind}`}><Page item={awayItem} words={false} /></span>}
          title={awayItem.title}
          where={wsOf(awayEntry.workspaceId).name}
          line={`${kindWord(awayItem.kind)} an agent changed`}
          since={sinceWord(awayEntry.at, now)}
          anchor={faces.current.get(`item:${awayItem.id}`) ?? null}
          onOpen={closeAnd(() => goTo(awayEntry.workspaceId, awayItem.id, onItemFull))}
          onOutside={onOutside}
          onClose={barCard.close}
        />
      )}
      {farAgent && (
        <RemoteAgentCard key={`far-agent:${farAgent.key}`} entry={farAgent} anchor={faces.current.get(`agent:${farAgent.key}`) ?? null}
          onOpen={closeAnd(() => openRemoteFace(agentFace(farAgent)))} onOutside={onOutside} onClose={barCard.close} />
      )}
      {farItem && (
        <RemoteItemCard key={`far-item:${farItem.key}`} entry={farItem} now={now} anchor={faces.current.get(`item:${farItem.key}`) ?? null}
          onOpen={closeAnd(() => openRemoteFace(itemFace(farItem)))} onOutside={onOutside} onClose={barCard.close} />
      )}
    </>
  )
}
