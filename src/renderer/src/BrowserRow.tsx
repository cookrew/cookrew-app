import { CrIcon } from './icons'
import type { BrowserNodeData } from '../../shared/model'
import { activeBrowserTab, browserTabs } from '../../shared/model'

/**
 * One browser on the board. DATA CONTRACT: binds the same sources its
 * canvas card (BrowserNode) renders — the shared `thumbs` snapshot for the
 * picture and `activeBrowserTab(node)` for the url/tab facts — so the board
 * shows the page the canvas shows, not a re-derived guess. The body IS the
 * thumbnail; no snapshot yet → the browser glyph stands in.
 */
export function BrowserRow({
  node,
  thumb,
  workspaceName,
  selected,
  selectable = false,
  onOpen
}: {
  node: BrowserNodeData
  /** Latest snapshot data URL from canvas-ui `thumbs`, if one exists. */
  thumb: string | undefined
  workspaceName: string
  selected: boolean
  /** Edit mode: the row ticks instead of handing off to the canvas. */
  selectable?: boolean
  onOpen: (id: string) => void
}): React.JSX.Element {
  const tab = activeBrowserTab(node)
  const tabCount = browserTabs(node).length
  return (
    <div
      className={`ags-row ags-element${selected ? ' selected' : ''}${selectable ? ' selectable' : ''}`}
      aria-pressed={selectable ? selected : undefined}
      role="button"
      tabIndex={0}
      title={node.name}
      onClick={() => onOpen(node.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(node.id)
        }
      }}
    >
      {selectable && (
        <span className={`ags-tick${selected ? ' on' : ''}`} aria-hidden="true">
          {selected ? '✓' : ''}
        </span>
      )}
      <span className="ags-avatar ags-el-tile browser">
        <CrIcon name="browser" />
      </span>
      <span className="ags-body">
        <span className="ags-nameline">
          <span className="ags-name">{node.name}</span>
          <span className="cr-chip">BROWSER</span>
          {tabCount > 1 && <span className="cr-chip">{tabCount} TABS</span>}
          <span className="cr-chip violet">{workspaceName}</span>
        </span>
        <span className="ags-browser-preview">
          {thumb ? (
            <img className="ags-browser-thumb" src={thumb} alt={node.name} draggable={false} />
          ) : (
            <span className="ags-browser-thumb empty">
              <CrIcon name="browser" />
            </span>
          )}
          <span className="ags-el-url" title={tab.url}>
            {tab.title || tab.url}
            {tab.title && <span className="ags-el-url-dim"> — {tab.url}</span>}
          </span>
        </span>
      </span>
    </div>
  )
}
