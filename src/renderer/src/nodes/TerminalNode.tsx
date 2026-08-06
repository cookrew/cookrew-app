import { NodeProps, NodeResizer, useStore } from '@xyflow/react'
import { NodeHandles } from './NodeHandles'
import { CardClose } from './CardClose'
import { AgentAvatar, StatusCoin } from './AgentAvatar'
import { GitChip } from '../GitChip'
import { CrIcon, type CrIconName } from '../icons'
import { cardTypeScale, cardZoomMode } from './card-zoom'
import { PastTurnView, TurnPagerBar, useTurnPaging } from './TurnPager'
import type { TerminalNodeData } from '../../../shared/model'
import type { TerminalActivity } from '../../../shared/turn'
import { useCanvasUi } from '../canvas-ui'

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
  const { tool, activities, zoomToNode } = useCanvasUi()
  // Quantized subscriptions: these only change when crossing a bucket, so
  // zoom animation frames don't re-render every card.
  const mode = useStore((s) => cardZoomMode(s.transform[2]))
  const invZoom = useStore((s) => cardTypeScale(s.transform[2]))
  const activity = activities[node.id]
  const agent = activity?.agent ?? node.preset !== 'Shell'
  const phase = activity?.phase ?? 'idle'
  const paging = useTurnPaging(node.id, activity?.turnCount ?? 0)

  const open = (): void => {
    if (tool === 'select') zoomToNode(node.id)
  }

  // Below visual range: a minimal tile — status-tinted card, dot + name.
  // No avatar, no text body, no animations.
  if (mode === 'mini') {
    return (
      <div
        className={`node vi-card mini${selected ? ' selected' : ''}${phase === 'thinking' ? ' working' : ''}${phase === 'waiting' ? ' attention' : ''}`}
        style={{ ['--z' as string]: String(invZoom) }}
        onClick={open}
      >
        <NodeHandles />
        <div className="vi-mini node-header">
          <StatusCoin phase={phase} preset={node.preset} />
          <span className="vi-mini-name">{node.name}</span>
        </div>
      </div>
    )
  }

  if (!agent) {
    return (
      <div className={`node terminal-card${selected ? ' selected' : ''}`}>
        <NodeResizer isVisible={selected} minWidth={240} minHeight={160} />
        <NodeHandles />
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
      className={`node vi-card${selected ? ' selected' : ''}${phase === 'thinking' ? ' working' : ''}${phase === 'waiting' ? ' attention' : ''}`}
      style={{ ['--z' as string]: String(invZoom) }}
    >
      <NodeResizer isVisible={selected} minWidth={240} minHeight={140} />
      <NodeHandles />
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
        <GitChip dir={node.cwd} />
        {phase === 'idle' && activity && (
          <span className="vi-chip dim">{agoLabel(activity.updatedAt)}</span>
        )}
        <CardClose nodeId={node.id} dark />
      </div>
      <div className="card-body vi-card-body nodrag nowheel" onClick={open}>
        {paging.viewing ? (
          <PastTurnView record={paging.viewing} />
        ) : (
          <TurnSummary activity={activity} />
        )}
      </div>
      {(paging.count > 0 || paging.viewing !== null) && <TurnPagerBar paging={paging} />}
    </div>
  )
}

/**
 * The card body at every zoom: Sous recap headline, "You:" line, and the
 * latest status/reply. Type is inverse-scaled (var(--z)) so it reads at
 * overview zoom and stays natural size once zoomed in.
 */
function TurnSummary({ activity }: { activity: TerminalActivity | undefined }): React.JSX.Element {
  if (!activity || activity.prompt === null) {
    // Reattached after a restart: no turn is tracked yet, but the tmux
    // session's screen carries the latest turn — surface its tail instead of
    // pretending the agent is fresh.
    const tail = (activity?.lines ?? []).filter((l) => l.trim().length > 0)
    if (tail.length === 0) return <div className="vi-ready">Ready</div>
    return <div className="vi-latest done">{firstLine(tail[tail.length - 1], 220)}</div>
  }
  const { phase, glance } = activity
  const msgSnippet = glance?.message ? firstLine(glance.message, 220) : null
  const inTurn = phase === 'thinking' || phase === 'waiting'
  return (
    <>
      {activity.title && <div className="vi-turn-title">{firstLine(activity.title, 90)}</div>}
      <div className="vi-you">
        <span className="vi-you-label">You:</span> {firstLine(activity.prompt, 160)}
      </div>
      {phase === 'thinking' && (
        <div className="vi-latest working">
          <span className="vi-dot pulse" /> {stripStatus(glance?.status) ?? 'Working…'}
          {msgSnippet && <span className="vi-latest-snip"> — {msgSnippet}</span>}
        </div>
      )}
      {/* What it's doing RIGHT NOW: the status verb above says it's busy, the
          trail says with what. Newest last, older calls dimmed. */}
      {inTurn && glance !== null && glance.tools.length > 0 && (
        <div className="vi-tools">
          {glance.tools.map((toolCall, i) => (
            <div
              key={`${i}-${toolCall}`}
              className={`vi-tool ${i === glance.tools.length - 1 ? 'latest' : 'older'}`}
              title={toolCall}
            >
              <span className="vi-tool-glyph">
                <CrIcon name={toolGlyph(toolCall)} />
              </span>{' '}
              {toolCall}
            </div>
          ))}
        </div>
      )}
      {phase === 'waiting' && (
        <div className="vi-latest waiting">⚠ {msgSnippet ?? 'Needs your input'}</div>
      )}
      {phase === 'replied' && (
        <div className="vi-latest done">
          ✅ {activity.reply ? firstLine(activity.reply, 220) : 'Checkpoint saved'}
        </div>
      )}
      {/* Ready keeps the latest turn on screen, same as turn-complete —
          the ask stays above, the reply stays here. */}
      {phase === 'idle' &&
        (activity.reply ? (
          <div className="vi-latest done">{firstLine(activity.reply, 220)}</div>
        ) : (
          <div className="vi-ready">Ready</div>
        ))}
      <PendingInputLine activity={activity} />
    </>
  )
}

/** Typed-but-unsent input box content: visibly IN the inputbox, never
    masquerading as an ask (DEFECT 2, renderer half). */
function PendingInputLine({ activity }: { activity: TerminalActivity }): React.JSX.Element | null {
  if (!activity.pendingInput) return null
  return (
    <div className="vi-pending">
      <span className="vi-pending-label">typing:</span> {firstLine(activity.pendingInput, 120)}
      <span className="vi-caret">▍</span>
    </div>
  )
}

/** Vibe-island shows a per-tool view; the card gets a per-tool glyph. */
const TOOL_GLYPHS: [RegExp, CrIconName][] = [
  [/^Bash/i, 'bash'],
  [/^(Read|Write|Edit|Update|Create|NotebookEdit)/i, 'note'],
  [/^(Grep|Glob|Search|Find)/i, 'search'],
  [/^Web/i, 'browser'],
  [/^(Task|Agent)/i, 'agent']
]

function toolGlyph(toolCall: string): CrIconName {
  return TOOL_GLYPHS.find(([re]) => re.test(toolCall))?.[1] ?? 'dot'
}

/** Drop the "(esc to interrupt · …)" chrome — not useful at card size. */
function stripStatus(status: string | null | undefined): string | null {
  if (!status) return null
  const cleaned = status.replace(/\s*\((?:[^)]*esc to interrupt[^)]*)\)\s*$/i, '').trim()
  return cleaned.length > 0 ? cleaned : null
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
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
