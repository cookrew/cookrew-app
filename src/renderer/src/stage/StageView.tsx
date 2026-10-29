// THE STAGE: levels, canvas and board as one view (2026-10-30).
//
// The whole window is one card — the one that most needs a person
// (stage-pick.ts) — drawn as the zoomed terminal the canvas had, side tabs
// and all. Every agent is a face at the right edge (AvatarRail.tsx). There is
// no canvas to pan and no zoom: the canvas keeps running underneath, so its
// live panes never remount, and the old views are still in the More menu.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentRow } from '../agent-rows'
import type { AttachmentIndex } from '../terminal-attachments'
import type { TerminalNodeData, WorkspaceState } from '../../../shared/model'
import { AvatarRail } from './AvatarRail'
import { useCrewRows } from './crew-rows'
import { diffPopped, pickBackground, railOrder, type PoppedItem, type StageItem, type StageTarget } from './stage-pick'
import { stagePin, useStagePin } from './stage-pin'
import { StageTerminal } from './StageTerminal'
import './stage.css'

/** A pop older than this has been seen, or missed: it no longer takes the stage. */
const POP_FRESH_MS = 10 * 60_000

export interface StageShowing {
  terminalId: string
  name: string
  workspaceName: string
}

export function StageView({
  workspace,
  workspaceId,
  terminals,
  attachIndex,
  onShowing
}: {
  workspace: WorkspaceState | null
  /** The loaded workspace's id: a switch is a first look, not a burst of new cards. */
  workspaceId: string | null
  terminals: readonly TerminalNodeData[]
  attachIndex: AttachmentIndex
  /** The agent on the stage, for the dock's composer and the route. */
  onShowing: (showing: StageShowing | null) => void
}): React.JSX.Element {
  const { live, quiet, now } = useCrewRows(workspace)
  const pin = useStagePin()
  const popped = usePopped(workspace, workspaceId, attachIndex)
  const all = useMemo(() => [...live, ...quiet], [live, quiet])
  const fresh = useMemo(() => popped.filter((p) => now - p.at < POP_FRESH_MS), [popped, now])
  const target = useMemo(() => pickBackground(all, fresh, pin), [all, fresh, pin])
  const shown = target ? all.find((r) => r.id === target.terminalId) ?? null : null
  // Every agent that has run a turn anywhere, and every agent on the loaded
  // canvas even if it has not (dimmed): the rest of the crew is the board's.
  const faces = useMemo(() => {
    const here = new Set(terminals.map((t) => t.id))
    const ordered = railOrder([...live, ...quiet.filter((r) => here.has(r.id))])
    return shown && !ordered.some((r) => r.id === shown.id) ? [shown, ...ordered] : ordered
  }, [live, quiet, terminals, shown])

  const showing = shown ? `${shown.id}\u0000${shown.name}\u0000${shown.workspaceName}` : null
  useEffect(() => {
    if (showing === null) return onShowing(null)
    const [terminalId, name, workspaceName] = showing.split('\u0000')
    onShowing({ terminalId, name, workspaceName })
  }, [showing, onShowing])
  useEffect(() => () => onShowing(null), [onShowing])

  const enter = useCallback((row: AgentRow) => stagePin.set({ terminalId: row.id, item: null }), [])
  const back = useCallback(() => stagePin.set(null), [])
  // You touched it: it stays. A new arrival waits on its face instead of
  // taking the stage from under your hands.
  const hold = (): void => {
    if (target && target.why !== 'pinned') stagePin.set({ terminalId: target.terminalId, item: null })
  }

  return (
    <div className="cr-stage-view" data-why={target?.why ?? 'none'}>
      <div className="cr-stage-main" onPointerDownCapture={hold} onKeyDownCapture={hold}>
        {target ? (
          <StageTerminal
            key={target.terminalId}
            terminalId={target.terminalId}
            local={terminals.find((t) => t.id === target.terminalId) ?? null}
            item={target.item}
            onBack={back}
          />
        ) : (
          <div className="cr-stage-wait">NO AGENT HERE YET</div>
        )}
        {target && <StageWhyLine target={target} />}
      </div>
      <AvatarRail rows={faces} now={now} current={target?.terminalId ?? null} onEnter={enter} />
    </div>
  )
}

const WHY: Record<StageTarget['why'], string> = {
  pinned: 'Held — Back returns to what needs you',
  choose: 'Needs your choice',
  review: 'Finished — review or prompt it',
  popped: 'A new card to review',
  latest: 'Nothing needs you — the latest agent'
}

function StageWhyLine({ target }: { target: StageTarget }): React.JSX.Element {
  return (
    <div className={`cr-stage-why ${target.why}`} role="status">
      {WHY[target.why]}
    </div>
  )
}

/** The browsers and notes that appeared on the loaded canvas while the window was open. */
function usePopped(workspace: WorkspaceState | null, workspaceId: string | null, attachIndex: AttachmentIndex): readonly PoppedItem[] {
  const known = useRef<{ workspaceId: string; ids: ReadonlySet<string> } | null>(null)
  const [popped, setPopped] = useState<readonly PoppedItem[]>([])
  const items = useMemo<StageItem[]>(
    () =>
      (workspace?.nodes ?? []).flatMap((n) => (n.kind === 'browser' || n.kind === 'note' ? [{ id: n.id, kind: n.kind }] : [])),
    [workspace]
  )
  const index = useRef(attachIndex)
  index.current = attachIndex
  useEffect(() => {
    if (!workspace || workspaceId === null) return
    const before = known.current !== null && known.current.workspaceId === workspaceId ? known.current.ids : null
    const ownerOf = (itemId: string): string | null => {
      for (const [terminalId, list] of index.current) if (list.some((a) => a.node.id === itemId)) return terminalId
      return null
    }
    const { known: ids, popped: fresh } = diffPopped(before, items, ownerOf, Date.now())
    known.current = { workspaceId, ids }
    if (fresh.length > 0) setPopped((now) => [...now.filter((p) => ids.has(p.id)), ...fresh])
  }, [workspace, workspaceId, items])
  // A card wired a moment after it appeared still finds its agent.
  return useMemo(
    () =>
      popped.map((p) => {
        if (p.terminalId !== null) return p
        for (const [terminalId, list] of attachIndex) if (list.some((a) => a.node.id === p.id)) return { ...p, terminalId }
        return p
      }),
    [popped, attachIndex]
  )
}
