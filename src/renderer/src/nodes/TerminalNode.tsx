import { NodeProps, NodeResizer, useStore } from '@xyflow/react'
import { NodeHandles } from './NodeHandles'
import { CardPick } from './CardPick'
import { CardClose } from './CardClose'
import { AgentAvatar, StatusCoin } from './AgentAvatar'
import { GitChip } from '../GitChip'
import { CrIcon } from '../icons'
import { cardTypeScale, cardZoomMode } from './card-zoom'
import { TurnView } from './TurnView'
import { turnViewOf, checkpointViewModel, isEmptyTurnView } from '../turn-view-model'
import { useLatestCheckpoint } from '../use-latest-checkpoint'
import { PastTurnView, TurnPagerBar, useTurnPaging } from './TurnPager'
import type { TerminalNodeData } from '../../../shared/model'
import type { TerminalActivity } from '../../../shared/turn'
import { useCanvasUi } from '../canvas-ui'
import { useActivity } from '../activity-thumb-store'

/**
 * Summary card for a terminal. No xterm and no PTY attach here — the live
 * terminal mounts as a LOD overlay once the card covers the stage
 * (TerminalOverlay.tsx); clicking a card zooms the viewport to it.
 *
 * Agent cards follow vibe-island's session-card scheme: pixel avatar, bold
 * title + chips, "You:" line and the latest status/reply. One rendering
 * serves every zoom above the mini tile — typography is inverse-scaled
 * against the canvas zoom (card-zoom.ts) so the card reads the same at 30%
 * as at 100%, it just gets bigger.
 */
export function TerminalNode({ data, selected }: NodeProps): React.JSX.Element {
  const node = (data as { node: TerminalNodeData }).node
  const { tool, clipping, zoomToNode, picked, togglePick } = useCanvasUi()
  // Quantized subscriptions: these only change when crossing a bucket, so
  // zoom animation frames don't re-render every card.
  const mode = useStore((s) => cardZoomMode(s.transform[2]))
  const invZoom = useStore((s) => cardTypeScale(s.transform[2]))
  // Per-id subscription: this card re-renders only when ITS activity changes,
  // not on every other terminal's stream (the canvas-wide re-render fix).
  const activity = useActivity(node.id)
  const agent = activity?.agent ?? node.preset !== 'Shell'
  const phase = activity?.phase ?? 'idle'
  const paging = useTurnPaging(node.id, activity?.turnCount ?? 0, { forkable: true })

  // Trace-perf T1: when the live tracker has nothing to show (no PTY, never
  // zoomed), the card renders its LATEST checkpoint from a tail read instead of
  // "Ready" — no mirror. The rich live view wins the moment activity flows.
  const liveModel = turnViewOf(activity)
  const liveEmpty = isEmptyTurnView(liveModel)
  const wantCheckpoint = agent && mode !== 'mini' && liveEmpty && !paging.viewing
  const checkpoint = useLatestCheckpoint(node.id, wantCheckpoint)
  const checkpointModel = wantCheckpoint ? checkpointViewModel(checkpoint) : null

  // The picked highlight belongs to the clipboard toggle — a pick survives
  // the toggle being off (the board keeps it too) but never SHOWS then.
  const pickedOn = clipping && picked.has(node.id)

  const open = (): void => {
    // Clipping: the whole card is a bigger checkbox — no zoom. Working
    // blocks ADDING only; a picked card can always be unpicked (CardPick).
    if (clipping) {
      if (picked.has(node.id) || activity?.phase !== 'thinking') togglePick(node.id)
      return
    }
    if (tool === 'move') zoomToNode(node.id)
  }

  // Below visual range: a minimal tile — status-tinted card, dot + name.
  // No avatar, no text body, no animations.
  if (mode === 'mini') {
    return (
      <div
        className={`node vi-card mini${node.orch ? ' orch' : ''}${selected ? ' selected' : ''}${pickedOn ? ' picked' : ''}${phase === 'thinking' ? ' working' : ''}${phase === 'waiting' ? ' attention' : ''}`}
        style={{ ['--z' as string]: String(invZoom) }}
        onClick={open}
      >
        <NodeHandles />
        <CardPick id={node.id} />
        <div className="vi-mini node-header">
          <StatusCoin phase={phase} preset={node.preset} />
          <span className="vi-mini-name">{node.name}</span>
        </div>
      </div>
    )
  }

  if (!agent) {
    return (
      <div className={`node terminal-card${node.orch ? ' orch' : ''}${selected ? ' selected' : ''}${pickedOn ? ' picked' : ''}`}>
        <NodeResizer isVisible={selected} minWidth={240} minHeight={160} />
        <NodeHandles />
        <CardPick id={node.id} />
        <div className="node-header">
          <span className="cr-led on" />
          <span className="node-title">{node.name}</span>
          {node.orch && <span className="cr-chip amber">ORCH</span>}
          <span className="cr-chip preset-chip">{node.preset}</span>
          <CardClose nodeId={node.id} />
        </div>
        <div className="card-body nodrag nowheel" onClick={open}>
          <ShellTail activity={activity} />
        </div>
        <div className="card-foot">
          <span className="card-status idle">SHELL</span>
          <span className="card-open-hint">
            CLICK TO ZOOM <CrIcon name="expand" />
          </span>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`node vi-card${node.orch ? ' orch' : ''}${selected ? ' selected' : ''}${pickedOn ? ' picked' : ''}${phase === 'thinking' ? ' working' : ''}${phase === 'waiting' ? ' attention' : ''}`}
      style={{ ['--z' as string]: String(invZoom) }}
    >
      <NodeResizer isVisible={selected} minWidth={240} minHeight={140} />
      <NodeHandles />
      <CardPick id={node.id} />
      {/* Header always names the agent (vibe-island session-card scheme).
          The coin avatar IS the status indicator — no second status coin. */}
      <div className="node-header vi-head">
        <AgentAvatar phase={phase} preset={node.preset} />
        <div className="vi-title" title={node.name}>
          {node.name}
        </div>
        <span className="vi-chip tan">{node.preset}</span>
        {node.orch && <span className="vi-chip">Orch</span>}
        {node.forkOf && (
          <span
            className="vi-chip fork"
            title={`Forked from "${node.forkOf.sourceName}" at turn ${node.forkOf.turnIndex}`}
          >
            <CrIcon name="fork" /> T{node.forkOf.turnIndex}
          </span>
        )}
        {/* A git chip on a card about somebody ELSE's process would show the
            caller's own directory — a lie. The cwd of an imported card is at
            the author's app; nothing here is on a branch. */}
        {!node.servedSession && <GitChip dir={node.cwd} />}
        {phase === 'idle' && activity && (
          <span className="vi-chip dim">{agoLabel(activity.updatedAt)}</span>
        )}
        <CardClose nodeId={node.id} dark />
      </div>
      <div className="card-body vi-card-body nodrag nowheel" onClick={open}>
        {paging.viewing ? (
          <PastTurnView record={paging.viewing} />
        ) : (
          <TurnView model={checkpointModel ?? liveModel} />
        )}
      </div>
      {(paging.count > 0 || paging.viewing !== null) && <TurnPagerBar paging={paging} />}
    </div>
  )
}

function agoLabel(since: number): string {
  const mins = Math.max(0, Math.floor((Date.now() - since) / 60000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/** Viewport tail for plain shell cards. */
function ShellTail({ activity }: { activity: TerminalActivity | undefined }): React.JSX.Element {
  const lines = activity?.lines ?? []
  return (
    <div className="cr-phos cr-crt card-screen">
      {lines.length === 0 ? (
        <span className="phos-dim">NO OUTPUT YET</span>
      ) : (
        lines.map((line, i) => (
          <div key={i} className="phos-line">
            {line || ' '}
          </div>
        ))
      )}
      <span className="phos-cursor">▮</span>
    </div>
  )
}
