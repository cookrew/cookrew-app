/**
 * THE MACHINES' GAUGES at the devices stop: one line per machine, this one first.
 *
 * IN SCREEN PIXELS, OUT OF THE SCENE. Inside the machine's label they were
 * measured at 5.4 px on a desk and 2.9 px on a phone: the devices layer is drawn
 * at 0.27 to 0.48, and another machine's card is 99 px wide on a phone. The
 * camera frames that stop symmetrically, so the space above the machine is
 * always empty, and that is where they stand.
 *
 * LEAVES ON PURPOSE. The panel alone hears the zoom cross the stop and a line
 * alone hears its own samples, so neither reaches the view (gauge-store.ts says
 * why), and the painter never knows they exist. Off the stop nothing is mounted,
 * which is also what stops the asking.
 */
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { gaugeCells, NO_GPU, NO_READING, type GaugeCell } from '../../../shared/machine-gauges'
import { scopeNeedsMachine } from '../machine-scope'
import { atDevicesStop, gaugeStore, type GaugeReading } from './gauge-store'
import { gaugedMachines } from './gauged-machines'
import { useZoomFleetView } from './use-zoom-fleet'
import { zoomStore } from './zoom-store'
import './gauges.css'

const WAITING_CELLS: readonly GaugeCell[] = (['CPU', 'MEM', 'DISK', 'GPU'] as const).map((label) => ({
  key: label === 'MEM' ? 'memory' : (label.toLowerCase() as GaugeCell['key']),
  label,
  value: '…',
  sub: null,
  share: null,
  tone: 'calm'
}))

/** No number in the cell: a failed read, or no GPU at all. Both are muted words, which may wrap. */
const numberless = (cell: GaugeCell): boolean => cell.value === NO_READING || cell.value === NO_GPU

const spoken = (cell: GaugeCell): string => `${cell.label} ${cell.value}${cell.sub ? `, ${cell.sub}` : ''}`

function Cell({ cell }: { cell: GaugeCell }): React.JSX.Element {
  return (
    <span className="zv-gauge" data-gauge={cell.key} data-tone={cell.tone} data-none={numberless(cell) ? '' : undefined} role="img" aria-label={spoken(cell)}>
      <span className="zv-gauge-label">{cell.label}</span>
      <span className="zv-gauge-value">{cell.value}</span>
      {cell.sub !== null && <span className="zv-gauge-sub">{cell.sub}</span>}
      {cell.share !== null && (
        <span className="zv-gauge-track"><span className="zv-gauge-fill" style={{ transform: `scaleX(${Number(cell.share.toFixed(3))})` }} /></span>
      )}
    </span>
  )
}

/** What a reading looks like, whoever holds it. */
export function GaugeRow({ reading }: { reading: GaugeReading }): React.JSX.Element {
  if (reading === null) return <span className="zv-gauges zv-gauges-none">{NO_READING}</span>
  const waiting = reading === undefined
  return (
    <span className="zv-gauges" data-waiting={waiting ? '' : undefined}>
      {(waiting ? WAITING_CELLS : gaugeCells(reading)).map((cell) => <Cell key={cell.key} cell={cell} />)}
    </span>
  )
}

const onTheStop = (): boolean => atDevicesStop(zoomStore.get())
const nothingYet = (): undefined => undefined

const MachineLine = memo(function MachineLine({ machineId, name, local = false, online = true }: { machineId: string; name: string; local?: boolean; online?: boolean }): React.JSX.Element {
  const subscribe = useCallback((listener: () => void) => gaugeStore().subscribe(machineId, listener), [machineId])
  const reading = useSyncExternalStore(subscribe, () => gaugeStore().get(machineId), nothingYet)
  useEffect(() => (online ? gaugeStore().watch(machineId, local) : undefined), [online, machineId, local])
  return (
    <>
      <b className="zv-gauge-name" title={name}>{name}</b>
      <GaugeRow reading={online ? reading : null} />
    </>
  )
})

interface ListedMachine {
  id: string
  name: string
  local: boolean
  online: boolean
  appVersion?: string | null
}

/**
 * Whether the list runs past its box. The panel lies over the scene and takes no
 * gesture from it (gauges.css), unless a scroll is the only way to its last line.
 */
function useScrolls(): { box: React.RefObject<HTMLElement>; list: React.RefObject<HTMLDivElement>; scrolls: boolean } {
  const box = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [scrolls, setScrolls] = useState(false)
  useEffect(() => {
    const outer = box.current
    const inner = list.current
    if (!outer || !inner) return undefined
    const seen = new ResizeObserver(() => setScrolls(outer.scrollHeight > outer.clientHeight))
    seen.observe(outer)
    seen.observe(inner)
    return () => seen.disconnect()
  }, [])
  return { box, list, scrolls }
}

export function GaugeList({ localName, machines }: { localName: string; machines: readonly ListedMachine[] }): React.JSX.Element {
  const { box, list, scrolls } = useScrolls()
  return (
    <section className="zv-gauge-panel" ref={box} data-scrolls={scrolls ? '' : undefined} aria-label="Machine gauges">
      <div className="zv-gauge-grid" ref={list}>
        <MachineLine machineId="local" name={localName} local />
        {gaugedMachines(machines, scopeNeedsMachine()).map((m) => <MachineLine key={m.id} machineId={m.id} name={m.name} online={m.online} />)}
      </div>
    </section>
  )
}

export const GaugePanel = memo(function GaugePanel({ localName }: { localName: string }): React.JSX.Element | null {
  const onStop = useSyncExternalStore(zoomStore.subscribe, onTheStop, onTheStop)
  const fleet = useZoomFleetView()
  return onStop ? <GaugeList localName={localName} machines={fleet.machines} /> : null
})
