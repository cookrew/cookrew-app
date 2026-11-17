import { memo } from 'react'
import { DevicesAgents } from './DevicesAgents'
import type { PickSpot } from './agent-keys'
import type { Bind } from './page-parts'
import type { MachineView } from './zoom-model'

/**
 * ANOTHER MACHINE, DRAWN AS THIS ONE IS (owner 2026-11-11, screenshot 5: every
 * device in this one form). The same frame as this machine's (zoom.css ·
 * .zv-machine), the same base, and on its screen its own workspaces: since
 * 2026-11-17 their agents only, at the workspace card's own face size
 * (DevicesAgents.tsx), as this machine's screen shows its own.
 *
 * A tap on the frame goes into that machine; on a workspace's name, into that
 * workspace; on a face, that agent's card pops (`onPick`), or, where no card
 * can pop, into its workspace. One that cannot be read has a blank screen and
 * says the one thing to do (`say`, machine-why.ts) on it.
 */

export interface MachineFrameProps {
  machine: MachineView
  /** This machine's frame in the devices layer's units: every machine is drawn the same size. */
  frame: { w: number; h: number }
  /** A workspace card's px in the frame's units: its faces as big on screen as on the workspaces stop (DevicesAgents.tsx). */
  agentK: number
  /** What stands in the way of reading it, as the one thing to do; null when its screen lights. */
  say: string | null
  /** Under its name: how many workspaces and agents, or why not. */
  caption: string
  /** Its gauges, one line under its name (MachineGauges.tsx · MachineGaugeLine). */
  gauge: React.ReactNode
  /** False: it cannot be gone into from here (the console's offline or outdated machine); its frame is no control. */
  openable?: boolean
  /** Beside its name: how this page reaches it (the console's path word). */
  badge?: React.ReactNode
  /** The agent the keys stand on, when it is on this machine (agent-keys.ts · pickKey). */
  picked?: string | null
  /** A face pressed: that agent's card pops from it. Absent where none can (the console): a face goes into its workspace. */
  onPick?: (spot: PickSpot, face: HTMLElement) => void
  bind: Bind
  onOpen: () => void
  onOpenWorkspace: (workspaceId: string) => void
}


export const MachineFrame = memo(function MachineFrame({ machine, frame, agentK, say, caption, gauge, openable = true, badge = null, picked = null, onPick, bind, onOpen, onOpenWorkspace }: MachineFrameProps): React.JSX.Element {
  const lit = say === null
  return (
    <div ref={bind(`machinecard:${machine.id}`)} className={`zv-machine zv-other${machine.online ? '' : ' off'}`} data-read={lit} style={{ width: frame.w, height: frame.h }}>
      <button type="button" className="zv-machine-open" aria-label={lit ? `Open ${machine.name}` : `${machine.name}: ${say}`} title={lit ? undefined : (say ?? undefined)} disabled={!openable} onClick={onOpen} />
      {lit ? (
        <DevicesAgents machine={machine.id} name={machine.name} marks={machine.marks} frame={frame} k={agentK} picked={picked} onPick={onPick} onOpenWorkspace={onOpenWorkspace} onOpen={openable ? onOpen : undefined} />
      ) : (
        <p className="zv-om-say zv-om-blank">{say}</p>
      )}
      <span className="zv-machine-deck" />
      <span className="zv-machine-label">
        <b>
          {machine.name}
          {badge}
        </b>
        <small>{caption}</small>
        {gauge}
      </span>
    </div>
  )
})
