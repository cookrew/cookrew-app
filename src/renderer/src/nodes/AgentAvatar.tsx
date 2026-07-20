import type { TurnPhase } from '../../../shared/turn'
import { spriteForPreset, type AgentSpriteKind } from './AgentSprite'

/**
 * Minimal-coin status avatar (Suite B): the agent's brand mark stamped on a
 * disc IS the avatar. Status is carried by the coin alone —
 *   idle     green, at rest
 *   thinking orange, spinning edge-on in place
 *   waiting  red, rocking + blinking
 *   replied  green, at rest + unread dot (cleared by acknowledge-on-view)
 * The baby hand lives in the logo, not on cards. Motion only for
 * thinking/waiting (perf rule: resting cards never composite).
 */

/** Stamped near-black, readable on every phase tint. */
const STAMP = '#1c1408'

/** Brand marks echoing each agent's real logo: Claude sunburst, OpenAI
    blossom (Codex), opencode block-cursor, arcade invader for Shell. */
function brandMark(kind: AgentSpriteKind): React.JSX.Element {
  if (kind === 'claude') {
    return (
      <g stroke={STAMP} strokeWidth="2.5" strokeLinecap="round">
        {Array.from({ length: 8 }, (_, i) => {
          const a = ((i * 45 - 90) * Math.PI) / 180
          const r = i % 2 === 0 ? 7.2 : 6.4
          return (
            <line
              key={i}
              x1="13"
              y1="13"
              x2={(13 + Math.cos(a) * r).toFixed(2)}
              y2={(13 + Math.sin(a) * r).toFixed(2)}
            />
          )
        })}
      </g>
    )
  }
  if (kind === 'codex') {
    return (
      <g fill={STAMP}>
        {Array.from({ length: 6 }, (_, i) => (
          <rect
            key={i}
            x="11.8"
            y="4.4"
            width="2.4"
            height="8.4"
            rx="1.2"
            transform={`rotate(${i * 60} 13 13) rotate(27 13 8.6)`}
          />
        ))}
      </g>
    )
  }
  if (kind === 'opencode') {
    return (
      <g fill={STAMP}>
        <rect x="7.6" y="7" width="6.2" height="10" rx="1" />
        <rect x="15.4" y="14.8" width="3.6" height="2.2" rx="0.6" />
      </g>
    )
  }
  const grid = ['.X...X.', '..X.X..', '.XXXXX.', 'XX.X.XX', 'XXXXXXX', '.X...X.']
  const cell = 2.4
  const ox = 13 - (7 * cell) / 2
  const oy = 13 - (grid.length * cell) / 2
  return (
    <g fill={STAMP}>
      {grid.flatMap((row, y) =>
        [...row].flatMap((c, x) =>
          c === 'X'
            ? [
                <rect
                  key={`${x}-${y}`}
                  x={(ox + x * cell).toFixed(2)}
                  y={(oy + y * cell).toFixed(2)}
                  width={cell}
                  height={cell}
                />
              ]
            : []
        )
      )}
    </g>
  )
}

function coinFace(kind: AgentSpriteKind | null): React.JSX.Element {
  return (
    <g className="ava-coin-tint">
      <circle cx="13" cy="13" r="11.5" fill="currentColor" stroke="var(--ink)" strokeWidth="2" />
      <circle cx="13" cy="13" r="8.9" fill="none" stroke={STAMP} strokeWidth="1.2" opacity="0.35" />
      {kind ? brandMark(kind) : null}
    </g>
  )
}

export function AgentAvatar({
  preset,
  phase
}: {
  preset: string
  phase: TurnPhase
}): React.JSX.Element {
  return (
    <span className={`vi-avatar ${phase}`}>
      <svg viewBox="0 0 26 26" aria-hidden="true" focusable="false">
        <g className="ava-spin">{coinFace(spriteForPreset(preset))}</g>
      </svg>
      {phase === 'replied' && <span className="vi-unread" />}
    </span>
  )
}

/** Mini status coin standing in for the old LED dots in dense contexts
    (mini tiles, overlay header, app header). */
export function StatusCoin({
  phase,
  preset,
  title
}: {
  phase: TurnPhase | 'off'
  preset?: string
  title?: string
}): React.JSX.Element {
  return (
    <svg className={`vi-coin-led ${phase}`} viewBox="0 0 26 26" focusable="false">
      {title ? <title>{title}</title> : null}
      {coinFace(preset ? spriteForPreset(preset) : null)}
    </svg>
  )
}
