import { NodeProps, NodeResizer } from '@xyflow/react'
import { NodeHandles } from './NodeHandles'
import { CardClose } from './CardClose'
import { CardPick } from './CardPick'
import { OpenExternal } from './OpenExternal'
import { CrIcon } from '../icons'
import type { BrowserNodeData } from '../../../shared/model'
import { browserTabs } from '../../../shared/model'
import { useCanvasUi } from '../canvas-ui'

/**
 * Summary card for a browser, with a legacy thumbnail when one is available.
 * BrowserLayer owns the live popout: a webview with the flag off, or the one
 * node-owned headless stream with the flag on.
 */
export function BrowserNode({ data, selected }: NodeProps): React.JSX.Element {
  const node = (data as { node: BrowserNodeData }).node
  const { tool, clipping, thumbs, interactiveBrowser, zoomToNode, picked, togglePick } = useCanvasUi()
  // Either owner can supply the picture now — the legacy webview capture with
  // the flag off, a still from the headless page with it on (App polls it).
  // Still nothing while ownership is UNRESOLVED: whatever is in `thumbs` then
  // is a leftover from the other owner, and a stale frame is worse than none.
  const thumb = interactiveBrowser === null ? undefined : thumbs[node.id]

  const open = (): void => {
    // Clipping: the whole card is a bigger checkbox — no zoom.
    if (clipping) {
      togglePick(node.id)
      return
    }
    if (tool === 'move') zoomToNode(node.id)
  }

  return (
    <div className={`node browser-node${selected ? ' selected' : ''}${clipping && picked.has(node.id) ? ' picked' : ''}`}>
      <NodeResizer isVisible={selected} minWidth={220} minHeight={160} />
      <NodeHandles />
      <CardPick id={node.id} />
      <div className="node-header">
        <span className="node-dot" />
        <span className="node-title">{node.name}</span>
        {/* Before the url chip, NOT beside the ✕: a navigational control a
            thumb-width from "destroy this card" is a mis-tap trap on touch. */}
        <OpenExternal url={node.url} className="card-close card-external" />
        <span className="cr-chip preset-chip browser-url-chip" title={node.url}>
          {shortUrl(node.url)}
        </span>
        <CardClose nodeId={node.id} />
      </div>
      <div className="card-body nodrag nowheel" onClick={open}>
        {thumb ? (
          <img className="browser-thumb" src={thumb} alt={node.name} draggable={false} />
        ) : (
          <div className="browser-thumb-empty">
            <span className="browser-thumb-glyph">
              <CrIcon name="browser" />
            </span>
            <span className="cr-kicker">{shortUrl(node.url)}</span>
          </div>
        )}
      </div>
      <div className="card-foot">
        <span className="card-status idle">
          BROWSER{browserTabs(node).length > 1 ? ` · ${browserTabs(node).length} TABS` : ''}
        </span>
        <span className="card-open-hint">
          CLICK TO ZOOM <CrIcon name="expand" />
        </span>
      </div>
    </div>
  )
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.host + (u.pathname !== '/' ? u.pathname : '')
  } catch {
    return url
  }
}
