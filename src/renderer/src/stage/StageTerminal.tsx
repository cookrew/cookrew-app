// The stage's background when it is an agent: its terminal, full size — the
// same TerminalOverlayLayer → TerminalOverlay the canvas zooms into, with its
// side tabs, its lower half and its own head. Only the loaded workspace's
// agents open here; another workspace's agent opens after switching to it.
//
// Its box is a containing block (stage.css), so the overlay's fixed position
// counts from the box and the rect is simply the box.
import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { attachView, useAttachView } from '../attach-view'
import { CanvasUiContext, useCanvasUi, type CanvasUi } from '../canvas-ui'
import type { LodLayout } from '../zoom-lod'
import type { TerminalNodeData } from '../../../shared/model'
import type { StageItem } from './stage-pick'

const TerminalOverlayLayer = lazy(() => import('../TerminalOverlay').then((m) => ({ default: m.TerminalOverlayLayer })))

const noop = (): void => undefined

export function StageTerminal({
  local,
  item,
  onBack
}: {
  /** The card on the loaded workspace; null when it is not there. */
  local: TerminalNodeData | null
  /** Open in the lower half once, when the stage shows this agent for it. */
  item: StageItem | null
  /** The terminal's own Back: the stage goes back to following what needs you. */
  onBack: () => void
}): React.JSX.Element {
  const canvas = useCanvasUi()
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = (): void => setSize((now) => (now && now.w === el.clientWidth && now.h === el.clientHeight ? now : { w: el.clientWidth, h: el.clientHeight }))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const node = local
  // The card closes for real, with the canvas's own confirm.
  const ui = useMemo<CanvasUi>(
    () => ({
      ...canvas,
      tool: 'move',
      clipping: false,
      zoomToNode: noop,
      jumpToNode: async () => 'missed',
      zoomBack: onBack
    }),
    [canvas, onBack]
  )
  const lod = useMemo<LodLayout | null>(
    () =>
      node && size ? { activeIds: new Set([node.id]), rects: { [node.id]: { x: 0, y: 0, width: size.w, height: size.h } }, primaryId: node.id } : null,
    [node, size]
  )
  const terminals = useMemo(() => (node ? [node] : []), [node])

  // The item opens once per showing; closing it afterwards is the reader's call.
  const open = useAttachView()
  const opened = useRef<string | null>(null)
  useEffect(() => {
    if (item === null || node === null) return
    const key = `${node.id}/${item.id}`
    if (opened.current === key) return
    opened.current = key
    if (open?.terminalId !== node.id || open.itemId !== item.id) attachView.toggle(node.id, item.id, item.kind)
  }, [item, node, open])

  return (
    <div className="cr-stage-term" ref={box}>
      {lod ? (
        <CanvasUiContext.Provider value={ui}>
          <Suspense fallback={null}>
            <TerminalOverlayLayer terminals={terminals} lod={lod} />
          </Suspense>
        </CanvasUiContext.Provider>
      ) : (
        <div className="cr-stage-wait" aria-busy={node !== null}>
          {node === null ? 'That agent is not in this workspace. Switch to its workspace to open it.' : 'OPENING…'}
        </div>
      )}
    </div>
  )
}
