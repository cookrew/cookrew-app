/**
 * Deterministic role avatars: a saved role's name hashes to a unique
 * mirror-symmetric pixel creature on the same 2.4px cell grid as the agent
 * coin marks (AgentAvatar), stamped on the same ink-rimmed disc — so roles
 * read as members of the arcade family. Same name → same creature, always.
 */

const STAMP = '#1c1408'
const CELL = 2.4
const COLS = 7
const ROWS = 7

/** FNV-1a — stable, cheap, good bit spread for short names. */
function hashName(name: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Deterministic bit stream from the hash (xorshift32). */
function bitStream(seed: number): () => boolean {
  let s = seed || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return (s & 1) === 1
  }
}

/**
 * 7×7 creature, left 4 columns from the hash, mirrored to the right.
 * Family traits keep every roll charming: eyes on row 1 (cols 1/5 with a
 * gap between), a guaranteed center-mass cell, and no fully empty rows.
 */
export function roleGrid(name: string): boolean[][] {
  const next = bitStream(hashName(name.trim().toLowerCase()))
  const half: boolean[][] = Array.from({ length: ROWS }, () =>
    Array.from({ length: 4 }, () => next())
  )
  const rows = half.map((cols) => {
    const mirrored = [...cols, cols[2], cols[1], cols[0]]
    return mirrored
  })
  const withTraits = rows.map((row, y) => {
    if (y === 1) return [row[0], true, false, false, false, true, row[6]]
    if (y === 3) return row.map((cell, x) => (x === 3 ? true : cell))
    return row
  })
  return withTraits.map((row) =>
    row.some(Boolean) ? row : row.map((_, x) => x === 3)
  )
}

function creatureCells(name: string): React.JSX.Element[] {
  const ox = 13 - (COLS * CELL) / 2
  const oy = 13 - (ROWS * CELL) / 2
  return roleGrid(name).flatMap((row, y) =>
    row.flatMap((on, x) =>
      on
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
  )
}

/**
 * Role coin: the creature stamped on the ink-rimmed disc, tinted via
 * currentColor (defaults to violet through .role-avatar CSS — the "role"
 * accent, distinct from the green/orange/red status tints).
 */
export function RoleAvatar({
  name,
  className
}: {
  name: string
  className?: string
}): React.JSX.Element {
  return (
    <svg
      className={className ? `role-avatar ${className}` : 'role-avatar'}
      viewBox="0 0 26 26"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="13" cy="13" r="11.5" fill="currentColor" stroke="var(--ink)" strokeWidth="2" />
      <circle cx="13" cy="13" r="8.9" fill="none" stroke={STAMP} strokeWidth="1.2" opacity="0.35" />
      {creatureCells(name)}
    </svg>
  )
}
