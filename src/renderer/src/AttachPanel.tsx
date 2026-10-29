// A zoomed terminal's own browsers and notes, inside its card.
//
// The strip sits at the bottom-left under the transcripts; tapping an item
// opens it in the lower half (transcripts above, item below). A browser opens
// as its real page (the browser layer renders it into the slot measured here)
// and can go full window; a note reads as markdown and edits in place.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { activeBrowserTab } from '../../shared/model'
import { noteIsWhole } from '../../shared/wire-canvas'
import { cookrew } from './api'
import { attachView, type AttachView } from './attach-view'
import { CrIcon } from './icons'
import { renderNoteMarkdown } from './note-markdown'
import type { TerminalAttachment } from './terminal-attachments'
import type { ScreenRect } from './zoom-lod'

function label(item: TerminalAttachment): string {
  if (item.kind === 'note') return item.node.name
  const tab = activeBrowserTab(item.node)
  return tab.title?.trim() || item.node.name
}

export function AttachStrip({
  terminalId,
  items,
  openId
}: {
  terminalId: string
  items: readonly TerminalAttachment[]
  openId: string | null
}): React.JSX.Element {
  return (
    <div className="attach-strip" role="toolbar" aria-label="This terminal's browsers and notes">
      {items.map((item) => (
        <button
          key={item.node.id}
          type="button"
          className={`attach-chip ${item.kind}${item.node.id === openId ? ' on' : ''}`}
          title={item.kind === 'browser' ? activeBrowserTab(item.node).url : item.node.name}
          aria-pressed={item.node.id === openId}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => attachView.toggle(terminalId, item.node.id, item.kind)}
        >
          <CrIcon name={item.kind} />
          <span>{label(item)}</span>
        </button>
      ))}
    </div>
  )
}

export function AttachPanel({
  item,
  view,
  cardRect
}: {
  item: TerminalAttachment
  view: AttachView
  /** The zoomed card's own rect: when it moves, the slot moves with it. */
  cardRect: ScreenRect
}): React.JSX.Element {
  return (
    <div className={`attach-panel ${item.kind}`}>
      {item.kind === 'browser' ? <BrowserSlot full={view.full} cardRect={cardRect} /> : <NoteView item={item} />}
    </div>
  )
}

/**
 * An empty box the browser layer fills. Measured on every size change of the
 * slot and every move of the card; the page itself stays where it always
 * lives (BrowserLayer), only drawn here.
 */
function BrowserSlot({ full, cardRect }: { full: boolean; cardRect: ScreenRect }): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      attachView.place(r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [cardRect.x, cardRect.y, cardRect.width, cardRect.height])
  // Esc leaves full window first; it must not also zoom the terminal out.
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      attachView.full(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [full])
  return <div ref={ref} className="attach-slot" />
}

function NoteView({ item }: { item: Extract<TerminalAttachment, { kind: 'note' }> }): React.JSX.Element {
  const note = item.node
  const whole = noteIsWhole(note)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(note.content)
  useEffect(() => {
    if (!editing) setDraft(note.content)
  }, [note.content, editing])
  const commit = (): void => {
    setEditing(false)
    // Never over a body we only half have (see NoteNode).
    if (whole && draft !== note.content) void cookrew().updateNode(note.id, { content: draft })
  }
  return (
    <>
      <div className="attach-note-head">
        <CrIcon name="note" />
        <b>{note.name}</b>
        {note.locked ? <span className="lock-badge">locked</span> : <span className="attach-hint">{editing ? 'Esc to save' : 'Double-click to edit'}</span>}
      </div>
      {editing ? (
        <textarea
          className="note-editor attach-note-editor"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Keys typed into the note are the note's, not the terminal's or the canvas's.
            e.stopPropagation()
            if (e.key === 'Escape') commit()
          }}
        />
      ) : (
        <div
          className="note-body attach-note-body"
          onDoubleClick={() => {
            if (!note.locked && whole) setEditing(true)
          }}
          dangerouslySetInnerHTML={{ __html: renderNoteMarkdown(note.content || '*Double-click to write…*') }}
        />
      )}
    </>
  )
}
