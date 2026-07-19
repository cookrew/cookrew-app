import type { TurnPhase } from '../../../shared/turn'
import { HAND_PATH } from '../CrLogoMark'
import { spriteForPreset, type AgentSpriteKind } from './AgentSprite'

/**
 * Status avatar for agent cards: a baby hand acting out each turn phase with
 * the agent's coin. The hand keeps its brand colors (cream/ink/amber) in
 * every phase and strikes a different pose per status; only the coin (agent
 * brand mark stamped on a disc) carries the status color —
 *   idle     hand naps flat, coin parked beside the fingertips (dim green)
 *   thinking fist pumps, coin tossed off the thumb, spinning (orange)
 *   waiting  open palm waves hey-hey then rests a beat, coin blinks red
 *   replied  the V "yes!" holds the coin on its fingertips (green)
 * Layout and motion live in CSS under .vi-avatar.<phase>.
 */

/** Hand poses on the logo's 32-box, wrist/arm exiting the frame. */
const POSES = {
  yes: HAND_PATH,
  fist:
    'M 10 13 C 10.5 11 13 10.3 14.8 11.2 C 15.8 10.2 18.4 10.2 19.4 11.3 ' +
    'C 20.6 10.4 23 10.9 23.8 12.3 C 25.5 12.2 26.8 13.4 26.8 15.2 C 26.8 16.8 25.8 17.8 24.6 18.2 ' +
    'C 26 19.5 26.2 21.5 25 23.2 C 24 24.8 22.5 25.8 21 26.2 C 21.3 28.4 21.5 30.6 21.6 33 ' +
    'L 9.6 33 C 9.7 30.4 9.8 28 9.6 26 C 8.6 24.2 8.2 21 8.6 18.5 C 8.2 16 8.8 14.2 10 13 Z',
  palm:
    'M 7.2 14.4 C 7.4 12.9 7.6 12.2 8.2 11.2 C 8.5 10.2 9.8 10.0 10.3 10.9 C 10.9 12.2 11.0 13.4 11.1 14.3 ' +
    'C 11.3 13.0 11.6 9.4 12.1 8.2 C 12.4 7.2 13.8 7.0 14.2 8.0 C 14.6 9.6 14.7 12.0 14.8 13.4 ' +
    'C 15.0 11.4 15.2 7.6 15.6 6.7 C 15.9 5.7 17.4 5.7 17.7 6.7 C 18.1 8.0 18.2 11.4 18.3 13.3 ' +
    'C 18.6 11.6 18.9 8.8 19.3 7.9 C 19.7 6.9 21.0 7.0 21.3 8.0 C 21.7 9.8 21.6 12.0 21.5 13.8 ' +
    'C 22.2 13.4 23.2 12.6 24.0 12.2 C 24.8 11.6 26.2 11.6 26.8 12.5 C 27.5 13.4 27.3 14.7 26.5 15.3 ' +
    'C 25.5 16.1 24.4 16.9 23.6 17.5 C 23.9 19.4 23.7 21.4 23.0 23.0 C 22.8 24.4 22.6 25.4 22.7 26.4 ' +
    'C 22.9 28.6 23.0 30.8 23.0 33 L 10.4 33 C 10.4 30.0 10.3 27.6 10.0 26.0 C 8.9 23.8 7.9 20.6 7.6 18.2 ' +
    'C 7.4 16.8 7.3 15.4 7.2 14.4 Z',
  rest:
    'M 3.4 33 C 3.6 29.8 4.2 27.4 5.6 25.6 C 6.4 23.0 8.2 20.8 11.0 19.8 C 12.2 18.6 14.0 18.4 15.2 19.0 ' +
    'C 16.4 18.2 18.4 18.4 19.4 19.3 C 21.2 20.0 22.8 21.2 23.8 22.6 C 24.8 23.8 25.1 24.8 24.8 25.4 ' +
    'C 24.5 26.6 23.2 27.4 22.2 27.3 C 21.6 27.2 21.2 26.8 21.0 26.4 C 20.8 27.0 20.2 27.5 19.4 27.4 ' +
    'C 18.8 27.3 18.3 26.9 18.1 26.5 C 17.8 27.1 17.2 27.6 16.4 27.5 C 15.5 27.4 15.0 27.0 14.8 26.6 ' +
    'C 13.4 27.4 10.6 27.6 8.0 28.0 C 6.4 28.8 5.0 30.8 4.8 33 Z'
} as const

const POSE_FOR: Record<TurnPhase, keyof typeof POSES> = {
  idle: 'rest',
  thinking: 'fist',
  waiting: 'palm',
  replied: 'yes'
}

/** Stamped near-black, readable on every phase tint. */
const STAMP = '#1c1408'

/** Brand marks stamped on the coin face, echoing each agent's real logo:
    Claude's sunburst spark, OpenAI's hexagonal blossom for Codex, the
    opencode terminal block-cursor, and the arcade invader for Shell. */
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

function BrandHand({ pose }: { pose: keyof typeof POSES }): React.JSX.Element {
  const d = POSES[pose]
  return (
    <g className="ava-hand">
      <svg x="1" y="11" width="23" height="23" viewBox="0 0 32 32">
        <path
          d={d}
          transform="translate(1.6 1.6)"
          fill="var(--amber)"
          stroke="var(--amber)"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        <path d={d} fill="var(--ink)" stroke="var(--ink)" strokeWidth="3" strokeLinejoin="round" />
        <path d={d} fill="var(--cream-hi)" />
      </svg>
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
      <svg viewBox="0 0 52 34" aria-hidden="true" focusable="false">
        <g className="ava-coin">
          <g className="ava-roll">
            <g className="ava-flip">{coinFace(spriteForPreset(preset))}</g>
          </g>
        </g>
        <BrandHand pose={POSE_FOR[phase]} />
      </svg>
    </span>
  )
}

/** Mini status coin standing in for the old LED dots: agent brand mark
    stamped on a phase-tinted disc (plain disc when no preset applies). */
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
