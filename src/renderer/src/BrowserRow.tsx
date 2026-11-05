import { CrIcon } from './icons'
import type { BrowserNodeData } from '../../shared/model'
import { activeBrowserTab, browserTabs } from '../../shared/model'
import type { ItemSnippet } from './item-search'
import { MatchLine } from './MatchLine'
import { markParts, siteLines, termsOf, type Part } from './site-lines'

const markName = (name: string, query: string): Part[] => markParts(name, termsOf(query))

/** A run of text with the searched words marked. */
function Marked({ parts }: { parts: Part[] }): React.JSX.Element {
  return (
    <>
      {parts.map((p, i) => (p.mark ? <mark key={i} className="ags-mark">{p.text}</mark> : p.text))}
    </>
  )
}

/**
 * An address with a break offered after each `/`, `?` and `&`, so a long one
 * wraps between its segments instead of at whatever letter hits the edge,
 * and never inside a marked word (`.ags-site-url mark` does not wrap).
 */
function MarkedUrl({ parts }: { parts: Part[] }): React.JSX.Element {
  return (
    <>
      {parts.map((p, i) =>
        p.mark ? (
          <mark key={i} className="ags-mark">{p.text}</mark>
        ) : (
          p.text.split(/(?<=[/?&])/).map((seg, j) => (
            <span key={`${i}.${j}`}>
              {seg}
              {/[/?&]$/.test(seg) && <wbr />}
            </span>
          ))
        )
      )}
    </>
  )
}

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
  match = null,
  query = null,
  onOpen
}: {
  node: BrowserNodeData
  /** Latest snapshot data URL from canvas-ui `thumbs`, if one exists. */
  thumb: string | undefined
  workspaceName: string
  selected: boolean
  /** Edit mode: the row ticks instead of handing off to the canvas. */
  selectable?: boolean
  /** A search hit in a tab that is not the one showing: that tab's line. */
  match?: ItemSnippet | null
  /**
   * The board's search, while one is up: the row lists the card's sites, each
   * with its title and its whole address, the searched words marked.
   */
  query?: string | null
  onOpen: (id: string) => void
}): React.JSX.Element {
  const tab = activeBrowserTab(node)
  const tabCount = browserTabs(node).length
  const sites = query ? siteLines(node, query) : null
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
          <span className="ags-name">{query ? <Marked parts={markName(node.name, query)} /> : node.name}</span>
          <span className="cr-chip">BROWSER</span>
          {tabCount > 1 && <span className="cr-chip">{tabCount} TABS</span>}
          <span className="cr-chip violet">{workspaceName}</span>
        </span>
        <span className={`ags-browser-preview${sites ? ' searching' : ''}`}>
          {thumb ? (
            <img className="ags-browser-thumb" src={thumb} alt={node.name} draggable={false} />
          ) : (
            <span className="ags-browser-thumb empty">
              <CrIcon name="browser" />
            </span>
          )}
          {sites ? (
            <span className="ags-sites">
              {sites.lines.map((line) => (
                <span key={line.id} className={`ags-site${line.active ? ' active' : ''}${line.hit ? ' hit' : ''}`}>
                  {line.title.length > 0 && (
                    <span className="ags-site-title">
                      <Marked parts={line.title} />
                    </span>
                  )}
                  <span className="ags-site-url">
                    <MarkedUrl parts={line.url} />
                  </span>
                </span>
              ))}
              {sites.hidden > 0 && (
                <span className="ags-site-more">
                  + {sites.hidden} more {sites.hidden === 1 ? 'site' : 'sites'}
                </span>
              )}
            </span>
          ) : (
            <span className="ags-el-url" title={tab.url}>
              {tab.title || tab.url}
              {tab.title && <span className="ags-el-url-dim"> — {tab.url}</span>}
            </span>
          )}
        </span>
        {/* Searching, the sites already say why the card matched. */}
        {match && !sites && <MatchLine match={match} />}
      </span>
    </div>
  )
}
