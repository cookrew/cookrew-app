import type { TurnPhase } from '../../../shared/turn'
import { HAND_PATH } from '../CrLogoMark'
import { spriteForPreset, type AgentSpriteKind } from './AgentSprite'

/**
 * Status avatar for agent cards: the Cookrew baby hand playing with the
 * agent's coin. The hand keeps its brand colors in every phase; only the
 * coin (agent mark stamped on a disc) carries the status color —
 *   idle     coin parked beside the resting hand, dim green
 *   thinking coin knuckle-rolled across the fingertips, flipping edge-on
 *   waiting  hand waves for attention, coin blinks red
 *   replied  coin held resting on the fingertips, green
 * Layout and motion live in CSS under .vi-avatar.<phase>.
 */

/** Compact 7-wide glyphs stamped on the coin face. */
const COIN_GLYPHS: Record<AgentSpriteKind, string[]> = {
  claude: ['...X...', '.X.X.X.', '..XXX..', 'XXX.XXX', '..XXX..', '.X.X.X.', '...X...'],
  codex: ['..XXX..', '.X...X.', 'X.....X', 'X..X..X', 'X.....X', '.X...X.', '..XXX..'],
  opencode: ['.......', 'X......', '.X.....', '..X....', '.X.....', 'X...XXX', '.......'],
  shell: ['.X...X.', '..X.X..', '.XXXXX.', 'XX.X.XX', 'XXXXXXX', '.X...X.']
}

/** Stamped near-black, readable on every phase tint. */
const STAMP = '#1c1408'
const CELL = 2.4

function coinFace(kind: AgentSpriteKind | null): React.JSX.Element {
  const grid = kind ? COIN_GLYPHS[kind] : []
  const ox = 13 - (7 * CELL) / 2
  const oy = 13 - (grid.length * CELL) / 2
  return (
    <g className="ava-coin-tint">
      <circle cx="13" cy="13" r="11.5" fill="currentColor" stroke="var(--ink)" strokeWidth="2" />
      <circle cx="13" cy="13" r="8.9" fill="none" stroke={STAMP} strokeWidth="1.2" opacity="0.35" />
      {grid.flatMap((row, y) =>
        [...row].flatMap((cell, x) =>
          cell === 'X'
            ? [
                <rect
                  key={`${x}-${y}`}
                  x={(ox + x * CELL).toFixed(2)}
                  y={(oy + y * CELL).toFixed(2)}
                  width={CELL}
                  height={CELL}
                  fill={STAMP}
                />
              ]
            : []
        )
      )}
    </g>
  )
}

function BrandHand(): React.JSX.Element {
  return (
    <g className="ava-hand">
      <svg x="1" y="10" width="22" height="22" viewBox="0 0 32 32">
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
      <svg viewBox="0 0 50 32" aria-hidden="true" focusable="false">
        <g className="ava-coin">
          <g className="ava-roll">
            <g className="ava-flip">{coinFace(spriteForPreset(preset))}</g>
          </g>
        </g>
        <BrandHand />
      </svg>
    </span>
  )
}

/** Mini status coin standing in for the old LED dots: agent mark stamped on
    a phase-tinted disc (plain disc when no preset applies). */
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
