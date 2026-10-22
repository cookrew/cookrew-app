// LEVEL 3 IN THE WINDOW: the agent's real terminal, the same
// TerminalOverlayLayer → TerminalOverlay the canvas zooms into, in the place
// the Strata level keeps for it (the embed root's pattern, without a frame).
//
// It is drawn INSIDE the level, so it flies in and out with it. Its box is a
// containing block (levels.css), so the overlay's fixed position counts from
// the box: the rect is simply the box. The overlay's Back and close are "out"
// one level; nothing here closes a card. No workspace switch either: the PTY
// attaches across workspaces (pty:attach finds the node in any of them).
import { Suspense, lazy, useMemo } from 'react'
import type { TerminalSlotProps } from '../../../strata/levels/env'
import { CanvasUiContext, useCanvasUi, type CanvasUi } from '../canvas-ui'
import { nodeOfDetail } from '../embed/embed-node'
import type { LodLayout } from '../zoom-lod'

const TerminalOverlayLayer = lazy(() => import('../TerminalOverlay').then((m) => ({ default: m.TerminalOverlayLayer })))

const noop = (): void => undefined

export function LevelsTerminal({ agent, detail, size, current, out }: TerminalSlotProps): React.JSX.Element {
  const canvas = useCanvasUi()
  const ui = useMemo<CanvasUi>(
    () => ({
      ...canvas,
      tool: 'move',
      clipping: false,
      zoomToNode: noop,
      jumpToNode: async () => 'missed',
      zoomBack: out,
      requestClose: out
    }),
    [canvas, out]
  )
  // The detail's own node, so the card opens as itself (preset, brief, served session).
  const node = useMemo(() => (detail ? nodeOfDetail(detail) : null), [detail])
  const lod = useMemo<LodLayout | null>(
    () =>
      node ? { activeIds: new Set([node.id]), rects: { [node.id]: { x: 0, y: 0, width: size.w, height: size.h } }, primaryId: node.id } : null,
    [node, size.w, size.h]
  )
  const terminals = useMemo(() => (node ? [node] : []), [node])

  // Only where the shell is: a flight's far end or a warm pre-mount attaches nothing.
  if (!current || !lod) {
    return (
      <div className="cr-levels-term cr-levels-term-wait" aria-busy="true">
        {current ? `OPENING ${agent.name.toUpperCase()}…` : null}
      </div>
    )
  }
  return (
    <CanvasUiContext.Provider value={ui}>
      <div className="cr-levels-term">
        <Suspense fallback={null}>
          <TerminalOverlayLayer terminals={terminals} lod={lod} />
        </Suspense>
      </div>
    </CanvasUiContext.Provider>
  )
}
