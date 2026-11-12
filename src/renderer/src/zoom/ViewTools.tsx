import { cookrew } from '../api'
import { CrIcon } from '../icons'
import { openSourcePicker } from '../use/source-picker-store'
import { CREW_COLS } from './zoom-layout'

/**
 * THE VIEW'S TOOLBAR (owner 2026-11-12: "remote desktop takes too much room:
 * one icon in the top right, one toolbar with per row, the same as the
 * artifacts toolbar in an agent's full view, and in every view of a
 * workspace"). One small bar in the top right corner, made of the full view's
 * own buttons (full-views.css · .zv-fv-arts-btn): how many to a row where a
 * row is seen (the crew's agents, the device's workspaces), and this
 * machine's screen to reach from elsewhere. The full view's tools row carries
 * the same remote desktop button (StageView.tsx).
 */

/** Can this surface offer its screen at all: the desktop app, with its screen picker. */
export const canShareScreen = (): boolean => typeof cookrew().useSources === 'function'

/** This machine's screen, to reach from another device: the picker that opens it (use/SourceSheet.tsx). */
export function RemoteDeskButton(): React.JSX.Element | null {
  if (!canShareScreen()) return null
  return (
    <button
      type="button"
      className="zv-fv-arts-btn zv-tool-desk"
      title="Remote desktop: reach this machine’s screen from another device"
      aria-label="Remote desktop"
      onClick={() => openSourcePicker({ remoteDesktop: true })}
    >
      <CrIcon name="remote-desktop" />
    </button>
  )
}

export interface PerRow {
  readonly what: 'agents' | 'workspaces'
  readonly narrow: boolean
  readonly cols: number
  readonly onPick: (n: number) => void
}

const GRID = (
  <svg className="zv-cols-glyph" viewBox="0 0 12 12" aria-hidden="true">
    <rect x="1" y="1" width="4" height="4" rx="1" />
    <rect x="7" y="1" width="4" height="4" rx="1" />
    <rect x="1" y="7" width="4" height="4" rx="1" />
    <rect x="7" y="7" width="4" height="4" rx="1" />
  </svg>
)

/** The bar itself; nothing at all when it would hold nothing. */
export function ViewTools({ perRow = null }: { perRow?: PerRow | null }): React.JSX.Element | null {
  const desk = canShareScreen()
  if (!perRow && !desk) return null
  return (
    <div className="zv-view-tools" role="toolbar" aria-label="View tools">
      {perRow && (
        <span className="zv-view-cols" role="group" aria-label={`${perRow.what === 'agents' ? 'Agents' : 'Workspaces'} per row`} title="Per row">
          {GRID}
          {(perRow.narrow ? CREW_COLS.narrow : CREW_COLS.wide).map((n) => (
            <button key={n} type="button" className="zv-fv-arts-btn" aria-pressed={perRow.cols === n} onClick={() => perRow.onPick(n)} aria-label={`${n} ${perRow.what} per row`}>
              {n}
            </button>
          ))}
        </span>
      )}
      {perRow && desk && <i className="zv-view-sep" aria-hidden="true" />}
      <RemoteDeskButton />
    </div>
  )
}
