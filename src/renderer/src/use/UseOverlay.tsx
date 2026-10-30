import { useMemo } from 'react'
import type { UseStatus } from '../../../shared/use-signal'
import { useRoster } from '../agent-registry'
import { useCardCursors, type CardCursor } from '../use-cursors'
import './use-overlay.css'

/**
 * WHAT IS HAPPENING ON A CARD'S SCREEN, OVER THE FRAME (desktop and phone).
 *
 * The cursors: one per agent acting on this card, drawn inside the frame's
 * letterbox so a fraction of the screen is that fraction of the picture,
 * moving where the agent acts, rippling on a tap, heading home to the pet
 * corner when the agent goes quiet (use-cursors.ts).
 *
 * The device line: a use card's device offline says why in the owner's
 * words ("Screen Recording is off…", "No Android device is attached…"),
 * a screen nobody may drive says "view only", a dropped socket says it is
 * dialling again — over the last frame, never instead of it.
 */

export interface FrameBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

const HUES = [262, 200, 150, 28, 340, 95, 180, 300]

function hueOf(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return HUES[h % HUES.length]
}

export function UseOverlay({
  card,
  box,
  status,
  reconnecting
}: {
  card: string
  box: FrameBox | null
  status: UseStatus | null
  reconnecting: boolean
}): JSX.Element | null {
  const cursors = useCardCursors(card)
  const roster = useRoster()
  const names = useMemo(() => new Map(roster.map((r) => [r.id, r.name])), [roster])
  const line = deviceLine(status, reconnecting)
  if (!line && cursors.length === 0) return null
  return (
    <div className="use-overlay" aria-hidden={cursors.length > 0 && !line ? 'true' : undefined}>
      {box && box.width > 0 && cursors.length > 0 && (
        <div className="use-cursors" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
          {cursors.map((c) => (
            <Cursor key={c.agent} cursor={c} name={names.get(c.agent) ?? 'agent'} />
          ))}
        </div>
      )}
      {line && (
        <div className={`use-device use-device-${line.tone}`} role="status">
          {line.text}
        </div>
      )}
    </div>
  )
}

function Cursor({ cursor, name }: { cursor: CardCursor; name: string }): JSX.Element {
  const hue = hueOf(cursor.agent)
  const pointed = cursor.verb === 'tap' || cursor.verb === 'click' || cursor.verb === 'swipe' || cursor.verb === 'fill'
  return (
    <div
      className={`use-cursor${cursor.returningSince !== null ? ' returning' : ''}`}
      data-agent={cursor.agent}
      data-verb={cursor.verb}
      style={{ left: `${cursor.at.x * 100}%`, top: `${cursor.at.y * 100}%`, ['--use-hue' as string]: String(hue) }}
      title={`${name} · ${cursor.verb}`}
    >
      {pointed && cursor.returningSince === null && <span key={cursor.actedAt} className="use-ripple" />}
      <svg className="use-arrow" viewBox="0 0 16 20" width="16" height="20" aria-hidden="true">
        <path d="M1 1 L1 16 L5 12 L8 19 L11 17.6 L8 11 L14 11 Z" />
      </svg>
      <span className="use-badge">{name.slice(0, 1).toUpperCase()}</span>
      <span className="use-verb" key={`v${cursor.actedAt}`}>
        {name} · {cursor.verb}
      </span>
    </div>
  )
}

export function deviceLine(
  status: UseStatus | null,
  reconnecting: boolean
): { text: string; tone: 'warn' | 'quiet' } | null {
  if (reconnecting) return { text: 'reconnecting…', tone: 'quiet' }
  if (!status) return null
  if (status.state === 'offline') return { text: status.message ?? 'the device is offline', tone: 'warn' }
  if (status.state === 'connecting') return { text: `connecting to the ${status.use === 'hardware' ? 'camera' : status.use}…`, tone: 'quiet' }
  if (!status.input) return { text: status.use === 'hardware' ? 'camera · view only' : 'view only', tone: 'quiet' }
  return null
}
