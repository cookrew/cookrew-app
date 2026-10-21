// Attention pins: every waiting agent raises one, clickable at every level —
// a click dives straight in. A pin never moves its item. Per item at most
// MAX_PINS, then a +N pin that opens the finder's "Waiting on you" list.
import type { Rect, StrataMachine } from '../../shared/strata'
import { agentKey } from '../finder/search'
import { formatElapsed } from '../summary/format'
import { useLevels } from './env'
import { rectStyle } from './Figure'
import { machineWorkspaces } from './model'

const MAX_PINS = 3

export interface PinTarget {
  machineId: string
  workspaceId: string
  agentId: string
  name: string
  since: number | null
}

/** Waiting agents of a live machine (optionally one workspace or one agent), oldest wait first. */
export const waitingPins = (machine: StrataMachine, workspaceId?: string, agentId?: string): PinTarget[] =>
  machine.link !== 'live'
    ? []
    : machineWorkspaces(machine)
        .filter((w) => !workspaceId || w.id === workspaceId)
        .flatMap((w) =>
          w.agents
            .filter((a) => a.phase === 'waiting' && (!agentId || a.id === agentId))
            .map((a) => ({ machineId: machine.id, workspaceId: w.id, agentId: a.id, name: a.name, since: a.phaseSince }))
        )
        .sort((a, b) => (a.since ?? 0) - (b.since ?? 0))

/** L2: the avatar itself is the dive target, so its pin is a badge that cannot steal the tap. */
export function PinBadge({ seat }: { seat: Rect }) {
  const size = 18
  return (
    <span className="pin badge" aria-hidden="true" style={rectStyle({ x: seat.x + seat.w / 2 - size / 2, y: seat.y - size - 2, w: size, h: size })}>
      <span>!</span>
    </span>
  )
}

export function Pins({ pins, strip, onMore }: { pins: PinTarget[]; strip: Rect; onMore: () => void }) {
  const env = useLevels()
  if (pins.length === 0) return null
  const size = env.touch ? 44 : 24
  const shown = pins.length > MAX_PINS + 1 ? pins.slice(0, MAX_PINS) : pins
  const more = pins.length - shown.length
  const count = shown.length + (more > 0 ? 1 : 0)
  const step = size + 6
  const x0 = strip.x + strip.w / 2 - (count * step - 6) / 2
  const y = strip.y + strip.h - size
  const now = env.now()
  return (
    <>
      {shown.map((pin, i) => {
        const key = agentKey(pin.machineId, pin.agentId)
        const path = { machine: pin.machineId, workspace: pin.workspaceId, agent: pin.agentId }
        return (
          <button
            key={key}
            type="button"
            className="pin"
            style={rectStyle({ x: x0 + i * step, y, w: size, h: size })}
            aria-label={`${pin.name} is waiting${pin.since === null ? '' : `, ${formatElapsed(now - pin.since)}`}. Open terminal`}
            onPointerEnter={(e) => {
              if (e.pointerType === 'touch') return
              env.setHighlight(path, 'pointer')
              env.hover.enter(key)
            }}
            onPointerLeave={() => env.hover.leave(key)}
            onClick={() => env.go(path)}
          >
            <span>{pin.name.slice(0, 1).toUpperCase()}</span>
          </button>
        )
      })}
      {more > 0 && (
        <button type="button" className="pin more" style={rectStyle({ x: x0 + shown.length * step, y, w: size, h: size })} aria-label={`${more} more waiting. Open the finder`} onClick={onMore}>
          <span>+{more}</span>
        </button>
      )}
    </>
  )
}
