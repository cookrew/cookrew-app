// THE STAGE: canvas and board as one view (2026-10-30), showing the loaded
// workspace. Its devices and workspaces levels went with the levels code
// (2026-10-31); another workspace is reached by switching to it.
//
// One card, the whole width: an agent's terminal (the zoomed view the canvas
// had) or a browser or note itself. With nothing picked, it follows what needs
// you (stage-pick.ts). The side columns are retired (2026-10-30): the agents
// and the browsers and notes ride over every page as pets instead (pets/),
// on the bed this view keeps clear along its bottom. There is no canvas under
// it any more either: it is not rendered, so it costs nothing.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { activeBrowserTab, type CanvasNode, type TerminalNodeData, type WorkspaceState } from '../../../shared/model'
import { attachView, useAttachView } from '../attach-view'
import { NO_ATTACHMENTS, SideTabsContext, type AttachmentIndex } from '../terminal-attachments'
import { HeadToolsContext } from '../head-tools'
import type { Crew } from './crew-rows'
import { diffPopped, pickBackground, railOrder, type PoppedItem, type StageItem } from './stage-pick'
import { firstLine, hostPath, ownersOf, stageSelect, useStageSelection, type StageItemCard } from './stage-select'
import { StageItemPane } from './StageItemPane'
import { StageTerminal } from './StageTerminal'
import { AgentArtifacts } from './AgentArtifacts'
import './stage.css'
import { zoomStore } from '../zoom/zoom-store'
import { AgentAvatar } from '../nodes/AgentAvatar'
import { inkStatusOfRow, statusWord } from '../zoom/ink-status'
import { InkAvatar } from '../zoom/InkAvatar'
import { itemInitial } from '../zoom/zoom-model'
import '../zoom/full-views.css'
import { useFullRouteSlot } from '../route-slot'
import { fullRouteWords } from './full-route'

/** How many of each kind an agent carries, for the head. */
const tally = (list: readonly { kind: string }[]): { browsers: number; notes: number } => ({
  browsers: list.filter((a) => a.kind === 'browser').length,
  notes: list.filter((a) => a.kind === 'note').length
})

const NO_NODES: readonly CanvasNode[] = []

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
  crew,
  onShowing
}: {
  workspace: WorkspaceState | null
  /** The loaded workspace's id: a switch is a first look, not a burst of new cards. */
  workspaceId: string | null
  terminals: readonly TerminalNodeData[]
  attachIndex: AttachmentIndex
  /** The crew, read once in App (crew-rows.ts · useCrew): the same the zoom and the agent group draw. */
  crew: Crew
  /** The agent on the stage, for the dock's composer and the route. */
  onShowing: (showing: StageShowing | null) => void
}): React.JSX.Element {
  const { now } = crew
  const selection = useStageSelection()
  const popped = usePopped(workspace, workspaceId, attachIndex)
  const owners = useMemo(() => ownersOf(attachIndex), [attachIndex])

  // The workspace's agents: the crew (one row per terminal card, a quiet row
  // for one the roster has not caught up with), in rail order.
  const agents = useMemo(() => railOrder(crew.crew), [crew.crew])
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

  const view = useAttachView()
  // The head's tools (head-tools.ts): the transcript's toggle, then NOTE+ and BROWSER+.
  const [lookSlot, setLookSlot] = useState<HTMLElement | null>(null)
  const [makeSlot, setMakeSlot] = useState<HTMLElement | null>(null)

  const shown = target ? (faces.get(target.terminalId) ?? null) : null
  // The head's word says what its face draws (ink-status.ts · statusWord).
  const shownStatus = shown ? inkStatusOfRow(shown.phase, shown.unread) : 'idle'
  const showing = pickedItem
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

  const back = useCallback(() => {
    const z = zoomStore.get()
    zoomStore.go(z.dir === 'agents' ? 2 : 0, z.dir)
    stageSelect.clear()
  }, [])
  // You touched it: it stays. A new arrival waits on its card instead of
  // taking the middle from under your hands.
  const hold = (): void => {
    if (selection.kind === 'auto' && target) stageSelect.set({ kind: 'agent', id: target.terminalId })
  }

  // The full view wears the navigator's frame (zoom/full-views.css): a paper
  // panel with the agent's head on it, or the browser's or note's.
  const counts = tally(target ? (attachIndex.get(target.terminalId) ?? []) : [])
  // AN AGENT'S FULL VIEW ON A PHONE (owner, 2026-11-02): who it is goes up to
  // the bar (route-slot.ts), and the round ‹ steps aside for the bar's own ‹
  // (full-views.css reads the body's class). Above a phone CSS hides the copy.
  const routeSlot = useFullRouteSlot()
  const agentFull = !pickedItem && target !== null
  useEffect(() => {
    if (!agentFull) return
    document.body.classList.add('cr-full-agent')
    return () => document.body.classList.remove('cr-full-agent')
  }, [agentFull])
  return (
    <div className="cr-stage-view bedded" data-why={pickedItem ? 'item' : (target?.why ?? 'none')}>
      <div className="cr-stage-main" onPointerDownCapture={hold} onKeyDownCapture={hold}>
        {pickedItem ? (
          <div className="zv-fullview item">
            <header className="zv-fv-head">
              <span className={`zv-fv-face ${pickedItem.kind}`} aria-hidden="true">
                {itemFaceLetter(pickedItem)}
              </span>
              <span className="zv-fv-who">
                <b>{pickedItem.title}</b>
                <small>{pickedItem.kind} · {pickedItem.sub}</small>
              </span>
              <span className="zv-fv-used">
                <em>used by</em>
                {pickedItem.owners.length === 0 && <i>no agent</i>}
                {pickedItem.owners.slice(0, 4).map((id) => {
                  const row = faces.get(id)
                  return row ? (
                    <i key={id} title={row.name}>
                      <AgentAvatar id={row.id} orch={row.orch} preset={row.preset} status={inkStatusOfRow(row.phase, row.unread)} />
                      {row.name}
                    </i>
                  ) : null
                })}
              </span>
            </header>
            <StageItemPane key={pickedItem.id} item={pickedItem} onClose={back} />
          </div>
        ) : target ? (
          <div className="zv-fullview agent">
            {shown &&
              routeSlot &&
              createPortal(
                <>
                  <span className="cr-route-face" aria-hidden="true">
                    <InkAvatar id={shown.id} preset={shown.preset} orch={shown.orch} status={shownStatus} />
                  </span>
                  <span className="cr-route-who" title={shown.name}>
                    <b>{shown.name}</b>
                    <small>
                      {fullRouteWords(shownStatus, counts).map((word, i) => (
                        <span key={word} className={i === 0 ? shownStatus : undefined}>
                          {word}
                        </span>
                      ))}
                    </small>
                  </span>
                </>,
                routeSlot
              )}
            <header className="zv-fv-head">
              {shown && (
                <>
                  <span className="zv-fv-ink" aria-hidden="true">
                    <InkAvatar id={shown.id} preset={shown.preset} orch={shown.orch} status={shownStatus} weight="large" />
                  </span>
                  <span className="zv-fv-who">
                    <b>{shown.name}</b>
                    <small>
                      <span className={`zv-fv-state ${shownStatus}`}>{statusWord(shownStatus)}</span>
                      {counts.browsers > 0 && <span>{counts.browsers} browser{counts.browsers === 1 ? '' : 's'}</span>}
                      {counts.notes > 0 && <span>{counts.notes} note{counts.notes === 1 ? '' : 's'}</span>}
                      {counts.browsers + counts.notes === 0 && <span>nothing open</span>}
                    </small>
                  </span>
                </>
              )}
              {/* Over the sheet's top-right corner (owner, 2026-11-01). */}
              <span className="zv-fv-tools">
                <span className="zv-fv-tool-look" ref={setLookSlot} />
                <span className="zv-fv-tool-make" ref={setMakeSlot} />
              </span>
            </header>
            {/* The terminal, and beside it on the same paper the agent's browsers
                and notes (AgentArtifacts.tsx): its own side tabs stay off. */}
            <div className="zv-fv-body">
              <SideTabsContext.Provider value={false}>
                <HeadToolsContext.Provider value={lookSlot}>
                  <StageTerminal
                    key={target.terminalId}
                    local={terminals.find((t) => t.id === target.terminalId) ?? null}
                    item={target.item}
                    onBack={back}
                  />
                </HeadToolsContext.Provider>
              </SideTabsContext.Provider>
              {shown && (
                <AgentArtifacts
                  agent={{ id: shown.id, name: shown.name }}
                  items={attachIndex.get(shown.id) ?? NO_ATTACHMENTS}
                  owners={owners}
                  nodes={workspace?.nodes ?? NO_NODES}
                  makeSlot={makeSlot}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="cr-stage-wait">No agent here yet</div>
        )}
      </div>
    </div>
  )
}

/**
 * The letter on a browser's full-view head: its title's, as its card and its
 * coin draw it (zoom-model.ts · itemInitial). It once took the address's, so a
 * file:// page read "U" (for /Users) on the head and "D" on its card.
 */
export const itemFaceLetter = (item: { readonly kind: 'browser' | 'note'; readonly title: string }): string =>
  item.kind === 'note' ? '¶' : itemInitial(item.title)

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
