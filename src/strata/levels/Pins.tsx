// Attention pins: every waiting agent raises one, clickable at every level —
// a click dives straight in. A pin never moves its item. Per item at most
// MAX_PINS, then a +N pin that opens the finder's "Waiting on you" list.
import { useRef, type PointerEvent } from 'react'
import type { Rect, StrataMachine, StrataPath } from '../../shared/strata'
import { agentKey } from '../finder/search'
import { HOLD, markConsumed } from '../input/gestures'
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
  const down = useRef<{ x: number; y: number } | null>(null)
  if (pins.length === 0) return null
  const shown = pins.length > MAX_PINS + 1 ? pins.slice(0, MAX_PINS) : pins
  const more = pins.length - shown.length
  const now = env.now()
  // Touch: a tap dives on lift (the stroke is consumed, so the stage never reads it as a swipe).
  const tap = (e: PointerEvent, path: Required<StrataPath>) => {
    const start = down.current
    down.current = null
    if (e.pointerType !== 'touch' || !start) return
    const still = Math.hypot(e.clientX - start.x, e.clientY - start.y) <= HOLD.slop
    if (!still) return
    markConsumed(e.nativeEvent)
    env.go(path)
  }
  // A row of callouts centred over the item, each naming who is waiting; the tail points at the item.
  return (
    <div className="pins" data-plane="screen" style={rectStyle(strip)}>
      {shown.map((pin) => {
        const key = agentKey(pin.machineId, pin.agentId)
        const path = { machine: pin.machineId, workspace: pin.workspaceId, agent: pin.agentId }
        return (
          <button
            key={key}
            type="button"
            className="pin"
            aria-label={`${pin.name} is waiting${pin.since === null ? '' : `, ${formatElapsed(now - pin.since)}`}. Open terminal`}
            onPointerEnter={(e) => {
              if (e.pointerType === 'touch') return
              env.setHighlight(path, 'pointer')
              env.hover.enter(key)
            }}
            onPointerLeave={() => env.hover.leave(key)}
            onPointerDown={(e) => e.pointerType === 'touch' && (down.current = { x: e.clientX, y: e.clientY })}
            onPointerUp={(e) => tap(e, path)}
            onClick={(e) => (e.nativeEvent as globalThis.PointerEvent).pointerType !== 'touch' && env.go(path)}
          >
            <i className="pin-dot" aria-hidden="true" />
            <span className="pin-name">{pin.name}</span>
          </button>
        )
      })}
      {more > 0 && (
        <button type="button" className="pin more" aria-label={`${more} more waiting. Open the finder`} onClick={onMore}>
          <span className="pin-name">+{more}</span>
        </button>
      )}
    </div>
  )
}
