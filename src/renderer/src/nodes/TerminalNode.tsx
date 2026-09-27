import { NodeProps, NodeResizer, useStore } from '@xyflow/react'
import { NodeHandles } from './NodeHandles'
import { CardPick } from './CardPick'
import { CardClose } from './CardClose'
import { AgentAvatar, StatusCoin } from './AgentAvatar'
import { CardCallerAvatars } from './CallerAvatars'
import { GitChip } from '../GitChip'
import { CrIcon } from '../icons'
import { cardTypeScale, cardZoomMode } from './card-zoom'
import { TurnView } from './TurnView'
import { turnViewOf, checkpointViewModel, isEmptyTurnView } from '../turn-view-model'
import { useStreamTail } from '../stream/use-stream-tails'
import { PastTurnView, TurnPagerBar, useTurnPaging } from './TurnPager'
import type { TerminalNodeData } from '../../../shared/model'
import { DialTag } from './DialTag'
import type { TerminalActivity } from '../../../shared/turn'
import { useCanvasUi } from '../canvas-ui'
import { useActivity, useActivitySeeded } from '../activity-thumb-store'

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
  // How many agents sit in THIS directory. Two is the situation lanes exist
  // for, and the card is where it should show — not a panel somebody opens.
  const sharers = useStore((s) => {
    let count = 0
    for (const n of s.nodes) if ((n.data as { cwd?: string }).cwd === node.cwd && (n.data as { kind?: string }).kind === 'terminal') count += 1
    return count
  })
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
  // A MIRRORLESS activity is a phase and nothing else, so it counts as empty
  // however loudly it says "Working…": otherwise a cold canvas would trade
  // its cards' last ask-and-reply for a single verb, which is a worse card
  // than the one this path exists to fix.
  const liveEmpty = isEmptyTurnView(liveModel) || activity?.mirrorless === true
  // Not before the activity snapshot has landed: a card that reads its tail
  // while "idle" is still a guess pays an exchange it will discard (L7).
  const seeded = useActivitySeeded()
  const wantCheckpoint = agent && seeded && mode !== 'mini' && liveEmpty && !paging.viewing
  const checkpoint = useStreamTail(node.id, wantCheckpoint)
  const checkpointBody = wantCheckpoint ? checkpointViewModel(checkpoint) : null
  // Both, when both are known: the checkpoint's words with the live verb over
  // them, so a working agent reads WORKING and still shows what it last did.
  const checkpointModel =
    checkpointBody && activity?.mirrorless === true && liveModel.latest
      ? { ...checkpointBody, latest: liveModel.latest }
      : checkpointBody

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
          {/* THE TILE IS THE CARD, most of the time.
              This view was left out of the first cut on the reasoning that it
              names no harness, so a tag had nothing to sit beside. True, and
              beside the point: the board sits at overview zoom, where EVERY
              card is a tile — so "on every card view" was invisible in the one
              view that is usually on screen. Name and dials stack in the space
              the name was already using. */}
          <div className="vi-mini-text">
            <span className="vi-mini-name" title={node.name}>
              {node.name}
            </span>
            <DialTag id={node.id} className="vi-mini-dial" stack />
          </div>
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
          <DialTag id={node.id} className="cr-chip preset-chip dial" />
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
        {/* What it is RUNNING ON, beside what it is. Absent until a record
            says so — see DialTag. */}
        <DialTag id={node.id} />
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
        {!node.servedSession && <GitChip dir={node.cwd} git={node.git} />}
        {!node.servedSession && <LaneChip node={node} sharers={sharers} />}
        {phase === 'idle' && activity && (
          <span className="vi-chip dim">{agoLabel(activity.updatedAt)}</span>
        )}
        {/* D7: the people at this door, at the head's right end. Renders
            nothing at all unless this card IS a served team's orch. */}
        <CardCallerAvatars card={{ id: node.id, name: node.name, orch: node.orch }} />
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

/**
 * THE LANE CHIP — what the card says about its git situation without asking
 * git: read off the node (lanes.ts keeps the last landing there) and the flow
 * store (who else is in this directory). A shared directory is amber, an
 * unlanded stop is red, a landing is a quiet tick; nothing when there is
 * nothing to say.
 */
function LaneChip({ node, sharers }: { node: TerminalNodeData; sharers: number }): React.JSX.Element | null {
  const last = node.laneLast ?? null
  const inLane = node.cwd.includes('/.claude/worktrees/')
  if (last && !last.ok && last.reason !== 'nothing' && last.reason !== 'dirty') {
    return (
      <span className="vi-chip cr-lane-chip bad" title={`Landing stopped: ${last.reason}${last.files?.length ? ' · ' + last.files.join(', ') : ''}`}>
        {last.reason === 'conflict' ? 'CONFLICT' : last.reason === 'gate' ? 'GATE FAILED' : 'LAND STOPPED'}
      </span>
    )
  }
  if (!inLane && sharers > 1) {
    return (
      <span className="vi-chip cr-lane-chip warn" title={`${sharers} agents share this working tree — give each a LANE (card menu)`}>
        SHARED ×{sharers}
      </span>
    )
  }
  if (inLane && node.laneAutoLand) {
    return (
      <span className="vi-chip cr-lane-chip" title={last?.ok ? `Auto-land: last landed ${last.commits} commit(s) → ${last.landed}` : 'Auto-land after each turn'}>
        AUTO-LAND
      </span>
    )
  }
  if (inLane) return <span className="vi-chip cr-lane-chip" title="In a lane of its own — LAND from the card menu">LANE</span>
  return null
}
