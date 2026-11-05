// A zoomed terminal's own browsers and notes, inside its card.
//
// The side tabs sit in the card's left column under MDL / EFF / RTE; a tab
// opens its item in the lower half (transcripts above, item below). A browser opens
// as its real page (the browser layer renders it into the slot measured here)
// and can go full window; a note reads as markdown and edits in place.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { activeBrowserTab } from '../../shared/model'
import { secretSlotsOf, withSlotLine, withWords, withoutSlotLines } from '../../shared/secret-slot'
import { noteIsWhole } from '../../shared/wire-canvas'
import { cookrew } from './api'
import { attachView, type AttachView } from './attach-view'
import { CrIcon } from './icons'
import { renderNoteMarkdown } from './note-markdown'
import { SecretVault } from './nodes/SecretVault'
import { FIND_FROM, filterAttachments, type TerminalAttachment } from './terminal-attachments'
import type { ScreenRect } from './zoom-lod'

function label(item: TerminalAttachment): string {
  if (item.kind === 'note') return item.node.name
  const tab = activeBrowserTab(item.node)
  return tab.title?.trim() || item.node.name
}

/**
 * THE SIDE TABS: the terminal's browsers and notes as a browser's vertical tab
 * bar, in the left column under MDL / EFF / RTE. Collapsed it is that
 * column's width — an icon and the first letters per tab; on hover (or pinned
 * open, which is what a phone has) it widens over the transcript and shows
 * whole names. A tab opens its item in the lower half; the open one is lit.
 */
export function AttachTabs({
  terminalId,
  items,
  openId
}: {
  terminalId: string
  items: readonly TerminalAttachment[]
  openId: string | null
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [pinned, setPinned] = useState(false)
  const shown = filterAttachments(items, query)
  // Tabs keep the terminal's focus; only the filter takes it.
  const keep = (e: React.MouseEvent): void => e.preventDefault()
  return (
    <div className="attach-tabs-slot">
      <div className={`attach-tabs${pinned ? ' pinned' : ''}`} role="tablist" aria-orientation="vertical" aria-label="This terminal's browsers and notes">
        <button
          type="button"
          className="attach-tab attach-pin"
          aria-pressed={pinned}
          title={pinned ? 'Fold the tabs' : 'Keep the tabs open'}
          onMouseDown={keep}
          onClick={() => setPinned((now) => !now)}
        >
          <span className="attach-tab-icon">{pinned ? '‹' : '›'}</span>
          <span className="attach-tab-name">{items.length} browsers & notes</span>
        </button>
        {items.length >= FIND_FROM && (
          <label className="attach-tabs-find" title="Filter">
            <CrIcon name="search" />
            <input
              value={query}
              placeholder={`Filter ${items.length}`}
              aria-label="Filter browsers and notes"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Keys typed here are the filter's, not the terminal's or the canvas's.
                e.stopPropagation()
                if (e.key === 'Escape') {
                  setQuery('')
                  e.currentTarget.blur()
                }
                if (e.key === 'Enter' && shown.length > 0) attachView.toggle(terminalId, shown[0].node.id, shown[0].kind)
              }}
            />
          </label>
        )}
        {shown.map((item) => (
          <button
            key={item.node.id}
            type="button"
            role="tab"
            className={`attach-tab ${item.kind}${item.node.id === openId ? ' on' : ''}`}
            title={item.kind === 'browser' ? `${label(item)}\n${activeBrowserTab(item.node).url}` : item.node.name}
            aria-selected={item.node.id === openId}
            onMouseDown={keep}
            onClick={() => attachView.toggle(terminalId, item.node.id, item.kind)}
          >
            <span className="attach-tab-icon">
              <CrIcon name={item.kind} />
            </span>
            <span className="attach-tab-name">{label(item)}</span>
          </button>
        ))}
      </div>
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

function SecretNoteBody({
  words,
  canWrite,
  onEdit,
  children
}: {
  words: string
  canWrite: boolean
  onEdit: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="attach-note-scroll" onDoubleClick={onEdit}>
      {words.length > 0 ? (
        <div className="note-body attach-note-words" dangerouslySetInnerHTML={{ __html: renderNoteMarkdown(words) }} />
      ) : (
        // With no words the table can fill the page, and a phone has nowhere
        // left to double-click: the way in is a line of its own.
        canWrite && (
          <button type="button" className="attach-note-addwords" onClick={onEdit}>
            Write about these secrets…
          </button>
        )
      )}
      {children}
    </div>
  )
}

function NoteView({ item }: { item: Extract<TerminalAttachment, { kind: 'note' }> }): React.JSX.Element {
  const note = item.node
  const whole = noteIsWhole(note)
  const [editing, setEditing] = useState(false)
  const slots = secretSlotsOf(note.content)
  // A secret note's editor holds its words alone: the slot lines are the table's.
  const secret = slots.length > 0
  const editable = secret ? withoutSlotLines(note.content) : note.content
  const [draft, setDraft] = useState(editable)
  useEffect(() => {
    if (!editing) setDraft(editable)
  }, [editable, editing])
  const canWrite = !note.locked && whole
  const edit = (): void => {
    if (canWrite) setEditing(true)
  }
  const commit = (): void => {
    setEditing(false)
    // Never over a body we only half have (see NoteNode).
    if (whole && draft !== editable) void cookrew().updateNode(note.id, { content: secret ? withWords(note.content, draft) : draft })
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
          placeholder={secret ? 'Write about these secrets…' : undefined}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Keys typed into the note are the note's, not the terminal's or the canvas's.
            e.stopPropagation()
            if (e.key === 'Escape') commit()
          }}
        />
      ) : secret ? (
        // A SECRET NOTE: its words, then its vault, in one scroll. A double-click
        // edits the words, as any note edits.
        <SecretNoteBody words={editable} canWrite={canWrite} onEdit={edit}>
          <SecretVault
            names={slots}
            canAdd={canWrite}
            onAddSlot={async (name) => {
              await cookrew().updateNode(note.id, { content: withSlotLine(note.content, name) })
            }}
          />
        </SecretNoteBody>
      ) : (
        <div
          className="note-body attach-note-body"
          onDoubleClick={edit}
          dangerouslySetInnerHTML={{ __html: renderNoteMarkdown(note.content || '*Double-click to write…*') }}
        />
      )}
    </>
  )
}
