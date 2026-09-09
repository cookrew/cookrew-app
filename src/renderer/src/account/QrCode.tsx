/**
 * A QR, as one SVG.
 *
 * The matrix is drawn in main (qr-matrix.ts) because the only QR encoder in
 * this tree is a Node dependency; this is the picture half — one path with a
 * square per dark module, so it scales to any size without a canvas, a
 * bitmap, or a second copy of the data.
 *
 * BLACK ON WHITE, in both themes. Everything else in the app follows the
 * theme; a QR follows the camera, and a cream-on-ink QR at 3 a.m. is a QR
 * that does not scan. The four-module quiet zone is part of the symbol, not
 * padding — a scanner needs it as much as it needs the finder patterns.
 */

const QUIET = 4

export function QrCode({
  rows,
  label,
}: {
  /** Rows of '0' and '1', as main encoded them. */
  rows: readonly string[]
  label: string
}): React.JSX.Element | null {
  if (rows.length === 0) return null
  const span = rows.length + QUIET * 2
  const path = rows
    .map((row, y) =>
      [...row]
        .map((module, x) => (module === '1' ? `M${x + QUIET} ${y + QUIET}h1v1h-1z` : ''))
        .join(''),
    )
    .join('')
  return (
    <svg
      className="cr-acct-qr"
      viewBox={`0 0 ${span} ${span}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect x="0" y="0" width={span} height={span} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  )
}
