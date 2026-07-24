import { NodeProps, NodeResizer } from '@xyflow/react'
import { NodeHandles } from './NodeHandles'
import { CardClose } from './CardClose'
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
  const { tool, thumbs, interactiveBrowser, zoomToNode } = useCanvasUi()
  // Headless ownership never surfaces a legacy webview capture, including
  // while capability is unresolved. The live stream appears in the popout.
  const thumb = interactiveBrowser === false ? thumbs[node.id] : undefined

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
