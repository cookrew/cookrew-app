// THE STAGE: levels, canvas and board as one view (2026-10-30).
//
// Its levels follow the header's route (stage-select.ts): every device, every
// workspace as a thumbnail (StageMap.tsx), then one workspace, then one card
// zoomed in. Below is the workspace.
//
// One card, the whole width: an agent's terminal (the zoomed view the canvas
// had) or a browser or note itself. With nothing picked, it follows what needs
// you (stage-pick.ts). The side columns are retired (2026-10-30): the agents
// and the browsers and notes ride over every page as pets instead (pets/),
// on the bed this view keeps clear along its bottom. There is no canvas under
// it any more either: it is not rendered, so it costs nothing.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { activeBrowserTab, type TerminalNodeData, type WorkspaceState } from '../../../shared/model'
import type { AgentRow } from '../agent-rows'
import { attachView, useAttachView } from '../attach-view'
import { SideTabsContext, type AttachmentIndex } from '../terminal-attachments'
import { useCrewRows } from './crew-rows'
import { diffPopped, pickBackground, railOrder, type PoppedItem, type StageItem, type StageTarget } from './stage-pick'
import { firstLine, hostPath, ownersOf, stageSelect, useStageLevel, useStageSelection, type StageItemCard } from './stage-select'
import { StageMap } from './StageMap'
import { StageItemPane } from './StageItemPane'
import { StageTerminal } from './StageTerminal'
import './stage.css'

/** A pop older than this has been seen, or missed: it no longer takes the stage. */
const POP_FRESH_MS = 10 * 60_000

export interface StageShowing {
  /** Null when the card in the middle is a browser or note. */
  terminalId: string | null
  /** You zoomed into it (the route names it); else it is the workspace level's pick. */
  zoomed: boolean
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
  const selection = useStageSelection()
  const popped = usePopped(workspace, workspaceId, attachIndex)
  const owners = useMemo(() => ownersOf(attachIndex), [attachIndex])

  // The workspace's agents, as the board sees them; a card the roster has
  // not caught up with still gets a quiet row.
  const agents = useMemo(() => {
    const byId = new Map([...live, ...quiet].map((r) => [r.id, r]))
    return railOrder(terminals.map((t) => byId.get(t.id) ?? quietRow(t, workspace?.name ?? '')))
  }, [live, quiet, terminals, workspace?.name])
  const faces = useMemo(() => new Map(agents.map((r) => [r.id, r])), [agents])

  // Newest first: nodes are kept in creation order.
  const items = useMemo<StageItemCard[]>(() => {
    const out: StageItemCard[] = []
    for (const n of [...(workspace?.nodes ?? [])].reverse()) {
      if (n.kind === 'browser') {
        const tab = activeBrowserTab(n)
        out.push({ id: n.id, kind: 'browser', title: tab.title?.trim() || n.name, sub: hostPath(tab.url), owners: owners.get(n.id) ?? [], attachment: { kind: 'browser', node: n } })
      } else if (n.kind === 'note') {
        out.push({ id: n.id, kind: 'note', title: n.name, sub: firstLine(n.content ?? ''), owners: owners.get(n.id) ?? [], attachment: { kind: 'note', node: n } })
      }
    }
    return out
  }, [workspace, owners])

  const fresh = useMemo(() => popped.filter((p) => now - p.at < POP_FRESH_MS), [popped, now])
  const pin = selection.kind === 'agent' ? { terminalId: selection.id, item: null } : null
  const target = useMemo(() => (selection.kind === 'item' ? null : pickBackground(agents, fresh, pin)), [selection, agents, fresh, pin?.terminalId])
  const pickedItem = selection.kind === 'item' ? (items.find((i) => i.id === selection.id) ?? null) : null
  // The selection outlived its card (deleted, or another workspace loaded): follow again.
  useEffect(() => {
    if (selection.kind === 'item' && pickedItem === null) stageSelect.clear()
  }, [selection, pickedItem])

  const level = useStageLevel()
  const view = useAttachView()

  const shown = target ? (faces.get(target.terminalId) ?? null) : null
  const showing =
    level !== 'workspace'
      ? null
      : pickedItem
        ? `\u0000${pickedItem.title}\u0000${workspace?.name ?? ''}\u0000z`
        : shown
          ? `${shown.id}\u0000${shown.name}\u0000${shown.workspaceName}\u0000${selection.kind === 'auto' ? '' : 'z'}`
          : null
  useEffect(() => {
    if (showing === null) return onShowing(null)
    const [terminalId, name, workspaceName, zoomed] = showing.split('\u0000')
    onShowing({ terminalId: terminalId || null, name, workspaceName, zoomed: zoomed === 'z' })
  }, [showing, onShowing])
  useEffect(() => () => onShowing(null), [onShowing])

  const back = useCallback(() => stageSelect.clear(), [])
  // You touched it: it stays. A new arrival waits on its card instead of
  // taking the middle from under your hands.
  const hold = (): void => {
    if (selection.kind === 'auto' && target) stageSelect.set({ kind: 'agent', id: target.terminalId })
  }

  if (level !== 'workspace') {
    return (
      <div className="cr-stage-view map">
        <StageMap level={level} loadedWorkspaceId={workspaceId} />
      </div>
    )
  }

  return (
    <div className="cr-stage-view bedded" data-why={pickedItem ? 'item' : (target?.why ?? 'none')}>
      <div className="cr-stage-main" onPointerDownCapture={hold} onKeyDownCapture={hold}>
        {pickedItem ? (
          <StageItemPane key={pickedItem.id} item={pickedItem} onClose={back} />
        ) : target ? (
          <SideTabsContext.Provider value={false}>
            <StageTerminal
              key={target.terminalId}
              terminalId={target.terminalId}
              local={terminals.find((t) => t.id === target.terminalId) ?? null}
              item={target.item}
              onBack={back}
            />
          </SideTabsContext.Provider>
        ) : (
          <div className="cr-stage-wait">No agent here yet</div>
        )}
        {target && !pickedItem && <StageWhyLine target={target} />}
      </div>
    </div>
  )
}

const WHY: Record<StageTarget['why'], string> = {
  pinned: 'Picked — Back returns to what needs you',
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

/** A card on the canvas the roster has no row for yet. */
function quietRow(t: TerminalNodeData, workspaceName: string): AgentRow {
  return {
    id: t.id,
    name: t.name,
    preset: t.preset,
    role: t.role ?? null,
    orch: t.orch,
    active: true,
    workspaceId: '',
    workspaceName,
    cwd: t.cwd,
    spawnedAt: 0,
    phase: 'quiet',
    turn: null,
    turnCount: 0,
    brief: t.brief ?? null,
    lastActivityAt: 0
  }
}

/** The browsers and notes that appeared on the loaded canvas while the window was open. */
function usePopped(workspace: WorkspaceState | null, workspaceId: string | null, attachIndex: AttachmentIndex): readonly PoppedItem[] {
  const [known, setKnown] = useState<{ workspaceId: string; ids: ReadonlySet<string> } | null>(null)
  const [popped, setPopped] = useState<readonly PoppedItem[]>([])
  const items = useMemo<StageItem[]>(
    () => (workspace?.nodes ?? []).flatMap((n) => (n.kind === 'browser' || n.kind === 'note' ? [{ id: n.id, kind: n.kind }] : [])),
    [workspace]
  )
  useEffect(() => {
    if (!workspace || workspaceId === null) return
    const before = known !== null && known.workspaceId === workspaceId ? known.ids : null
    const { known: ids, popped: fresh } = diffPopped(before, items, () => null, Date.now())
    if (before === null || ids.size !== before.size || [...ids].some((id) => !before.has(id))) setKnown({ workspaceId, ids })
    if (fresh.length > 0) setPopped((now) => [...now.filter((p) => ids.has(p.id)), ...fresh])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, workspaceId, items])
  // The agent a card is wired to, read now: the wire often lands a moment after the card.
  return useMemo(() => {
    const byItem = ownersOf(attachIndex)
    return popped.map((p) => ({ ...p, terminalId: byItem.get(p.id)?.[0] ?? null }))
  }, [popped, attachIndex])
}
