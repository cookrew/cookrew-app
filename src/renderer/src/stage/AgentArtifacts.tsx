// THE AGENT'S BROWSERS AND NOTES, ON ITS SHEET (owner, 2026-11-01, after the
// design drawn from group-motion-pivot.html): a column inside the full view's
// paper, on the right, under "browsers & notes" — each one the navigator's
// thumbnail, ×N when other agents share it. It is where an agent's artifacts
// attach, and where new ones are made: the dock's NOTE and BROWSER moved here,
// because a note or a browser is made inside an agent (zoom/make-card.ts ·
// makeItemFor) and the whole crew reads it from there.
//
// A thumbnail opens its card under the transcript, as the old side tabs did;
// clicking the open one closes it. Its × removes the card, as the agent's own
// × does (owner, 2026-11-01): through CanvasUi.requestClose, so the app's one
// confirm dialog asks first.
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CanvasNode } from '../../../shared/model'
import { cookrew } from '../api'
import { attachView, useAttachView } from '../attach-view'
import { useCanvasUi } from '../canvas-ui'
import { CrIcon } from '../icons'
import { thumbWants } from '../pets/thumb-wants'
import type { TerminalAttachment } from '../terminal-attachments'
import { makeItemFor } from '../zoom/make-card'
import { itemViewOf, type ItemView } from '../zoom/zoom-model'
import { Page } from '../zoom/ZoomParts'

export function AgentArtifacts({
  agent,
  items,
  owners,
  nodes,
  makeSlot = null
}: {
  agent: { id: string; name: string }
  /** The agent's own browsers and notes, newest wire first (terminal-attachments.ts). */
  items: readonly TerminalAttachment[]
  /** Item id → the agents wired to it, for ×N. */
  owners: ReadonlyMap<string, readonly string[]>
  /** The workspace's cards: a new one is stored beside them, under a name none has. */
  nodes: readonly CanvasNode[]
  /** The full view's head tools (head-tools.ts): NOTE+ and BROWSER+ stand there, over the sheet's corner. */
  makeSlot?: HTMLElement | null
}): React.JSX.Element {
  const { requestClose } = useCanvasUi()
  const open = useAttachView()
  const openId = open?.terminalId === agent.id ? open.itemId : null
  const [making, setMaking] = useState<'note' | 'browser' | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setError(null), [agent.id])

  const views = useMemo(
    () =>
      items.flatMap((item) => {
        const view = itemViewOf(item.node, [...(owners.get(item.node.id) ?? [])])
        return view ? [view] : []
      }),
    [items, owners]
  )
  // Its pictures: the thumbnail producers photograph only what is wanted (pets/thumb-wants.ts).
  const browserKey = views.filter((v) => v.kind === 'browser').map((v) => v.id).join(',')
  useEffect(() => {
    thumbWants.claim('fv-arts', browserKey ? browserKey.split(',') : [])
    return () => thumbWants.release('fv-arts')
  }, [browserKey])

  // The new card opens under the transcript once it is among the agent's own:
  // opened sooner, the terminal closes it again as unwired (TerminalOverlay).
  const [opening, setOpening] = useState<{ id: string; kind: 'note' | 'browser' } | null>(null)
  useEffect(() => {
    if (!opening) return
    if (items.some((item) => item.node.id === opening.id)) {
      attachView.open(agent.id, opening.id, opening.kind)
      setOpening(null)
      return
    }
    const giveUp = setTimeout(() => setOpening(null), 10_000)
    return () => clearTimeout(giveUp)
  }, [opening, items, agent.id])

  const make = async (kind: 'note' | 'browser'): Promise<void> => {
    setMaking(kind)
    setError(null)
    const made = await makeItemFor(cookrew(), kind, agent, nodes)
    setMaking(null)
    if (!made.ok) setError(made.error)
    else if (made.id) setOpening({ id: made.id, kind })
  }

  const makeButtons = (
    <span className="zv-fv-arts-make">
      {(['note', 'browser'] as const).map((kind) => (
        <button
          key={kind}
          type="button"
          className="zv-fv-arts-btn"
          title={`New ${kind} for ${agent.name} — the crew can read it`}
          aria-label={`New ${kind} for ${agent.name}`}
          disabled={making !== null}
          onClick={() => void make(kind)}
        >
          <CrIcon name={kind} />
          <b aria-hidden="true">+</b>
        </button>
      ))}
    </span>
  )

  return (
    <aside className="zv-fv-arts" aria-label={`${agent.name}'s browsers and notes`}>
      <header className="zv-fv-arts-head">
        <span>{views.length ? 'browsers & notes' : 'no browser or note'}</span>
        {makeSlot ? createPortal(makeButtons, makeSlot) : makeButtons}
      </header>
      {error && (
        <p className="zv-fv-arts-error" role="alert">
          {error}
        </p>
      )}
      <div className="zv-fv-arts-list">
        {views.map((view) => (
          <ArtifactThumb
            key={view.id}
            view={view}
            on={view.id === openId}
            onOpen={() => attachView.toggle(agent.id, view.id, view.kind)}
            onRemove={() => requestClose(view.id)}
          />
        ))}
      </div>
    </aside>
  )
}

/**
 * One browser or note on the sheet: its thumbnail, which opens it, and beside
 * it (never inside: a button holds no button) the × that removes it, shown on
 * hover or focus as the thumbs grid's is (zoom.css · .zv-del).
 */
export function ArtifactThumb({
  view,
  on,
  onOpen,
  onRemove
}: {
  view: ItemView
  /** Open under the transcript now. */
  on: boolean
  onOpen: () => void
  /** Ask to remove it: the app's confirm dialog answers (App · requestClose). */
  onRemove: () => void
}): React.JSX.Element {
  const shared = view.owners.length
  return (
    <div className={`zv-fv-art-cell ${view.kind}`}>
      <button
        type="button"
        className={`zv-fv-art ${view.kind}${on ? ' on' : ''}`}
        title={`${view.title}${view.kind === 'browser' ? `\n${view.line}` : ''}${shared > 1 ? `\nshared by ${shared} agents` : ''}`}
        aria-pressed={on}
        onClick={onOpen}
      >
        <span className={`zv-th zv-big ${view.kind}`}>
          <Page item={view} big />
          {shared > 1 && <em>×{shared}</em>}
        </span>
      </button>
      <button
        type="button"
        className="zv-del zv-fv-art-del"
        title={`Remove ${view.title}${shared > 1 ? ` — ${shared} agents use it` : ''}`}
        aria-label={`Remove ${view.title}`}
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
      >
        ×
      </button>
    </div>
  )
}
