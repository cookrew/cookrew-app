import { NodeProps, NodeResizer, useStore } from '@xyflow/react'
import { NodeHandles } from './NodeHandles'
import { CardClose } from './CardClose'
import { CardPick } from './CardPick'
import { OpenExternal } from './OpenExternal'
import { CrIcon } from '../icons'
import type { BrowserNodeData } from '../../../shared/model'
import { browserTabs } from '../../../shared/model'
import { useCanvasUi } from '../canvas-ui'
import { useThumb } from '../activity-thumb-store'
import { cardTypeScale, cardZoomMode } from './card-zoom'

/**
 * Summary card for a browser, with a legacy thumbnail when one is available.
 * BrowserLayer owns the live popout: a webview with the flag off, or the one
 * node-owned headless stream with the flag on.
 */
export function BrowserNode({ data, selected }: NodeProps): React.JSX.Element {
  const node = (data as { node: BrowserNodeData }).node
  const { tool, clipping, interactiveBrowser, zoomToNode, picked, togglePick } = useCanvasUi()
  // Per-id subscription: this card re-renders on its OWN thumbnail, not on
  // every other browser's. Either owner supplies the picture — the legacy
  // webview capture with the flag off, a still from the headless page with it
  // on (App polls it). Still nothing while ownership is UNRESOLVED: whatever is
  // stored then is a leftover from the other owner, and a stale frame is worse
  // than none.
  const storedThumb = useThumb(node.id)
  // Quantized zoom bucket (only flips crossing MINI_ZOOM, so it doesn't churn).
  const mode = useStore((s) => cardZoomMode(s.transform[2]))
  // Same counter-scale the terminal tile uses. A browser card keeps its full
  // chrome at every zoom — only the thumbnail drops at mini — so its title is
  // the only thing identifying it out there, and a flat 10px against a 0.2
  // canvas is two physical pixels of nothing.
  const invZoom = useStore((s) => cardTypeScale(s.transform[2]))
  // A zoomed-OUT (mini) tile does not decode its thumbnail. This is the mobile
  // OOM fix: at fit-to-view a phone shows every browser at once, and 41 decoded
  // image bitmaps held simultaneously crashes iOS Safari's WebContent. Off at
  // mini, the browser releases those bitmaps; the picture returns the moment the
  // card is big enough to read it. The glyph placeholder stands in meanwhile.
  const thumb = interactiveBrowser === null || mode === 'mini' ? undefined : storedThumb

  const open = (): void => {
    // Clipping: the whole card is a bigger checkbox — no zoom.
    if (clipping) {
      togglePick(node.id)
      return
    }
    if (tool === 'move') zoomToNode(node.id)
  }

  // Zoomed OUT: a tile, not a shrunken card. The browser used to render its
  // whole chrome at the overview — header, url chip, resizer and a body whose
  // thumbnail is deliberately dropped at this size — so it occupied a card's
  // worth of canvas to show an empty rectangle. The centred, wrapped name says
  // the only thing that is legible out here anyway: which page this is.
  if (mode === 'mini') {
    return (
      <div
        className={`node browser-node mini${selected ? ' selected' : ''}${clipping && picked.has(node.id) ? ' picked' : ''}`}
        style={{ ['--z' as string]: String(invZoom) }}
        onClick={open}
      >
        <NodeHandles />
        <CardPick id={node.id} />
        <div className="node-mini">
          <span className="node-title">{node.name}</span>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`node browser-node${selected ? ' selected' : ''}${clipping && picked.has(node.id) ? ' picked' : ''}`}
      style={{ ['--z' as string]: String(invZoom) }}
    >
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
