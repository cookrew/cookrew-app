// One agent's sphere in its seat, at any level. Interactive seats are buttons
// (hover → summary after intent, click → dive, hold on touch → summary + fan);
// seats too small to hit are drawn passive and picked through the loupe, but
// stay keyboard-focusable so Shift+arrows can reach them.
import { anchorOf } from '../../shared/strata'
import type { AvatarSize } from '../seams'
import { agentLabel } from '../summary/format'
import { usePressHold } from '../input/use-press-hold'
import { useLevels } from './env'
import { Figure, rectStyle } from './Figure'
import type { SeatRef } from './model'
import { pressOf } from './press'
import { pathKey, samePath } from './selection'

/**
 * interactive: drawn at ≥ MIN_TARGET for the input, so it is a dive target.
 * grow: its hit area takes the whole seat pitch (L2); at L1 only the drawn
 * ball is the avatar's, so the gaps, label band and frame go in. Either way
 * the art is drawn at the seat, around the hit.
 * pick: drawn under the target but still the only thing to press (a phone's
 * L2): the first tap or a hold picks it (highlight and card), a tap on the
 * picked seat dives, so a tap on the wrong neighbour costs nothing. The level
 * owns which seat is picked; a key's Enter (a click with no detail) dives.
 */
export function Avatar({
  seat,
  size,
  interactive,
  grow = false,
  pick = null,
  offline = false
}: {
  seat: SeatRef
  size: AvatarSize
  interactive: boolean
  grow?: boolean
  pick?: { picked: boolean; onPick: () => void } | null
  offline?: boolean
}) {
  const env = useLevels()
  const anchor = env.useAnchor(anchorOf(seat.path))
  const { agent } = seat
  const art = env.kit.avatar({
    phase: offline ? 'offline' : agent.phase,
    source: offline ? 'ledger' : agent.phaseSource,
    harness: agent.harness,
    size
  })
  const highlighted = samePath(env.highlight, seat.path)
  const lit = env.glow?.has(seat.key) ?? false
  const className = ['avatar', `avatar-${size}`, grow && 'grown', highlighted && 'hl', lit && 'glow', env.glow && !lit && 'dim', interactive ? 'live-hit' : 'passive']
    .filter(Boolean)
    .join(' ')
  const show = () => {
    pick?.onPick()
    env.setHighlight(seat.path, 'pointer')
    env.hover.showNow(seat.key)
  }
  const hold = usePressHold(show)
  const box = grow ? seat.hit : seat.ball
  // Up to two of its cards peek out from behind it; the fan shows them all.
  const tucked = size === 'full' ? agent.attachments.slice(0, 2) : []

  return (
    <button
      type="button"
      ref={anchor}
      className={className}
      style={{
        ...rectStyle(box),
        ['--ax' as string]: `${seat.rect.x - box.x}px`,
        ['--ay' as string]: `${seat.rect.y - box.y}px`,
        ['--aw' as string]: `${seat.rect.w}px`
      }}
      data-stage-focus={highlighted || undefined}
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
      onClick={(e) => {
        const press = pressOf({ held: hold.consumeHold(), pick: pick !== null, picked: pick?.picked ?? false, keyboard: e.detail === 0 })
        if (press === 'pick') show()
        if (press === 'dive') env.go(seat.path)
      }}
    >
      {tucked.length > 0 && (
        <span className="tuck" aria-hidden="true">
          {tucked.map((a, i) => (
            <Figure key={a.id} art={env.kit.attachment({ kind: a.kind, shared: false })} className={`tuck-card${i > 0 ? ' second' : ''}`} />
          ))}
        </span>
      )}
      <Figure art={art} />
      {env.codes && size !== 'dot' && (
        <span className="code" aria-hidden="true">
          {env.codes.get(seat.key)}
        </span>
      )}
    </button>
  )
}
