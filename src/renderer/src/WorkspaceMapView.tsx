import type { WorkspaceMap } from '../../shared/workspace-map'

/**
 * THE CANVAS AS A SHAPE — what a screen on the wall shows when there is no
 * photograph of it.
 *
 * The wall's screens carry JPEGs captured by Electron, and the phone can
 * produce none: it has no window to photograph, and it may not fire a capture
 * on the Mac, which might be showing something else entirely. So the screen
 * for the workspace the reader was standing in said NO SNAPSHOT YET — the one
 * screen where that sentence is least true, because that canvas is live and
 * its state is right here.
 *
 * A photograph of a canvas at overview zoom is a field of rectangles. This is
 * that field, drawn from the state instead of from the compositor, so the two
 * read as the same picture. No labels: the name is on the screen's own label
 * below, and a thumbnail nobody can read is also one nobody can read over a
 * shoulder.
 *
 * Keyed by index on purpose — a cell has no identity to key by (the map
 * carries no ids, deliberately), and the whole drawing is replaced whenever
 * the canvas changes.
 */
export function WorkspaceMapView({ map }: { map: WorkspaceMap }): React.JSX.Element | null {
  if (map.cells.length === 0) return null
  return (
    <svg
      className="cr-wsw-map"
      viewBox={`0 0 ${map.width} ${map.height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {map.cells.map((cell, at) => (
        <rect
          key={at}
          x={cell.x}
          y={cell.y}
          width={cell.w}
          height={cell.h}
          data-kind={cell.kind}
        />
      ))}
    </svg>
  )
}
