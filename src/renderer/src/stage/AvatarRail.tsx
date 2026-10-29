// THE AVATARS: every agent as a small round face at the stage's right edge,
// like the faces down the side of a chat. Pointing at one (a tap on a phone)
// opens its board card as a speech bubble — the same AgentRow the board drew,
// latest checkpoint and all; a click (a double tap) puts it on the stage.
import { useEffect, useRef, useState } from 'react'
import { AgentRow } from '../AgentRow'
import type { AgentRow as Row } from '../agent-rows'
import { AgentAvatar } from '../nodes/AgentAvatar'
import type { TurnPhase } from '../../../shared/turn'

const AVATAR_PHASE: Record<Row['phase'], TurnPhase> = {
  working: 'thinking',
  waiting: 'waiting',
  done: 'replied',
  offline: 'idle',
  quiet: 'idle'
}

/** Two taps on one face this close together go in. */
const DOUBLE_TAP_MS = 350
/** The bubble outlives the pointer by this long, so it can be reached. */
const LEAVE_MS = 220

export function AvatarRail({
  rows,
  now,
  current,
  onEnter
}: {
  rows: readonly Row[]
  now: number
  /** The agent on the stage. */
  current: string | null
  onEnter: (row: Row) => void
}): React.JSX.Element {
  const [shown, setShown] = useState<{ id: string; top: number } | null>(null)
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointer = useRef<string>('mouse')
  const lastTap = useRef<{ id: string; at: number } | null>(null)
  const rail = useRef<HTMLDivElement>(null)

  const hold = (): void => {
    if (leave.current) clearTimeout(leave.current)
    leave.current = null
  }
  const letGo = (): void => {
    hold()
    leave.current = setTimeout(() => setShown(null), LEAVE_MS)
  }
  useEffect(() => () => hold(), [])
  const show = (id: string, el: HTMLElement): void => {
    hold()
    const top = el.getBoundingClientRect().top - (rail.current?.getBoundingClientRect().top ?? 0)
    setShown({ id, top })
  }
  // A tap anywhere else puts the bubble away on a phone.
  useEffect(() => {
    if (shown === null) return
    const away = (e: PointerEvent): void => {
      if (!rail.current?.contains(e.target as Node)) setShown(null)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [shown])

  const row = shown ? rows.find((r) => r.id === shown.id) ?? null : null
  return (
    <div className="cr-rail" ref={rail} onPointerLeave={(e) => e.pointerType === 'mouse' && letGo()}>
      <div className="cr-rail-faces" role="list" aria-label="Agents">
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            role="listitem"
            className={`cr-rail-face ${r.phase}${r.id === current ? ' on' : ''}`}
            aria-label={`${r.name}, ${r.workspaceName}`}
            onPointerDown={(e) => {
              pointer.current = e.pointerType
            }}
            onPointerEnter={(e) => {
              if (e.pointerType === 'mouse') show(r.id, e.currentTarget)
            }}
            onClick={(e) => {
              if (pointer.current === 'mouse') return onEnter(r)
              const tap = lastTap.current
              lastTap.current = { id: r.id, at: Date.now() }
              if (tap && tap.id === r.id && Date.now() - tap.at < DOUBLE_TAP_MS) {
                setShown(null)
                onEnter(r)
                return
              }
              if (shown?.id === r.id) setShown(null)
              else show(r.id, e.currentTarget)
            }}
          >
            <AgentAvatar phase={AVATAR_PHASE[r.phase]} preset={r.preset} />
          </button>
        ))}
      </div>
      {row && shown && (
        <div className="cr-rail-bubble" style={{ top: Math.max(0, shown.top) }} onPointerEnter={hold}>
          <div className="cr-rail-bubble-body">
          <AgentRow
            row={row}
            now={now}
            selected={false}
            recovering={false}
            canRecover={false}
            onOpen={(r) => {
              setShown(null)
              onEnter(r)
            }}
            onRecover={() => undefined}
          />
          </div>
        </div>
      )}
    </div>
  )
}
