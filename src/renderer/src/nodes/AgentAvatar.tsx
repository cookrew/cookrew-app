import type { TurnPhase } from '../../../shared/turn'
import { HAND_PATH } from '../CrLogoMark'
import { SPRITE_CELLS, spriteForPreset } from './AgentSprite'

/**
 * Status avatar for agent cards: the Cookrew baby hand acting out the turn
 * phase with the agent's pixel icon —
 *   idle     hand at rest, icon parked beside it (dim green)
 *   thinking fingers juggle the icon above the fingertips (orange, animated)
 *   waiting  hand waves for attention, icon blinks red
 *   replied  icon rests held on the fingertips (green)
 * Layout and motion live in CSS under .vi-avatar.<phase>.
 */
export function AgentAvatar({
  preset,
  phase
}: {
  preset: string
  phase: TurnPhase
}): React.JSX.Element {
  return (
    <span className={`vi-avatar ${phase}`}>
      <svg viewBox="0 0 48 30" aria-hidden="true" focusable="false">
        <g className="ava-icon">
          <g className="ava-tint">
            <g className="ava-spin">{SPRITE_CELLS[spriteForPreset(preset)]}</g>
          </g>
        </g>
        <g className="ava-hand">
          <svg x="1" y="8" width="21" height="21" viewBox="0 0 32 32">
            <path
              d={HAND_PATH}
              transform="translate(1.6 1.6)"
              fill="var(--amber)"
              stroke="var(--amber)"
              strokeWidth="3"
              strokeLinejoin="round"
            />
            <path d={HAND_PATH} fill="var(--ink)" stroke="var(--ink)" strokeWidth="3" strokeLinejoin="round" />
            <path d={HAND_PATH} fill="var(--cream-hi)" />
          </svg>
        </g>
      </svg>
    </span>
  )
}

/** Baby-hand silhouette standing in for the old status LEDs, tinted and
    animated per phase via .vi-hand-led CSS. */
export function HandLed({
  phase,
  title
}: {
  phase: TurnPhase | 'off'
  title?: string
}): React.JSX.Element {
  return (
    <svg className={`vi-hand-led ${phase}`} viewBox="0 0 32 34" focusable="false">
      {title ? <title>{title}</title> : null}
      <path d={HAND_PATH} fill="currentColor" />
    </svg>
  )
}
