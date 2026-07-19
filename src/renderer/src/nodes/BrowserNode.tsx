import { NodeProps, NodeResizer } from '@xyflow/react'
import { NodeHandles } from './NodeHandles'
import { CardClose } from './CardClose'
import type { BrowserNodeData } from '../../../shared/model'
import { browserTabs } from '../../../shared/model'
import { useCanvasUi } from '../canvas-ui'

/**
 * Summary card for a browser: a periodically refreshed thumbnail of the page.
 * The live <webview> lives in BrowserLayer (offscreen) and is only shown by
 * the fullscreen browser popout after a click.
 */
export function BrowserNode({ data, selected }: NodeProps): React.JSX.Element {
  const node = (data as { node: BrowserNodeData }).node
  const { tool, thumbs, zoomToNode } = useCanvasUi()
  const thumb = thumbs[node.id]

  const open = (): void => {
    if (tool === 'select') zoomToNode(node.id)
  }

  return (
    <div className={`node browser-node${selected ? ' selected' : ''}`}>
      <NodeResizer isVisible={selected} minWidth={220} minHeight={160} />
      <NodeHandles />
      <div className="node-header">
        <span className="node-dot" />
        <span className="node-title">{node.name}</span>
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
            <span className="browser-thumb-glyph">◍</span>
            <span className="cr-kicker">{shortUrl(node.url)}</span>
          </div>
        )}
      </div>
      <div className="card-foot">
        <span className="card-status idle">
          BROWSER{browserTabs(node).length > 1 ? ` · ${browserTabs(node).length} TABS` : ''}
        </span>
        <span className="card-open-hint">CLICK TO ZOOM ⤢</span>
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
