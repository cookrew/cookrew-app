import { useEffect, useState } from 'react'
import { NodeProps, NodeResizer, useStore } from '@xyflow/react'
import { NodeHandles } from './NodeHandles'
import { CardClose } from './CardClose'
import { AgentAvatar, HandLed } from './AgentAvatar'
import { CrIcon, type CrIconName } from '../icons'
import { PastTurnView, TurnPagerBar, useTurnPaging } from './TurnPager'
import type { TerminalNodeData } from '../../../shared/model'
import type { TerminalActivity, TurnPhase } from '../../../shared/turn'
import { useCanvasUi } from '../canvas-ui'

const STATUS_LABEL: Record<TurnPhase, string> = {
  idle: 'READY',
  thinking: 'WORKING',
  waiting: 'NEEDS ATTENTION',
  replied: 'TURN COMPLETE'
}

/** Canvas zoom at which the card switches from compact row to full view. */
const FULL_VIEW_ZOOM = 0.95
/** Below this zoom the card degrades to a minimal tile (dot + name). */
const MINI_ZOOM = 0.28

type ZoomMode = 'full' | 'compact' | 'mini'

function zoomMode(zoom: number): ZoomMode {
  if (zoom >= FULL_VIEW_ZOOM) return 'full'
  return zoom >= MINI_ZOOM ? 'compact' : 'mini'
}

/**
 * Inverse type scale, quantized to 1/8 steps so cards don't re-render on
 * every animation frame while zooming — only when crossing a bucket.
 */
function quantInvZoom(zoom: number): number {
  if (zoom >= FULL_VIEW_ZOOM) return 1
  const inv = 1 / Math.max(zoom, 0.12)
  return Math.round(inv * 8) / 8
}

/** Vibe-island style activity glyph, cycling while the agent works. */
const SPINNER = ['✻', '✽', '✳', '✢']

/**
 * Summary card for a terminal. No xterm and no PTY attach here — the live
 * terminal mounts as a LOD overlay once the card covers the stage
 * (TerminalOverlay.tsx); clicking a card zooms the viewport to it.
 *
 * Agent cards follow vibe-island's session-card scheme: pixel avatar, bold
 * title + prompt snippet, chips, "You:" line and the latest status/reply.
 * Compact typography is inverse-scaled against the canvas zoom so status
 * and summary stay readable when overviewing the whole canvas; the full
 * view (status + tool trail + streaming message) only renders at ≥100%.
 */
export function TerminalNode({ data, selected }: NodeProps): React.JSX.Element {
  const node = (data as { node: TerminalNodeData }).node
  const { tool, activities, zoomToNode } = useCanvasUi()
  // Quantized subscriptions: these only change when crossing a bucket, so
  // zoom animation frames don't re-render every card.
  const mode = useStore((s) => zoomMode(s.transform[2]))
  const invZoom = useStore((s) => quantInvZoom(s.transform[2]))
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
          <HandLed phase={phase} />
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

  const full = mode === 'full'

  return (
    <div
      className={`node vi-card${full ? ' full' : ' compact'}${selected ? ' selected' : ''}${phase === 'thinking' ? ' working' : ''}${phase === 'waiting' ? ' attention' : ''}`}
      style={{ ['--z' as string]: String(invZoom) }}
    >
      <NodeResizer isVisible={selected} minWidth={240} minHeight={140} />
      <NodeHandles />
      <div className="node-header vi-head">
        <AgentAvatar phase={phase} preset={node.preset} />
        {/* The title carries the recap — Sous turn summary, else the prompt
            echo — matching the full view; the preset chip still names the
            agent, and the node name lives in the tooltip. */}
        <div className="vi-title" title={node.name}>
          {activity?.title ?? activity?.prompt ? (
            firstLine(activity.title ?? activity.prompt ?? '', 200)
          ) : (
            node.name
          )}
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
        {phase === 'idle' && activity ? (
          <span className="vi-chip dim">{agoLabel(activity.updatedAt)}</span>
        ) : (
          <HandLed phase={phase} />
        )}
        <CardClose nodeId={node.id} dark />
      </div>
      <div className="card-body vi-card-body nodrag nowheel" onClick={open}>
        {paging.viewing ? (
          <PastTurnView record={paging.viewing} />
        ) : full ? (
          <FullTurnView activity={activity} />
        ) : (
          <CompactTurnView activity={activity} />
        )}
      </div>
      {(paging.count > 0 || paging.viewing !== null) && <TurnPagerBar paging={paging} />}
      {full && (
        <div className="card-foot vi-foot">
          <span className={`card-status ${phase}`}>
            {phase === 'thinking' && <Spinner />} {STATUS_LABEL[phase]}
            {activity?.turnStartedAt != null && <TurnClock startedAt={activity.turnStartedAt} />}
          </span>
          <span className="card-open-hint vi-hint">
            CLICK TO ZOOM <CrIcon name="expand" />
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * Vibe-island collapsed row: "You:" line + latest status/reply. Type is
 * inverse-scaled (var(--z)) so it reads at overview zoom.
 */
function CompactTurnView({ activity }: { activity: TerminalActivity | undefined }): React.JSX.Element {
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
      {phase === 'waiting' && (
        <div className="vi-latest waiting">⚠ {msgSnippet ?? 'Needs your input'}</div>
      )}
      {phase === 'replied' && (
        <div className="vi-latest done">
          ✅ {activity.reply ? firstLine(activity.reply, 220) : 'Turn complete'}
        </div>
      )}
      {phase === 'idle' && <div className="vi-ready">Ready</div>}
    </>
  )
}

/**
 * Full view (≥100% zoom, before the LOD overlay takes over): execution
 * status row, tool trail with per-tool glyphs, streaming latest message.
 */
function FullTurnView({ activity }: { activity: TerminalActivity | undefined }): React.JSX.Element {
  if (!activity || activity.phase === 'idle' || activity.prompt === null) {
    // Reattached / idle-with-screen: show the agent's current screen tail so
    // the card reflects the latest turn recovered from tmux, not a blank slate.
    const tail = (activity?.lines ?? []).filter((l) => l.trim().length > 0)
    if (tail.length === 0) {
      return (
        <div className="vi-status idle">
          <span className="vi-dot" /> Idle — awaiting first prompt
        </div>
      )
    }
    return (
      <div className="cr-phos cr-crt card-screen vi-restored">
        {tail.slice(-6).map((line, i) => (
          <div key={i} className="phos-line">
            {line || ' '}
          </div>
        ))}
        <span className="phos-cursor">▮</span>
      </div>
    )
  }

  const { phase, glance } = activity
  const inTurn = phase === 'thinking' || phase === 'waiting'
  const fallbackTail = activity.lines.slice(-5).join('\n').trim()

  return (
    <>
      {activity.title && <div className="vi-turn-title">{firstLine(activity.title, 90)}</div>}
      <div className="vi-you">
        <span className="vi-you-label">You:</span> {firstLine(activity.prompt, 120)}
      </div>
      {phase === 'thinking' && (
        <div className="vi-status working">
          <span className="vi-dot pulse" /> {stripStatus(glance?.status) ?? 'Working…'}
        </div>
      )}
      {phase === 'waiting' && (
        <div className="vi-status waiting">
          <span className="vi-dot pulse" /> Waiting for your input
        </div>
      )}
      {phase === 'replied' && (
        <div className="vi-status done">
          <span className="vi-dot" /> Turn complete
        </div>
      )}
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
      {inTurn ? (
        <div className="vi-msg">
          {glance?.message ?? (fallbackTail || 'No output yet…')}
          <span className="vi-caret">▍</span>
        </div>
      ) : (
        <div className="vi-msg">{activity.reply || '(no visible output this turn)'}</div>
      )}
    </>
  )
}

function Spinner(): React.JSX.Element {
  const [i, setI] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setI((n) => (n + 1) % SPINNER.length), 260)
    return () => clearInterval(timer)
  }, [])
  return <span className="card-spinner">{SPINNER[i]}</span>
}

/** Ticking elapsed time for the current turn (vibe-island style). */
function TurnClock({ startedAt }: { startedAt: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000))
  const label = secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s` : `${secs}s`
  return <span className="card-clock">· {label}</span>
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

/** Drop the "(esc to interrupt · …)" chrome — the card has its own clock. */
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
