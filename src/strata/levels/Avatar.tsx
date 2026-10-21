// One agent's sphere in its seat, at any level. Interactive seats are buttons
// (hover → summary after intent, click → dive, hold on touch → summary + fan);
// seats too small to hit are drawn passive and picked through the loupe, but
// stay keyboard-focusable so Shift+arrows can reach them.
import type { AvatarSize } from '../seams'
import { agentLabel } from '../summary/format'
import { usePressHold } from '../input/use-press-hold'
import { useLevels } from './env'
import { Figure, rectStyle } from './Figure'
import type { SeatRef } from './model'
import { pathKey, samePath } from './selection'

export function Avatar({ seat, size, interactive, offline = false }: { seat: SeatRef; size: AvatarSize; interactive: boolean; offline?: boolean }) {
  const env = useLevels()
  const { agent } = seat
  const art = env.kit.avatar({
    phase: offline ? 'offline' : agent.phase,
    source: offline ? 'ledger' : agent.phaseSource,
    harness: agent.harness,
    size
  })
  const highlighted = samePath(env.highlight, seat.path)
  const lit = env.glow?.has(seat.key) ?? false
  const className = ['avatar', `avatar-${size}`, highlighted && 'hl', lit && 'glow', env.glow && !lit && 'dim', interactive ? 'live-hit' : 'passive']
    .filter(Boolean)
    .join(' ')
  const hold = usePressHold(() => {
    env.setHighlight(seat.path, 'pointer')
    env.hover.showNow(seat.key)
  })
  const tucked = size === 'full' ? agent.attachments.length : 0

  return (
    <button
      type="button"
      ref={env.useAnchor(`agent:${agent.id}`)}
      className={className}
      style={{ ...rectStyle(seat.hit), ['--pad' as string]: `${(seat.hit.w - seat.rect.w) / 2}px` }}
      data-path={pathKey(seat.path)}
      tabIndex={highlighted ? 0 : -1}
      aria-label={agentLabel(agent, env.now(), offline)}
      onPointerEnter={(e) => {
        if (!interactive || e.pointerType === 'touch') return
        env.setHighlight(seat.path, 'pointer')
        env.hover.enter(seat.key)
      }}
      onPointerLeave={() => interactive && env.hover.leave(seat.key)}
      onPointerDown={hold.onPointerDown}
      onPointerMove={hold.onPointerMove}
      onPointerUp={hold.onPointerUp}
      onPointerCancel={hold.onPointerCancel}
      onContextMenu={(e) => env.touch && e.preventDefault()}
      onClick={() => {
        if (hold.consumeHold()) return
        env.go(seat.path)
      }}
    >
      {tucked > 0 && (
        <span className="tuck" aria-hidden="true">
          <span className="tuck-card" />
          {tucked > 1 && <span className="tuck-card second" />}
          <span className="tuck-count">{tucked}</span>
        </span>
      )}
      <Figure art={art} />
      {agent.phase === 'replied' && !offline && size !== 'dot' && <span className="tick" aria-hidden="true" />}
      {env.codes && size !== 'dot' && (
        <span className="code" aria-hidden="true">
          {env.codes.get(seat.key)}
        </span>
      )}
    </button>
  )
}
