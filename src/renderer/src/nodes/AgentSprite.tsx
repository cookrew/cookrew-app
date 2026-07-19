/** Per-agent pixel sprites on the invader's 3px-cell grid (11×8 cells,
    33×24 px), drawn in currentColor so the card's phase class tints them:
    Claude Code a starburst, Codex a ring, OpenCode a terminal block, and
    Shell (or any custom preset) the classic invader. */

export type AgentSpriteKind = 'claude' | 'codex' | 'opencode' | 'shell'

const GRIDS: Record<AgentSpriteKind, string[]> = {
  claude: [
    '.....X.....',
    '.X...X...X.',
    '..X.XXX.X..',
    'XXXXX.XXXXX',
    '..X.XXX.X..',
    '.X...X...X.',
    '.....X.....'
  ],
  codex: [
    '....XXX....',
    '..XX...XX..',
    '.X.......X.',
    '.X...X...X.',
    '.X.......X.',
    '..XX...XX..',
    '....XXX....'
  ],
  opencode: [
    'XXXXXXXXXXX',
    'X.........X',
    'X.X.......X',
    'X..X......X',
    'X.X...XXX.X',
    'X.........X',
    'XXXXXXXXXXX'
  ],
  shell: [
    '..X.....X..',
    '...X...X...',
    '..XXXXXXX..',
    '.XX.XXX.XX.',
    'XXXXXXXXXXX',
    'X.XXXXXXX.X',
    'X.X.....X.X',
    '...XX.XX...'
  ]
}

export function spriteForPreset(preset: string): AgentSpriteKind {
  if (/claude/i.test(preset)) return 'claude'
  if (/codex/i.test(preset)) return 'codex'
  if (/opencode/i.test(preset)) return 'opencode'
  return 'shell'
}

const CELLS: Record<AgentSpriteKind, React.JSX.Element[]> = Object.fromEntries(
  (Object.entries(GRIDS) as [AgentSpriteKind, string[]][]).map(([kind, grid]) => [
    kind,
    grid.flatMap((row, y) =>
      [...row].flatMap((cell, x) =>
        cell === 'X'
          ? [<rect key={`${x}-${y}`} x={x * 3} y={y * 3} width="3" height="3" fill="currentColor" />]
          : []
      )
    )
  ])
) as Record<AgentSpriteKind, React.JSX.Element[]>

/** Identity mark for a terminal's agent; sized by the owning context via
    the .vi-sprite / .cr-chip classes, tinted via currentColor. */
export function AgentSprite({
  preset,
  className
}: {
  preset: string
  className?: string
}): React.JSX.Element {
  return (
    <svg
      className={className ? `vi-sprite ${className}` : 'vi-sprite'}
      viewBox="0 0 33 24"
      aria-hidden="true"
      focusable="false"
    >
      {CELLS[spriteForPreset(preset)]}
    </svg>
  )
}
