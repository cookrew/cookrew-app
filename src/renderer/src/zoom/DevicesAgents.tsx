import { memo } from 'react'
import { GroupFace } from './agents-group'
import { byStatus } from './ink-status'
import { pickKey, type PickGroup, type PickSpot } from './agent-keys'
import type { AgentView, MarkView } from './zoom-model'
import './devices-agents.css'

/**
 * A MACHINE'S SCREEN ON THE DEVICES STOP: ITS AGENTS ONLY (owner, 2026-11-17:
 * the devices page shows each workspace's agents, each face the size the
 * workspace card draws it). No deck, no screenshots: a workspace is its name
 * and its faces, wrapped. The faces are drawn in the workspace card's own px
 * (agents-group.tsx · GROUP_FACE) and scaled by `k` into the frame, so they are
 * as big on screen as on the workspaces stop; a machine with more agents than
 * its screen holds scrolls inside it. A face pops that agent's card (the keys
 * stand on the same faces: agent-keys.ts); a workspace's name goes into it.
 */

/** A workspace's faces in the order its card draws them: who needs the owner first (ink-status.ts · byStatus). */
export const shownAgents = (mark: MarkView): AgentView[] => byStatus(mark.agents ?? [])

/** The agents a machine's screen draws, workspace by workspace: what the keys walk (agent-keys.ts · ringOf). */
export const groupsOf = (machine: string, marks: readonly MarkView[]): PickGroup[] =>
  marks.map((mark) => ({ machine, workspace: mark.id, agents: shownAgents(mark).map((a) => a.id) }))

/** The screen inside a frame's bezel, in the frame's units (zoom.css · .zv-machine::before). */
export const SCREEN_INSET = 10

export interface DevicesAgentsProps {
  /** The machine the faces are on: LOCAL_MACHINE for this one (agent-keys.ts). */
  machine: string
  name: string
  marks: readonly MarkView[]
  /** The frame's size, in the devices layer's units. */
  frame: { w: number; h: number }
  /** A workspace card's px in the frame's units: what draws a face at the workspaces stop's size on screen. */
  k: number
  /** The agent the keys stand on, when it is on this machine (agent-keys.ts · pickKey). */
  picked?: string | null
  /** A face pressed: its agent, and the face to pop the card from. Absent where no card can pop (the console). */
  onPick?: (spot: PickSpot, face: HTMLElement) => void
  onOpenWorkspace: (workspaceId: string) => void
  /** A press on the screen between the faces: into the machine, as its frame does. */
  onOpen?: () => void
}

function Workspace({ machine, mark, picked, onPick, onOpenWorkspace }: { machine: string; mark: MarkView; picked: string | null; onPick?: DevicesAgentsProps['onPick']; onOpenWorkspace: (id: string) => void }): React.JSX.Element {
  const agents = shownAgents(mark)
  // Faces the feed names no one for (the roster's, a machine not read whole): drawn, not stood on.
  const still = agents.length === 0 ? mark.presets : []
  return (
    <section className="da-ws" data-ws={mark.id} data-waiting={mark.waitingCount > 0 || undefined}>
      <button type="button" className="da-ws-name" title={`Open ${mark.name}`} onClick={(e) => { e.stopPropagation(); onOpenWorkspace(mark.id) }}>
        <span>{mark.name}</span>
        {mark.waitingCount > 0 && <i className="dm-wait">{mark.waitingCount}</i>}
      </button>
      <div className="da-faces">
        {agents.map((a) => {
          const key = pickKey({ machine, agent: a.id })
          return (
            <button
              key={a.id}
              type="button"
              className="da-face"
              data-pick={key}
              tabIndex={-1}
              aria-current={picked === key ? 'true' : undefined}
              aria-label={`${a.name}, ${a.word}, in ${mark.name}`}
              title={`${a.name} · ${a.word}`}
              onClick={(e) => {
                e.stopPropagation()
                if (onPick) onPick({ machine, workspace: mark.id, agent: a.id }, e.currentTarget)
                else onOpenWorkspace(mark.id)
              }}
            >
              <GroupFace id={a.id} preset={a.preset} orch={a.orch} status={a.status} />
            </button>
          )
        })}
        {still.map((preset, i) => <span key={i} className="da-face still"><GroupFace id={`${mark.id}:${i}`} preset={preset} /></span>)}
        {agents.length === 0 && still.length === 0 && <span className="da-none">no agents</span>}
      </div>
    </section>
  )
}

export const DevicesAgents = memo(function DevicesAgents({ machine, name, marks, frame, k, picked = null, onPick, onOpenWorkspace, onOpen }: DevicesAgentsProps): React.JSX.Element {
  const w = Math.max(1, frame.w - SCREEN_INSET * 2)
  const h = Math.max(1, frame.h - SCREEN_INSET * 2)
  const s = k > 0 ? k : 1
  return (
    <div className="da-screen" style={{ left: SCREEN_INSET, top: SCREEN_INSET, width: w, height: h }}>
      <div className="da-scroll" style={{ width: w / s, height: h / s, transform: `scale(${s.toFixed(4)})` }} onClick={onOpen}>
        <div className="da-title">
          <b>{name}</b>
          <span>{marks.length} {marks.length === 1 ? 'workspace' : 'workspaces'}</span>
        </div>
        <div className="da-list">
          {marks.map((mark) => <Workspace key={mark.id} machine={machine} mark={mark} picked={picked} onPick={onPick} onOpenWorkspace={onOpenWorkspace} />)}
          {marks.length === 0 && <p className="da-none">no workspaces</p>}
        </div>
      </div>
    </div>
  )
})
