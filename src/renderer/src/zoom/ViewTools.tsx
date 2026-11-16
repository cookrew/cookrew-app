import { cookrew } from '../api'
import { CrIcon } from '../icons'
import { openSourcePicker } from '../use/source-picker-store'
import { perRowChoices } from './crew-cols'
import type { DeviceView } from './zoom-layout'

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

/** A workspace tile's type (zoom-layout.ts · TILE_SIZES): the picks, the one in use, and its setter. */
export interface TileSizePick {
  readonly sizes: readonly number[]
  readonly size: number
  readonly onPick: (size: number) => void
}

/** The workspaces stop's two views (zoom-layout.ts · DeviceView): the one shown and its setter. */
export interface DeviceViewPick {
  readonly view: DeviceView
  readonly onPick: (view: DeviceView) => void
}

const FEED = (
  <svg className="zv-cols-glyph" viewBox="0 0 12 12" aria-hidden="true">
    <rect x="3" y="0.5" width="6" height="11" rx="1.2" />
  </svg>
)

const WALL = (
  <svg className="zv-cols-glyph" viewBox="0 0 12 12" aria-hidden="true">
    <rect x="1" y="1" width="4" height="6" rx="1" />
    <rect x="7" y="1" width="4" height="4" rx="1" />
    <rect x="1" y="8" width="4" height="3" rx="1" />
    <rect x="7" y="6" width="4" height="5" rx="1" />
  </svg>
)

const VIEW_BUTTONS: ReadonlyArray<{ view: DeviceView; glyph: React.JSX.Element; label: string }> = [
  { view: 'feed', glyph: FEED, label: 'Feed: one workspace a page' },
  { view: 'grid', glyph: WALL, label: 'Grid: two workspaces a row' }
]

const GRID = (
  <svg className="zv-cols-glyph" viewBox="0 0 12 12" aria-hidden="true">
    <rect x="1" y="1" width="4" height="4" rx="1" />
    <rect x="7" y="1" width="4" height="4" rx="1" />
    <rect x="1" y="7" width="4" height="4" rx="1" />
    <rect x="7" y="7" width="4" height="4" rx="1" />
  </svg>
)

/** The bar itself; nothing at all when it would hold nothing. */
export function ViewTools({ perRow = null, tileSize = null, deviceView = null }: { perRow?: PerRow | null; tileSize?: TileSizePick | null; deviceView?: DeviceViewPick | null }): React.JSX.Element | null {
  const desk = canShareScreen()
  if (!perRow && !tileSize && !deviceView && !desk) return null
  return (
    <div className="zv-view-tools" role="toolbar" aria-label="View tools">
      {deviceView && (
        <span className="zv-view-cols zv-view-mode" role="group" aria-label="Workspaces view">
          {VIEW_BUTTONS.map((one) => (
            <button key={one.view} type="button" className="zv-fv-arts-btn" aria-pressed={deviceView.view === one.view} onClick={() => deviceView.onPick(one.view)} aria-label={one.label} title={one.label}>
              {one.glyph}
            </button>
          ))}
        </span>
      )}
      {deviceView && (perRow || tileSize) && <i className="zv-view-sep" aria-hidden="true" />}
      {perRow && (
        <span className="zv-view-cols" role="group" aria-label={`${perRow.what === 'agents' ? 'Agents' : 'Workspaces'} per row`} title="Per row">
          {GRID}
          {perRowChoices(perRow.what === 'agents' ? 'crew' : 'device', perRow.narrow).map((n) => (
            <button key={n} type="button" className="zv-fv-arts-btn" aria-pressed={perRow.cols === n} onClick={() => perRow.onPick(n)} aria-label={`${n} ${perRow.what} per row`}>
              {n}
            </button>
          ))}
        </span>
      )}
      {perRow && tileSize && <i className="zv-view-sep" aria-hidden="true" />}
      {tileSize && (
        <span className="zv-view-cols zv-view-size" role="group" aria-label="Workspace text size" title="Text size">
          {tileSize.sizes.map((size, index) => (
            <button key={size} type="button" className="zv-fv-arts-btn" aria-pressed={tileSize.size === size} onClick={() => tileSize.onPick(size)} aria-label={`Text size ${Math.round(size * 100)}%`} style={{ fontSize: `${11 + index * 2.5}px` }}>
              A
            </button>
          ))}
        </span>
      )}
      {(perRow || tileSize || deviceView) && desk && <i className="zv-view-sep" aria-hidden="true" />}
      <RemoteDeskButton />
    </div>
  )
}
