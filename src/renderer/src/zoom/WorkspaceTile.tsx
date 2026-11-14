import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react'
import { InkAvatar } from './InkAvatar'
import { Counts, Page, type Bind } from './page-parts'
import { sameProps } from './same-props'
import type { ItemView, MarkView } from './zoom-model'
import './workspace-tile.css'

const WorkspaceTileCard = lazy(() => import('./WorkspaceTileCard'))

/**
 * A WORKSPACE'S TILE (owner, 2026-11-04: "how the agents group and the
 * artifacts group show on one page"). One bench, one name, two groups, each
 * its own door: the agents' faces open the crew, the artifacts' deck deals out
 * the grid. The doors say what they open, so the stop needs no hint line, and
 * every word lives inside the frame, so no label can run over its neighbour's.
 *
 * Every workspace draws this, the open one too: there the faces
 * are the scene's own, standing in the tile, so the tile goes and they go on
 * opening (zoom-frame.ts). The painter draws `.zv-tw` words at one size on
 * screen (paintDeviceWords); the rest rides the camera.
 */

/** The sheets a deck stands on: its depth says how much a workspace holds, never more than the eye can count. */
const DECK_DEPTHS = [1, 2, 6, 30] as const
export const deckDepth = (total: number): number => DECK_DEPTHS.filter((n) => total >= n).length

const sheetPose = (offset: number, depth: number): React.CSSProperties => {
  const behind = Math.min(Math.max(0, offset), depth - 1)
  const leaving = Math.min(1, Math.max(0, -offset))
  const entering = Math.min(1, Math.max(0, offset - depth + 1))
  return {
    transform: `translate(calc(${-128 * leaving}% + ${(behind + entering) * 7}px), ${(behind + entering) * -5 + leaving * 4}px) rotate(${offset < 0 ? -1.5 - leaving * 9 : -1.5 + (behind + entering) * 3.7}deg)`,
    opacity: offset < 0 ? Math.min(1, (1 - leaving) / 0.45) : 1 - entering,
    zIndex: Math.round(100 - offset * 10)
  }
}

const WorkspaceArtifact = memo(function WorkspaceArtifact({ items, total, position }: { items: readonly ItemView[]; total: number; position: number }): React.JSX.Element {
  const depth = Math.max(1, deckDepth(total))
  const base = Math.floor(position)
  const sheets = items.slice(Math.max(0, base - 1), base + depth + 1)
  return (
    <div className="zv-workspace-artifact" aria-label={`${total} artifacts`}>
      <div className="zv-workspace-folder">
        <div className="zv-artifact-fan">
          {sheets.map((item, i) => (
            <div key={item.id} className={`zv-artifact-sheet${Math.abs(i + Math.max(0, base - 1) - position) < 0.5 ? ' front' : ''}`} style={sheetPose(i + Math.max(0, base - 1) - position, depth)}>
              <div className="zv-artifact-page">
                <Page item={item} words />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}, sameProps)

/** What a deck draws: two rebuilds of the same things are the same deck (the model makes new objects each time, same-props.ts compares them by identity). */
const sameDeck = (a: readonly ItemView[], b: readonly ItemView[]): boolean =>
  a.length === b.length &&
  a.every((x, i) =>
    x.id === b[i].id &&
    x.kind === b[i].kind &&
    x.title === b[i].title &&
    x.host === b[i].host &&
    x.owners.length === b[i].owners.length &&
    x.owners.every((owner, j) => owner === b[i].owners[j])
  )
type TileProps = { mark: MarkView; open?: boolean; bind: Bind; onOpen: () => void; onOpenItems?: () => void }
export const sameTile = (a: TileProps, b: TileProps): boolean =>
  sameDeck(a.mark.deck, b.mark.deck) && JSON.stringify(a.mark.agents) === JSON.stringify(b.mark.agents) && sameProps({ ...a, mark: { ...a.mark, deck: [], agents: undefined } }, { ...b, mark: { ...b.mark, deck: [], agents: undefined } })

/** The digits a snug tile's split has room for: past them it says the total. */
const SPLIT_DIGITS = 5

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export const WorkspaceTile = memo(function WorkspaceTile({ mark, open = false, bind, onOpen, onOpenItems }: TileProps): React.JSX.Element {
  const [index, setIndex] = useState(0)
  const [offset, setOffset] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [rowDragging, setRowDragging] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [rowIndex, setRowIndex] = useState(0)
  const [rowOffset, setRowOffset] = useState(0)
  const rowGesture = useRef<{ x: number; y: number; width: number; active: boolean } | null>(null)
  const suppressClick = useRef(false)
  const gesture = useRef<{ x: number; y: number; width: number; active: boolean; held: boolean; pointer: string } | null>(null)
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rest = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wheel = useRef({ amount: 0, timer: null as ReturnType<typeof setTimeout> | null })
  const openedBy = useRef<'mouse' | 'touch'>('mouse')
  const cancel = (timer: typeof dwell): void => { if (timer.current) clearTimeout(timer.current); timer.current = null }
  const closeLater = (): void => { cancel(rest); rest.current = setTimeout(() => setExpanded(false), 2500) }
  useEffect(() => () => { cancel(dwell); cancel(rest); if (wheel.current.timer) clearTimeout(wheel.current.timer) }, [])
  useEffect(() => { setIndex(0); setOffset(0); setExpanded(false); setSelected(null); setRowIndex(0); cancel(dwell); cancel(rest) }, [mark.id])
  const current = Math.min(index, Math.max(0, mark.deck.length - 1))
  const n = mark.presets.length
  const known = mark.browsers !== null && mark.notes !== null
  const browsers = mark.browsers ?? 0
  const notes = mark.notes ?? 0
  const total = browsers + notes
  const agents = mark.agents ?? []
  const agent = agents.find((entry) => entry.id === selected)
  const front = mark.deck[current]
  const agentBrowser = agent ? (front?.kind === 'browser' && front.owners.includes(agent.id) ? front : mark.deck.find((item) => item.kind === 'browser' && item.owners.includes(agent.id))) : undefined
  const associated = front ? agents.filter((entry) => front.owners.includes(entry.id)) : []
  const pick = (id: string): void => { cancel(dwell); cancel(rest); setExpanded(false); setSelected(id); setRowIndex(Math.max(0, agents.findIndex((entry) => entry.id === id))) }
  // Nothing behind it, no door: a tap would only land on an empty grid.
  const itemsDoor = known && total > 0 && onOpenItems
  return (
    <div ref={bind(open ? 'openMark' : `mark:${mark.id}`)} className="zv-mark" data-open={open || undefined} data-waiting={mark.waitingCount > 0 || undefined}>
      <div className="zv-tile" />
      <div className={`zv-workspace-agents${rowDragging ? ' dragging' : ''}${agent ? ' selected' : ''}`} aria-label={`${n} agents`}
        onPointerDown={(event) => { if (event.button === 0) rowGesture.current = { x: event.clientX, y: event.clientY, width: event.currentTarget.getBoundingClientRect().width, active: false } }}
        onPointerMove={(event) => { const start = rowGesture.current; if (!start) return; const dx = event.clientX - start.x; if (!start.active && Math.abs(event.clientY - start.y) > Math.abs(dx) && Math.abs(event.clientY - start.y) > 8) { rowGesture.current = null; return } if (!start.active && Math.abs(dx) > 6) { start.active = true; suppressClick.current = true; setRowDragging(true); event.currentTarget.setPointerCapture(event.pointerId) } if (start.active) setRowOffset(-dx / Math.max(1, start.width / 6)) }}
        onPointerUp={(event) => { const start = rowGesture.current; if (start?.active) { const next = Math.max(0, Math.min(n - 1, Math.round(rowIndex - (event.clientX - start.x) / Math.max(1, start.width / 6)))); setRowIndex(next); if (agents[next]) setSelected(agents[next].id) } rowGesture.current = null; setRowDragging(false); setRowOffset(0) }}
        onPointerCancel={() => { rowGesture.current = null; setRowDragging(false); setRowOffset(0) }}
        onClickCapture={(event) => { if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation() } }}>
        {mark.presets.map((preset, i) => (
          <button type="button" key={agents[i]?.id ?? i} className="zv-av zv-workspace-agent" style={{ transform: `translateX(${(i - rowIndex - rowOffset) * 61 + (agent ? Math.max(0, Math.min(1, i - rowIndex - rowOffset)) * 165 : 0)}px) scale(.81)` }} aria-label={agents[i]?.name ?? `Agent ${i + 1}`} onClick={() => agents[i] ? pick(agents[i].id) : onOpen()}>
            <InkAvatar id={agents[i]?.id ?? `${mark.id}:${i}`} preset={preset} status={agents[i]?.status} />
          </button>
        ))}
        {agent && <div className="zv-tile-agent-name">{agent.name}<small>{agent.word}</small></div>}
      </div>
      {(known || mark.deck.length > 0) && !agent && <div className={`zv-fan-window${expanded ? ' expanded' : ''}${dragging ? ' dragging' : ''}`} data-front={current} data-expanded={expanded || undefined}
        onPointerEnter={(event) => { if (event.pointerType !== 'mouse') return; cancel(rest); cancel(dwell); openedBy.current = 'mouse'; if (!expanded && mark.deck.length > 0) dwell.current = setTimeout(() => setExpanded(true), 800) }}
        onPointerLeave={(event) => { if (event.pointerType !== 'mouse') return; cancel(dwell); if (expanded) closeLater() }}
        onPointerDown={(event) => { if (event.button !== 0) return; cancel(rest); gesture.current = { x: event.clientX, y: event.clientY, width: event.currentTarget.getBoundingClientRect().width, active: false, held: false, pointer: event.pointerType }; if (event.pointerType !== 'mouse' && mark.deck.length) { cancel(dwell); dwell.current = setTimeout(() => { if (gesture.current) gesture.current.held = true; openedBy.current = 'touch'; setExpanded(true) }, 350) } }}
        onPointerMove={(event) => { const start = gesture.current; if (!start) return; const dx = event.clientX - start.x; const dy = event.clientY - start.y; if (!start.active && Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { cancel(dwell); gesture.current = null; return } if (!start.active && Math.abs(dx) > 6) { start.active = true; cancel(dwell); setDragging(true); event.currentTarget.setPointerCapture(event.pointerId) } if (start.active) setOffset(-dx / Math.max(1, start.width)) }}
        onPointerUp={(event) => { const start = gesture.current; cancel(dwell); if (!start) return; if (start.active) { setIndex(Math.max(0, Math.min(mark.deck.length - 1, Math.round(current - (event.clientX - start.x) / Math.max(1, start.width))))); if (expanded && start.pointer !== 'mouse') closeLater() } setOffset(0); setDragging(false); gesture.current = null; if (start.pointer !== 'mouse' && (expanded || start.held)) closeLater() }}
        onPointerCancel={() => { cancel(dwell); gesture.current = null; setOffset(0); setDragging(false); if (expanded) closeLater() }}
        onWheel={(event) => { if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return; cancel(dwell); wheel.current.amount += event.deltaX; if (Math.abs(wheel.current.amount) > 40) { const direction = Math.sign(wheel.current.amount); wheel.current.amount = 0; setIndex((value) => Math.max(0, Math.min(mark.deck.length - 1, value + direction))) } if (wheel.current.timer) clearTimeout(wheel.current.timer); wheel.current.timer = setTimeout(() => { wheel.current.amount = 0 }, 160); if (expanded && openedBy.current === 'touch') closeLater() }}
      ><WorkspaceArtifact items={mark.deck} total={known ? total : mark.deck.length} position={Math.max(0, Math.min(mark.deck.length - 1, current + offset))} />{expanded && <div className="zv-fan-tied">{associated.map((entry) => <button key={entry.id} type="button" aria-label={entry.name} onPointerDown={(event) => event.stopPropagation()} onClick={() => pick(entry.id)}><InkAvatar id={entry.id} preset={entry.preset} status={entry.status} size={26} weight="mini" /></button>)}</div>}</div>}
      {agent && <div className="zv-tile-card-window"><Suspense fallback={null}><WorkspaceTileCard agent={agent} item={agentBrowser ?? null} /></Suspense><button type="button" className="zv-tile-card-back" onClick={() => setSelected(null)} aria-label="Back to artifacts">×</button></div>}
      <button type="button" className={`zv-door agents${itemsDoor ? '' : ' whole'}`} aria-current={open ? 'true' : undefined} aria-label={`Open ${mark.name} agents, ${plural(n, 'agent')}${mark.waitingCount > 0 ? `, ${mark.waitingCount} waiting` : ''}`} title={`${mark.name} · ${plural(n, 'agent')}`} onClick={onOpen} />
      {itemsDoor && <button type="button" className="zv-door items" aria-label={`Open ${mark.name} artifacts, ${plural(browsers, 'browser')}, ${plural(notes, 'note')}`} title={`${mark.name} · ${plural(browsers, 'browser')}, ${plural(notes, 'note')}`} onClick={onOpenItems} />}
      <div className="zv-tw zv-tile-name">{mark.name}</div>
      {mark.waitingCount > 0 && <div className="zv-tw zv-tile-wait" title={`${mark.waitingCount} waiting`}>{mark.waitingCount}</div>}
      <div className="zv-tw zv-tile-cap agents">
        {n > 0 ? <><span className="zv-seal">{n}</span><small>{n === 1 ? 'agent' : 'agents'}</small></> : <><em>no agents</em><span className="zv-zero">0</span></>}
      </div>
      {front && !agent && <div className="zv-tw zv-tile-art-title">{front.title}</div>}
      {known && (
        <div className="zv-tw zv-tile-cap items" data-long={`${browsers}${notes}`.length > SPLIT_DIGITS || undefined}>
          {total > 0 ? <><span className="zv-total">{total}</span><span className="zv-split"><Counts browsers={browsers} notes={notes} /></span></> : <><em>no artifacts</em><span className="zv-zero">0</span></>}
        </div>
      )}
    </div>
  )
}, sameTile)
