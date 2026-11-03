import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CanvasNode } from '../../../shared/model'
import type { AgentRow } from '../agent-rows'
import type { AttachmentIndex } from '../terminal-attachments'
import { ownersOf } from '../stage/stage-select'
import { stripPage } from '../pets/pet-dock'
import { thumbWants } from '../pets/thumb-wants'
import { itemFaceOf, type CrewFace } from '../pets/ItemPets'
import { InkAvatar } from './InkAvatar'
import { Page } from './ZoomParts'
import { itemViewOf, type AgentView, type ItemView } from './zoom-model'
import { BAR_SIDES, type ZoomDir } from './zoom-path'
import { zoomStore } from './zoom-store'
import { barSeen, itemSig, replySig, useSeenPage } from './bar-seen'
import { agentInbox, groupSize, itemInbox, sinceWord, withHeld, type AgentEntry, type ItemEntry } from './bar-inbox'
import { barCard, useBarCard, type FaceBox } from './bar-pick'
import { BarAgentCard, BarItemCard } from './BarCards'
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
 */

const STACK_MS = 220

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

export function BarGroups({ workspaceId, nodes, rows, agents, attachIndex, side, narrow, onStop, onAgentFull, onItemFull, onDelete, onOutside }: {
  workspaceId: string | null
  /** The open workspace's cards; null while it loads (no baseline is set from nothing). */
  nodes: readonly CanvasNode[] | null
  /** The open workspace's crew (agent-rows.ts · crewOf). */
  rows: readonly AgentRow[]
  agents: ReadonlyMap<string, AgentView>
  attachIndex: AttachmentIndex
  /** The side the view is in, once it is in the workspace; null above it. */
  side: ZoomDir | null
  narrow: boolean
  onStop: (v: number, dir: ZoomDir) => void
  onAgentFull: (id: string) => void
  onItemFull: (id: string) => void
  onDelete?: (id: string) => void
  /** Whether a press there is on the zoom's page (its click is eaten), not the bar or the header. */
  onOutside: (target: EventTarget | null) => boolean
}): React.JSX.Element {
  const page = useSeenPage(workspaceId)
  const card = useBarCard()
  const zoom = useFullView()
  const owners = useMemo(() => ownersOf(attachIndex), [attachIndex])
  // The browsers and notes, newest made first, each with what it is now.
  const itemNodes = useMemo(() => (nodes ?? []).filter((n) => n.kind === 'browser' || n.kind === 'note').reverse(), [nodes])
  const nodeOf = useMemo(() => new Map(itemNodes.map((n) => [n.id, n])), [itemNodes])
  const sigs = useMemo(() => itemNodes.flatMap((n) => {
    const sig = itemSig(n)
    return sig ? [{ id: n.id, sig }] : []
  }), [itemNodes])
  const loaded = nodes !== null
  useEffect(() => {
    if (workspaceId && loaded) barSeen.observe(workspaceId, sigs)
  }, [workspaceId, loaded, sigs])
  // A full view opened is a look, and so is every change seen while it is open.
  const fullItem = zoom.full === 'item' ? zoom.id : null
  const fullItemSig = fullItem ? sigs.find((s) => s.id === fullItem)?.sig ?? null : null
  useEffect(() => {
    if (workspaceId && fullItem && fullItemSig) barSeen.mark(workspaceId, fullItem, fullItemSig)
  }, [workspaceId, fullItem, fullItemSig])
  const fullRow = zoom.full === 'agent' && zoom.id ? rows.find((r) => r.id === zoom.id) ?? null : null
  const fullReply = fullRow ? replySig(fullRow) : null
  useEffect(() => {
    if (workspaceId && fullRow && fullReply) barSeen.mark(workspaceId, fullRow.id, fullReply)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, fullRow?.id, fullReply])

  const agentEntries = useMemo(() => agentInbox(rows, page).filter((e) => agents.has(e.id)), [rows, page, agents])
  const itemEntries = useMemo(() => itemInbox(sigs, page), [sigs, page])
  const agentById = useMemo(() => new Map(agentEntries.map((e) => [e.id, e])), [agentEntries])
  const itemById = useMemo(() => new Map(itemEntries.map((e) => [e.id, e])), [itemEntries])
  const agentIds = useHeld(useMemo(() => agentEntries.map((e) => e.id), [agentEntries]), card?.kind === 'agent' ? card.id : null)
  const itemIds = useHeld(useMemo(() => itemEntries.map((e) => e.id), [itemEntries]), card?.kind === 'item' ? card.id : null)
  // What each held face was when its card opened: still drawn, though no longer in the inbox.
  const lastAgent = useRef(new Map<string, AgentEntry>())
  const lastItem = useRef(new Map<string, ItemEntry>())
  for (const e of agentEntries) lastAgent.current.set(e.id, e)
  for (const e of itemEntries) lastItem.current.set(e.id, e)

  const size = groupSize(narrow)
  const agentPage = usePage(agentIds.length, size)
  const itemPage = usePage(itemIds.length, size)
  const agentStack = useStack(agentIds.slice(agentPage.start, agentPage.end))
  const itemStack = useStack(itemIds.slice(itemPage.start, itemPage.end))

  // The browsers' faces want their pictures (thumb-wants.ts), as the troop's do.
  const shownBrowsers = itemStack.order.filter((id) => nodeOf.get(id)?.kind === 'browser').join(' ')
  useEffect(() => {
    thumbWants.claim('bar', shownBrowsers ? shownBrowsers.split(' ') : [])
  }, [shownBrowsers])
  useEffect(() => () => thumbWants.release('bar'), [])

  const viewOf = (id: string): ItemView | null => {
    const n = nodeOf.get(id)
    return n ? itemViewOf(n, owners.get(id) ?? []) : null
  }

  // The card closes when what it shows is gone, or the view leaves for a full view or another workspace.
  useEffect(() => {
    if (!card) return
    const gone = card.kind === 'agent' ? !agents.has(card.id) : !nodeOf.has(card.id)
    if (gone || zoom.full !== null) barCard.close()
  }, [card, agents, nodeOf, zoom.full])
  useEffect(() => () => barCard.close(), [workspaceId])

  const faces = useRef(new Map<string, HTMLButtonElement>())
  const faceRef = (key: string) => (el: HTMLButtonElement | null): void => {
    if (el) faces.current.set(key, el)
    else faces.current.delete(key)
  }
  /** "Since" captured when the card opened: looking at it forgets when it was noticed. */
  const since = useRef<number | null>(null)
  const tapAgent = (id: string, el: HTMLElement): void => {
    const open = barCard.get()
    if (open?.kind === 'agent' && open.id === id) {
      barCard.close()
      return onAgentFull(id)
    }
    barCard.open({ kind: 'agent', id }, boxOf(el.getBoundingClientRect()))
    const entry = agentById.get(id)
    if (workspaceId && entry?.why === 'reply') barSeen.mark(workspaceId, id, entry.sig)
  }
  const tapItem = (id: string, el: HTMLElement): void => {
    const open = barCard.get()
    if (open?.kind === 'item' && open.id === id) {
      barCard.close()
      return onItemFull(id)
    }
    const entry = itemById.get(id)
    since.current = entry?.at ?? null
    barCard.open({ kind: 'item', id }, boxOf(el.getBoundingClientRect()))
    if (workspaceId && entry) barSeen.mark(workspaceId, id, entry.sig)
  }

  const crewFaces = useMemo(() => new Map<string, CrewFace>([...agents].map(([id, a]) => [id, { name: a.name, preset: a.preset, orch: a.orch }])), [agents])
  const motionOf = (stack: { entering: ReadonlySet<string>; leaving: ReadonlySet<string> }, id: string): string =>
    stack.leaving.has(id) ? ' out' : stack.entering.has(id) ? ' in' : ''

  const agentFaces = agentStack.order.flatMap((id) => {
    const a = agents.get(id)
    const why = (agentById.get(id) ?? lastAgent.current.get(id))?.why ?? 'reply'
    if (!a) return []
    const word = why === 'waiting' ? 'needs you' : 'replied'
    const out = agentStack.leaving.has(id)
    return [
      <button key={id} ref={faceRef(`agent:${id}`)} type="button" tabIndex={out ? -1 : undefined} aria-hidden={out || undefined}
        className={`zv-gf agent ${why}${motionOf(agentStack, id)}${card?.kind === 'agent' && card.id === id ? ' open' : ''}`}
        aria-label={`${a.name}, ${word}`} title={`${a.name} · ${word}`} onClick={(e) => tapAgent(id, e.currentTarget)}>
        <InkAvatar id={a.id} preset={a.preset} orch={a.orch} status={a.status} />
        {why === 'waiting' && <span className="zv-gf-dot" aria-hidden="true" />}
      </button>
    ]
  })
  const itemFaces = itemStack.order.flatMap((id) => {
    const view = viewOf(id)
    if (!view) return []
    const by = view.owners.map((o) => agents.get(o)?.name).filter((n): n is string => !!n)
    const label = `${view.kind === 'browser' ? 'Browser' : 'Note'}: ${view.title}${by.length ? `, made by ${by.join(', ')}` : ''}, new`
    const out = itemStack.leaving.has(id)
    return [
      <button key={id} ref={faceRef(`item:${id}`)} type="button" tabIndex={out ? -1 : undefined} aria-hidden={out || undefined}
        className={`zv-gf item ${view.kind}${motionOf(itemStack, id)}${card?.kind === 'item' && card.id === id ? ' open' : ''}`}
        aria-label={label} title={label} onClick={(e) => tapItem(id, e.currentTarget)}>
        <span className={`zv-th ${view.kind}`} aria-hidden="true">
          <Page item={view} words={false} />
        </span>
      </button>
    ]
  })

  const group = (s: (typeof BAR_SIDES)[number]): React.JSX.Element => {
    const isAgents = s.dir === 'agents'
    const stack = isAgents ? agentFaces : itemFaces
    const count = isAgents ? agentEntries.length : itemEntries.length
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

  const cardAgent = card?.kind === 'agent' ? agents.get(card.id) ?? null : null
  const cardNode = card?.kind === 'item' ? nodeOf.get(card.id) ?? null : null
  const cardItem = cardNode ? itemFaceOf(cardNode, owners.get(cardNode.id) ?? []) : null
  return (
    <>
      <div className="zv-groups" role="group" aria-label="Artifacts or agents">
        {BAR_SIDES.map(group)}
      </div>
      {cardAgent && (
        <BarAgentCard
          key={`agent:${cardAgent.id}`}
          agent={cardAgent}
          items={(attachIndex.get(cardAgent.id) ?? []).flatMap((at) => itemViewOf(at.node, [cardAgent.id]) ?? [])}
          anchor={faces.current.get(`agent:${cardAgent.id}`) ?? null}
          onOpen={() => {
            barCard.close()
            onAgentFull(cardAgent.id)
          }}
          onItem={(itemId) => {
            barCard.close()
            onItemFull(itemId)
          }}
          onDelete={onDelete ? () => {
            barCard.close()
            onDelete(cardAgent.id)
          } : undefined}
          onOutside={onOutside}
          onClose={barCard.close}
        />
      )}
      {cardItem && (
        <BarItemCard
          key={`item:${cardItem.id}`}
          item={cardItem}
          crew={crewFaces}
          since={sinceWord(since.current, Date.now())}
          anchor={faces.current.get(`item:${cardItem.id}`) ?? null}
          onOpen={() => {
            barCard.close()
            onItemFull(cardItem.id)
          }}
          onAgent={(agentId) => {
            barCard.close()
            onAgentFull(agentId)
          }}
          onOutside={onOutside}
          onClose={barCard.close}
        />
      )}
    </>
  )
}
