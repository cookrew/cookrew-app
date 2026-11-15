import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { InkAvatar } from './InkAvatar'
import { Counts } from './page-parts'
import type { AgentView, ItemView, MarkView } from './zoom-model'
import { sameProps } from './same-props'
import './workspace-tile.css'

const WorkspaceTileCard = lazy(() => import('./WorkspaceTileCard').then((module) => ({ default: module.WorkspaceTileCard })))

type Bind = (key: string) => (el: HTMLElement | null) => void
type TileProps = { mark: MarkView; open?: boolean; bind: Bind; onOpen: () => void; onOpenItems?: () => void }
type Mode = 'bag' | 'agent'
const HOLD_MS = 350
const DWELL_MS = 800
const LINGER_MS = 2500
const DECK_DEPTHS = [1, 2, 6, 30] as const
export const deckDepth = (total: number): number => DECK_DEPTHS.filter((n) => total >= n).length
const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value))
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

function useSwipe(count: number, step: number, onDrag?: () => void) {
  const [index, setIndex] = useState(0)
  const [dx, setDx] = useState(0)
  const [dragging, setDragging] = useState(false)
  const gesture = useRef<{ x: number; y: number; t: number; id: number; active: boolean } | null>(null)
  const moved = useRef(false)
  const wheel = useRef({ amount: 0, timer: 0 })
  const go = useCallback((value: number) => setIndex(clamp(Math.round(value), 0, Math.max(0, count - 1))), [count])
  const handlers = {
    onPointerDown: (event: React.PointerEvent) => {
      if (event.button !== 0) return
      gesture.current = { x: event.clientX, y: event.clientY, t: performance.now(), id: event.pointerId, active: false }
      moved.current = false
    },
    onPointerMove: (event: React.PointerEvent) => {
      const start = gesture.current
      if (!start || start.id !== event.pointerId) return
      const dxNow = event.clientX - start.x
      const dyNow = event.clientY - start.y
      if (!start.active) {
        if (Math.abs(dxNow) < 6) return
        if (Math.abs(dyNow) > Math.abs(dxNow)) return void (gesture.current = null)
        start.active = true
        moved.current = true
        setDragging(true)
        onDrag?.()
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      const position = index - dxNow / step
      setDx(position < 0 || position > count - 1 ? dxNow * 0.35 : dxNow)
    },
    onPointerUp: (event: React.PointerEvent) => {
      const start = gesture.current
      gesture.current = null
      if (!start?.active) return
      const dxNow = event.clientX - start.x
      const velocity = dxNow / Math.max(1, performance.now() - start.t)
      const flick = Math.abs(velocity) > 0.45 ? -Math.sign(velocity) : 0
      go(index - dxNow / step + flick * 0.5)
      setDx(0)
      setDragging(false)
    },
    onPointerCancel: () => {
      gesture.current = null
      setDx(0)
      setDragging(false)
    },
    onWheel: (event: React.WheelEvent) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return
      wheel.current.amount += event.deltaX
      if (Math.abs(wheel.current.amount) > 40) {
        onDrag?.()
        go(index + Math.sign(wheel.current.amount))
        wheel.current.amount = 0
      }
      window.clearTimeout(wheel.current.timer)
      wheel.current.timer = window.setTimeout(() => (wheel.current.amount = 0), 160)
    },
    onClickCapture: (event: React.MouseEvent) => {
      if (!moved.current) return
      moved.current = false
      event.stopPropagation()
      event.preventDefault()
    }
  }
  return { index, pos: index - dx / step, dragging, go, handlers }
}

function usePress(onHold: () => void) {
  const press = useRef<{ x: number; y: number; timer: number } | null>(null)
  const end = (): void => {
    if (press.current) window.clearTimeout(press.current.timer)
    press.current = null
  }
  return {
    onPointerDown: (event: React.PointerEvent) => {
      if (event.button !== 0) return
      end()
      if ((event.target as Element).closest('input, textarea, button, form, a')) return
      press.current = { x: event.clientX, y: event.clientY, timer: window.setTimeout(() => { end(); onHold() }, HOLD_MS) }
    },
    onPointerMove: (event: React.PointerEvent) => {
      const start = press.current
      if (!start) return
      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) end()
      else if (Math.abs(dx) > 6) end()
    },
    onPointerUp: end,
    onPointerCancel: end
  }
}

function lookOf(item: ItemView): 'doc' | 'dash' | 'code' {
  const sum = [...item.id].reduce((total, char) => total + char.charCodeAt(0), 0)
  return sum % 3 === 0 ? 'dash' : sum % 3 === 1 ? 'code' : 'doc'
}

function Thumb({ item, small = false }: { item: ItemView; small?: boolean }): React.JSX.Element {
  if (item.kind === 'note') return <div className={`dm-page note${small ? ' small' : ''}`}><b>{item.title}</b><i /><i /><i style={{ width: '62%' }} /></div>
  const look = lookOf(item)
  return (
    <div className={`dm-page browser ${look}${small ? ' small' : ''}`}>
      <div className="dm-bar"><i style={{ background: item.tint }} /><span>{item.host}</span></div>
      {look === 'dash' && <div className="dm-dash"><b style={{ background: item.tint }} /><em /><em /><em /><i /><i /></div>}
      {look === 'code' && <div className="dm-code"><b style={{ background: item.tint }} />{[90, 70, 84, 40, 76, 62].map((width, index) => <i key={index} style={{ width: `${width}%`, marginLeft: index % 3 ? 12 : 0 }} />)}</div>}
      {look === 'doc' && <div className="dm-doc"><b style={{ background: item.tint }} /><i /><i /><i style={{ width: '70%' }} /><i /><i style={{ width: '55%' }} /></div>}
    </div>
  )
}

function sheetPose(offset: number, depth: number): React.CSSProperties {
  let percent = 0
  let x = 0
  let y = 0
  let rotation = 0
  let opacity = 1
  if (offset < 0) {
    const leaving = Math.min(1.2, -offset)
    percent = -leaving * 128
    y = leaving * 4
    rotation = -1.5 - leaving * 9
    opacity = leaving < 0.55 ? 1 : Math.max(0, 1 - (leaving - 0.55) / 0.45)
  } else {
    const back = Math.max(0, depth - 1)
    const behind = Math.min(offset, back)
    x = behind * 7
    y = behind * -5
    rotation = behind < 1 ? -1.5 + behind * 3.7 : behind * 2.2
    if (offset > back) {
      const entering = Math.min(1, offset - back)
      x += entering * 7
      y -= entering * 5
      rotation += entering * 2.2
      opacity = 1 - entering
    }
  }
  return { transform: `translate(calc(${percent.toFixed(2)}% + ${x.toFixed(2)}px), ${y.toFixed(2)}px) rotate(${rotation.toFixed(2)}deg)`, opacity, zIndex: Math.round(100 - offset * 10) }
}

function Fan({ items, total, position }: { items: readonly ItemView[]; total: number; position: number }): React.JSX.Element {
  if (total === 0 || items.length === 0) return <div className="dm-none">no artifacts</div>
  const depth = Math.max(1, deckDepth(total))
  const base = Math.floor(position)
  const first = Math.max(0, base - 1)
  return <div className="dm-bag">{items.slice(first, Math.min(items.length, base + depth + 1)).map((item, index) => {
    const offset = first + index - position
    return <div key={item.id} className={`dm-bag-sheet${Math.abs(offset) < 0.5 ? ' front' : ''}`} style={sheetPose(offset, depth)}><Thumb item={item} /></div>
  })}</div>
}

function EmbeddedCard({ agent, item }: { agent: AgentView; item: ItemView | null }): React.JSX.Element {
  return <Suspense fallback={null}><WorkspaceTileCard agent={agent} item={item} thumb={(artifact) => <Thumb item={artifact} small />} /></Suspense>
}

const sameDeck = (a: readonly ItemView[], b: readonly ItemView[]): boolean => a.length === b.length && a.every((item, index) => {
  const other = b[index]
  return item.id === other.id && item.kind === other.kind && item.title === other.title && item.host === other.host && item.owners.length === other.owners.length && item.owners.every((owner, ownerIndex) => owner === other.owners[ownerIndex])
})

export const sameTile = (a: TileProps, b: TileProps): boolean =>
  sameDeck(a.mark.deck, b.mark.deck) && JSON.stringify(a.mark.agents) === JSON.stringify(b.mark.agents) &&
  sameProps({ ...a, mark: { ...a.mark, deck: [], agents: undefined } }, { ...b, mark: { ...b.mark, deck: [], agents: undefined } })

export const WorkspaceTile = memo(function WorkspaceTile({ mark, open = false, bind, onOpen, onOpenItems }: TileProps): React.JSX.Element {
  const agents = mark.agents ?? []
  const [mode, setMode] = useState<Mode>('bag')
  const [openFan, setOpenFan] = useState(false)
  const dwell = useRef<number | null>(null)
  const linger = useRef<number | null>(null)
  const touching = useRef(false)
  const openedBy = useRef<'mouse' | 'touch'>('touch')
  const total = (mark.browsers ?? 0) + (mark.notes ?? 0)
  const items = mark.deck
  const artifacts = useSwipe(items.length, 220)
  const row = useSwipe(Math.max(agents.length, mark.presets.length), 38, () => setMode('agent'))
  const at = clamp(Math.round(row.pos), 0, Math.max(0, agents.length - 1))
  const selected = agents[at] ?? null
  const clearTimer = (timer: { current: number | null }): void => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null }
  const closeSoon = (): void => { clearTimer(linger); linger.current = window.setTimeout(() => { linger.current = null; setOpenFan(false) }, LINGER_MS) }
  const showFan = (by: 'mouse' | 'touch'): void => { if (items.length === 0) return; clearTimer(dwell); clearTimer(linger); openedBy.current = by; setOpenFan(true) }
  const selectAgent = (agent: AgentView): void => { clearTimer(dwell); clearTimer(linger); setOpenFan(false); row.go(Math.max(0, agents.findIndex((entry) => entry.id === agent.id))); setMode('agent') }
  const hold = usePress(() => showFan('touch'))
  const front = items[clamp(artifacts.index, 0, Math.max(0, items.length - 1))] ?? null
  const tied = front ? agents.filter((agent) => front.owners.includes(agent.id)) : []
  const itemForCard = selected ? items.find((item) => item.kind === 'browser' && item.owners.includes(selected.id)) ?? null : null
  const known = mark.browsers !== null && mark.notes !== null
  const itemsDoor = known && total > 0 && onOpenItems

  useEffect(() => { if (openFan && openedBy.current === 'touch' && !touching.current) closeSoon() }, [artifacts.index, openFan])
  useEffect(() => () => { clearTimer(dwell); clearTimer(linger) }, [])
  useEffect(() => { setMode('bag'); setOpenFan(false); row.go(0); clearTimer(dwell); clearTimer(linger) }, [mark.id])

  return (
    <div ref={bind(open ? 'openMark' : `mark:${mark.id}`)} className="zv-mark" data-open={open || undefined} data-waiting={mark.waitingCount > 0 || undefined}>
      <div className="zv-tile" />
      <section className={`dm-tile ${mode}${openFan ? ' peeking' : ''}`} data-mode={mode} data-front={artifacts.index} data-open={openFan || undefined}>
        <header><h3>{mark.name}</h3>{mark.waitingCount > 0 && <i className="dm-wait">{mark.waitingCount}</i>}</header>
        <div className={`dm-row${row.dragging ? ' dragging' : ''}`} {...row.handlers} onClick={() => setMode('agent')}>
          <div className="dm-crew">
            {selected && <div className="dm-card-head"><div className="zv-nm">{selected.name}</div><div className="ag-meta"><span className={`zv-st ${selected.status}`}>{selected.word}</span><span className="zv-cnt"><Counts browsers={selected.browsers} notes={selected.notes} /></span></div></div>}
            {mark.presets.map((preset, index) => {
              const distance = index - row.pos
              if (distance < -1.5 || distance > 14) return null
              const agent = agents[index]
              return <button key={agent?.id ?? `${mark.id}:${index}`} type="button" className="dm-head" style={{ transform: `translate(${(10 + distance * 38 + (mode === 'agent' ? Math.max(0, Math.min(1, distance)) * 170 : 0)).toFixed(1)}px, -50%)`, opacity: distance < 0 ? clamp(1 + distance * 1.4, 0, 1) : 1 }} aria-label={agent?.name ?? `Agent ${index + 1}`} onClick={(event) => { event.stopPropagation(); if (agent) selectAgent(agent); else onOpen() }}><InkAvatar id={agent?.id ?? `${mark.id}:${index}`} preset={preset} status={agent?.status} size={32} weight="small" /></button>
            })}
            <span className="dm-count agents" title={`${mark.presets.length} agents`}><i className="dm-seal">{mark.presets.length}</i></span>
          </div>
        </div>
        <div className="dm-folder"><div className="dm-folder-view" /><div className={`dm-ov-layer${mode === 'agent' ? ' on' : ''}`} onClick={() => setMode('bag')}>{mode === 'agent' && selected && <EmbeddedCard agent={selected} item={itemForCard} />}</div><div className="dm-pocket"><span className="dm-title">{front?.title ?? ''}</span><span className="dm-count items">{items.length > 0 && <em>{artifacts.index + 1}/{items.length}</em>}{(mark.browsers ?? 0) > 0 && <span>▭{mark.browsers}</span>}{(mark.notes ?? 0) > 0 && <span>▤{mark.notes}</span>}</span></div></div>
        <div className={`dm-fan${artifacts.dragging ? ' dragging' : ''}${openFan ? ' open' : ''}`}
          onPointerEnter={(event) => { if (event.pointerType !== 'mouse') return; clearTimer(linger); clearTimer(dwell); openedBy.current = 'mouse'; if (!openFan && items.length > 0) dwell.current = window.setTimeout(() => showFan('mouse'), DWELL_MS) }}
          onPointerLeave={(event) => { if (event.pointerType !== 'mouse') return; clearTimer(dwell); if (openFan && openedBy.current === 'mouse') closeSoon() }}
          onPointerDown={(event) => { if (event.pointerType !== 'mouse') { touching.current = true; clearTimer(linger) }; artifacts.handlers.onPointerDown(event); hold.onPointerDown(event) }}
          onPointerMove={(event) => { artifacts.handlers.onPointerMove(event); hold.onPointerMove(event) }}
          onPointerUp={(event) => { artifacts.handlers.onPointerUp(event); hold.onPointerUp(); if (event.pointerType !== 'mouse') { touching.current = false; if (openFan) closeSoon() } }}
          onPointerCancel={(event) => { artifacts.handlers.onPointerCancel(); hold.onPointerCancel(); if (event.pointerType !== 'mouse') { touching.current = false; if (openFan) closeSoon() } }}
          onWheel={artifacts.handlers.onWheel} onClickCapture={artifacts.handlers.onClickCapture}
        ><Fan items={items} total={known ? total : items.length} position={artifacts.pos} /><div className="dm-fan-tied">{tied.map((agent) => <button key={agent.id} type="button" tabIndex={openFan ? 0 : -1} aria-label={`${agent.name}, ${agent.word}`} onPointerDown={(event) => event.stopPropagation()} onClick={() => selectAgent(agent)}><InkAvatar id={agent.id} preset={agent.preset} status={agent.status} size={26} weight="mini" /></button>)}</div></div>
      </section>
      <button type="button" className={`zv-door agents${itemsDoor ? '' : ' whole'}`} aria-current={open ? 'true' : undefined} aria-label={`Open ${mark.name} agents, ${plural(mark.presets.length, 'agent')}`} title={`${mark.name} · ${plural(mark.presets.length, 'agent')}`} onClick={onOpen} />
      {itemsDoor && <button type="button" className="zv-door items" aria-label={`Open ${mark.name} artifacts, ${plural(mark.browsers ?? 0, 'browser')}, ${plural(mark.notes ?? 0, 'note')}`} title={`${mark.name} artifacts`} onClick={onOpenItems} />}
    </div>
  )
}, sameTile)
