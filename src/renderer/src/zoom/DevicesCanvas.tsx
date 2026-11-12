import { useLayoutEffect, useRef, useState } from 'react'
import { CrIcon } from '../icons'
import { MachineFrame } from './MachineFrame'
import { deviceWords } from './zoom-camera'
import { DEFAULT_SCREEN_ASPECT, deviceOf, fitScale, machineFrameOf, machinesAt, screenAspectOf, type Pos } from './zoom-layout'
import type { MachineView } from './zoom-model'
import './zoom.css'
import './devices-canvas.css'
import './bar-groups.css'

/**
 * THE ACCOUNT'S DEVICES, WITH NO MACHINE ENTERED (owner 2026-11-12: at devices
 * no machine has been entered yet). The console's Devices level: every machine of
 * the account a peer, each the same frame the desktop's devices stop draws
 * (MachineFrame), in the same row (zoom-layout.ts · machinesAt), none of them
 * the one the view is "on". Drawing it from inside one machine made the
 * frames' size and the title follow whichever machine had been entered.
 *
 * The bar at the foot is the zoom's bar at its DEVICES stop: WORKSPACES,
 * ARTIFACTS and AGENTS go into a machine (the first that can be read), and a
 * machine or one of its tiles goes into that one.
 */

export interface CanvasMachine {
  readonly view: MachineView
  /** Why it cannot be gone into, as the one thing to do; null when it can. */
  readonly say: string | null
  readonly caption: string
  /** Where it stands for this page (the console's live, locked, offline…), on its frame as `data-standing`. */
  readonly standing: string
  /** Can it be gone into from here at all: a locked one can (it asks for proof), an offline one cannot. */
  readonly openable: boolean
  /** Beside its name: how this page reaches it. */
  readonly badge?: React.ReactNode
}

export type EnterSide = 'agents' | 'items'

export interface CanvasPlace {
  readonly frame: { w: number; h: number }
  /** Each machine's frame centre, in order: the first at the origin. */
  readonly at: Pos[]
  /** The camera: scale and where the origin lands on screen. */
  readonly s: number
  readonly x: number
  readonly y: number
}

/** Room the bar at the foot takes, in px: the row is framed above it. */
export const BAR_ROOM = 96

/** Where every machine stands and how the whole row is framed in a view `w` × `h`. */
export function canvasOf(count: number, narrow: boolean, w: number, h: number): CanvasPlace {
  const frame = machineFrameOf({ screen: { w: DEFAULT_SCREEN_ASPECT, h: 1, cy: 0 } }, narrow)
  const row = machinesAt(Math.max(0, count - 1), frame, narrow)
  const room = { w, h: Math.max(1, h - BAR_ROOM) }
  const s = fitScale(row.box, room.w, room.h)
  return { frame, at: [{ x: 0, y: 0 }, ...row.at].slice(0, Math.max(1, count)), s, x: room.w / 2 - s * row.box.cx, y: room.h / 2 - s * row.box.cy }
}

function useSize(): [React.RefObject<HTMLDivElement>, { w: number; h: number }] {
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 1000, h: 700 })
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return undefined
    const read = (): void => setSize((old) => (old.w === el.clientWidth && old.h === el.clientHeight ? old : { w: el.clientWidth, h: el.clientHeight }))
    read()
    const seen = new ResizeObserver(read)
    seen.observe(el)
    return () => seen.disconnect()
  }, [])
  return [box, size]
}

const NO_BIND = (): ((el: HTMLElement | null) => void) => () => undefined

const NO_GAUGE = (): React.ReactNode => null

export function DevicesCanvas({ machines, onEnter, gaugeOf = NO_GAUGE, openingId = null }: {
  machines: readonly CanvasMachine[]
  /** The machine being gone into: it stays lit, the others step back, and nothing more can be pressed. */
  openingId?: string | null
  /** Into a machine: at its workspaces, or a workspace's agents or artifacts. */
  onEnter: (machineId: string, workspaceId: string | null, side: EnterSide) => void
  /**
   * A readable machine's gauge line, from the caller: the zoom's gauges read
   * through the app's calls (gauge-store.ts), which the console's first load
   * must not carry (tests/console-first-load.test.ts).
   */
  gaugeOf?: (machine: MachineView) => React.ReactNode
}): React.JSX.Element {
  const [box, size] = useSize()
  const narrow = size.w < 760
  const place = canvasOf(machines.length, narrow, size.w, size.h)
  const front = machines.find((m) => m.say === null) ?? null
  const frontWorkspace = front?.view.marks[0]?.id ?? null
  const go = (side: EnterSide | 'workspaces'): void => {
    if (!front || openingId !== null) return
    if (side === 'workspaces') onEnter(front.view.id, null, 'agents')
    else onEnter(front.view.id, frontWorkspace, side)
  }
  const style = { '--zv-k-devices': place.s.toFixed(4) } as React.CSSProperties
  return (
    <div className="zv-root dc-canvas" ref={box} style={style} data-testid="devices-canvas" data-opening={openingId !== null || undefined}>
      <div className="zv-overview dc-overview">
        <div className="dc-world" style={{ transform: `translate(${place.x.toFixed(1)}px, ${place.y.toFixed(1)}px) scale(${place.s.toFixed(4)})` }}>
          {machines.map((m, i) => {
            const at = place.at[i] ?? { x: 0, y: 0 }
            const words = deviceWords(deviceOf(m.view.marks.map((one) => one.id), narrow, screenAspectOf(m.view.display ?? null)), size.w, size.h, narrow)
            return (
              <div key={m.view.id} className="dc-machine" data-standing={m.standing} data-opening={m.view.id === openingId || undefined} style={{ transform: `translate(${at.x - place.frame.w / 2}px, ${at.y - place.frame.h / 2}px)` }}>
                <MachineFrame
                  machine={m.view}
                  frame={place.frame}
                  narrow={narrow}
                  wordK={words.markK}
                  titleK={words.titleK}
                  say={m.say}
                  caption={m.caption}
                  gauge={m.say === null ? gaugeOf(m.view) : null}
                  openable={m.openable && openingId === null}
                  badge={m.badge}
                  bind={NO_BIND}
                  onOpen={() => onEnter(m.view.id, null, 'agents')}
                  onOpenWorkspace={(id) => {
                    if (openingId === null) onEnter(m.view.id, id, 'agents')
                  }}
                />
              </div>
            )
          })}
        </div>
      </div>
      <nav className="zv-controls" aria-label="Semantic zoom">
        <button type="button" className="zv-back" disabled aria-label="Zoom out">‹</button>
        <div className="zv-zoom-control">
          <div className="zv-stops">
            <button type="button" aria-current="step" aria-label="devices">
              <CrIcon name="device" className="zv-stop-ic" />
              <span className="zv-stop-word">devices</span>
            </button>
            <button type="button" aria-label="workspaces" disabled={!front || openingId !== null} onClick={() => go('workspaces')}>
              <CrIcon name="canvas" className="zv-stop-ic" />
              <span className="zv-stop-word">workspaces</span>
            </button>
            <div className="zv-groups" role="group" aria-label="Artifacts or agents">
              {(['items', 'agents'] as const).map((one) => (
                <div key={one} className={`zv-group ${one} empty`}>
                  <button type="button" className="zv-group-stop" aria-label={one === 'items' ? 'artifacts' : 'agents'} disabled={!front || frontWorkspace === null || openingId !== null} onClick={() => go(one)}>
                    <span className="zv-group-word">{one === 'items' ? 'artifacts' : 'agents'}</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </nav>
    </div>
  )
}
