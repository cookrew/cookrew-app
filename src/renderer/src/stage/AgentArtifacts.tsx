// THE AGENT'S BROWSERS AND NOTES, ON ITS SHEET (owner, 2026-11-01, after the
// design drawn from group-motion-pivot.html): a column inside the full view's
// paper, on the right, under "browsers & notes" — each one the navigator's
// thumbnail, ×N when other agents share it. It is where an agent's artifacts
// attach, and where new ones are made: the dock's NOTE and BROWSER moved here,
// because a note or a browser is made inside an agent (zoom/make-card.ts ·
// makeItemFor) and the whole crew reads it from there.
//
// A thumbnail opens its card under the transcript, as the old side tabs did;
// clicking the open one closes it.
import { useEffect, useMemo, useState } from 'react'
import type { CanvasNode } from '../../../shared/model'
import { cookrew } from '../api'
import { attachView, useAttachView } from '../attach-view'
import { CrIcon } from '../icons'
import { thumbWants } from '../pets/thumb-wants'
import type { TerminalAttachment } from '../terminal-attachments'
import { makeItemFor } from '../zoom/make-card'
import { itemViewOf } from '../zoom/zoom-model'
import { Page } from '../zoom/ZoomParts'

export function AgentArtifacts({
  agent,
  items,
  owners,
  nodes
}: {
  agent: { id: string; name: string }
  /** The agent's own browsers and notes, newest wire first (terminal-attachments.ts). */
  items: readonly TerminalAttachment[]
  /** Item id → the agents wired to it, for ×N. */
  owners: ReadonlyMap<string, readonly string[]>
  /** The workspace's cards: a new one is stored beside them, under a name none has. */
  nodes: readonly CanvasNode[]
}): React.JSX.Element {
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

  const make = async (kind: 'note' | 'browser'): Promise<void> => {
    setMaking(kind)
    setError(null)
    const made = await makeItemFor(cookrew(), kind, agent, nodes)
    setMaking(null)
    if (!made.ok) setError(made.error)
    else if (made.id) attachView.open(agent.id, made.id, kind)
  }

  return (
    <aside className="zv-fv-arts" aria-label={`${agent.name}'s browsers and notes`}>
      <header className="zv-fv-arts-head">
        <span>{views.length ? 'browsers & notes' : 'no browser or note'}</span>
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
      </header>
      {error && (
        <p className="zv-fv-arts-error" role="alert">
          {error}
        </p>
      )}
      <div className="zv-fv-arts-list">
        {views.map((view) => {
          const shared = view.owners.length
          return (
            <button
              key={view.id}
              type="button"
              className={`zv-fv-art ${view.kind}${view.id === openId ? ' on' : ''}`}
              title={`${view.title}${view.kind === 'browser' ? `\n${view.line}` : ''}${shared > 1 ? `\nshared by ${shared} agents` : ''}`}
              aria-pressed={view.id === openId}
              onClick={() => attachView.toggle(agent.id, view.id, view.kind)}
            >
              <span className={`zv-th zv-big ${view.kind}`}>
                <Page item={view} big />
                {shared > 1 && <em>×{shared}</em>}
              </span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}
