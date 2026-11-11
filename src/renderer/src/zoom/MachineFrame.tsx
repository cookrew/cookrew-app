import { memo } from 'react'
import { WorkspaceTile } from './WorkspaceTile'
import { BEZEL, deviceOf, SCREEN_SCALE, screenAspectOf, SWS } from './zoom-layout'
import type { Bind } from './ZoomParts'
import type { MachineView } from './zoom-model'

/**
 * ANOTHER MACHINE, DRAWN AS THIS ONE IS (owner 2026-11-11, screenshot 5: "所有
 * device统一用图5形式"). The same frame as this machine's (zoom.css ·
 * .zv-machine), the same base, and on its screen its own workspace tiles laid
 * out by the same geometry (zoom-layout.ts · deviceOf) at the same scale this
 * machine's are drawn at on the devices stop, so the two cannot look unalike.
 *
 * Its tiles are a picture of that machine, not this one's painter's: they sit
 * still inside the frame and ride the devices camera with it. A tap on the frame
 * goes into that machine; a tap on one of its tiles goes into that workspace.
 * One that cannot be read has a blank screen and says the one thing to do
 * (`say`, machine-why.ts) on it.
 */


/** Its tiles' refs go nowhere: the painter draws this machine's tiles, not these. */
const NO_BIND: Bind = () => () => undefined

export interface MachineFrameProps {
  machine: MachineView
  /** This machine's frame in the devices layer's units: every machine is drawn the same size. */
  frame: { w: number; h: number }
  narrow: boolean
  /** The words on a tile, held as this machine's are (zoom-frame.ts · deviceWords · markK). */
  wordK: number
  /** The machine's name over its tiles, held as this machine's is (deviceWords · titleK). */
  titleK: number
  /** What stands in the way of reading it, as the one thing to do; null when its screen lights. */
  say: string | null
  /** Under its name: how many workspaces and agents, or why not. */
  caption: string
  /** Its gauges, one line under its name (MachineGauges.tsx · MachineGaugeLine). */
  gauge: React.ReactNode
  bind: Bind
  onOpen: () => void
  onOpenWorkspace: (workspaceId: string) => void
}

/** How its own device view fits this machine's screen: never larger than this one's tiles are drawn. */
export function screenFit(device: ReturnType<typeof deviceOf>, frame: { w: number; h: number }): number {
  return Math.min(SCREEN_SCALE, (frame.w - BEZEL) / device.screen.w, (frame.h - BEZEL) / device.screen.h)
}

export const MachineFrame = memo(function MachineFrame({ machine, frame, narrow, wordK, titleK, say, caption, gauge, bind, onOpen, onOpenWorkspace }: MachineFrameProps): React.JSX.Element {
  const lit = say === null
  const device = deviceOf(machine.marks.map((m) => m.id), narrow, screenAspectOf(machine.display ?? null))
  const k = screenFit(device, frame)
  const screen: React.CSSProperties = {
    transform: `translate(${frame.w / 2}px, ${frame.h / 2}px) scale(${k}) translate(0px, ${-device.box.cy}px)`,
    ['--zv-k' as string]: wordK.toFixed(3),
    ['--zv-title-k' as string]: titleK.toFixed(3),
    ['--zv-tile-top' as string]: `${Math.round(device.tile.top)}px`,
    ['--zv-tile-h' as string]: `${Math.round(device.tile.h)}px`
  }
  return (
    <div ref={bind(`machinecard:${machine.id}`)} className={`zv-machine zv-other${machine.online ? '' : ' off'}`} data-read={lit} style={{ width: frame.w, height: frame.h }}>
      <button type="button" className="zv-machine-open" aria-label={lit ? `Open ${machine.name}` : `${machine.name}: ${say}`} title={lit ? undefined : (say ?? undefined)} onClick={onOpen} />
      {lit ? (
        <div className="zv-om-screen" style={screen}>
          <div className="zv-om-title" style={{ transform: `translate(${device.left}px, ${device.titleBottom}px) translateY(-100%)` }}>
            <b>{machine.name}</b>
            <span>{machine.marks.length} {machine.marks.length === 1 ? 'workspace' : 'workspaces'}</span>
          </div>
          {machine.marks.map((mark) => {
            const at = device.at[mark.id]
            return at ? (
              <div key={mark.id} className="zv-om-tile" style={{ transform: `translate(${at.x}px, ${at.y}px) scale(${SWS})` }}>
                <WorkspaceTile mark={mark} bind={NO_BIND} onOpen={() => onOpenWorkspace(mark.id)} />
              </div>
            ) : null
          })}
          {machine.marks.length === 0 && <p className="zv-om-say">no workspaces</p>}
        </div>
      ) : (
        <p className="zv-om-say zv-om-blank">{say}</p>
      )}
      <span className="zv-machine-deck" />
      <span className="zv-machine-label">
        <b>{machine.name}</b>
        <small>{caption}</small>
        {gauge}
      </span>
    </div>
  )
})
