/**
 * THE "PER ROW" PILL (zoom.css · .zv-cols): how many to a row, at the stop
 * where the row is seen — the crew's agents, the device's workspaces
 * (owner, 2026-11-01). The pick itself is crew-cols.ts's.
 */
import { CREW_COLS } from './zoom-layout'

export function PerRowPill({ what, narrow, cols, onPick }: { what: 'agents' | 'workspaces'; narrow: boolean; cols: number; onPick: (n: number) => void }) {
  return (
    <div className="zv-cols" role="group" aria-label={`${what === 'agents' ? 'Agents' : 'Workspaces'} per row`}>
      <span aria-hidden="true">per row</span>
      <svg className="zv-cols-glyph" viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="1" width="4" height="4" rx="1" /><rect x="7" y="1" width="4" height="4" rx="1" /><rect x="1" y="7" width="4" height="4" rx="1" /><rect x="7" y="7" width="4" height="4" rx="1" /></svg>
      {(narrow ? CREW_COLS.narrow : CREW_COLS.wide).map((n) => (
        <button key={n} type="button" aria-pressed={cols === n} onClick={() => onPick(n)} aria-label={`${n} ${what} per row`}>
          {n}
        </button>
      ))}
    </div>
  )
}
