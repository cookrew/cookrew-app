// The agent's notes (left) and browsers (right) after a dive, with a tab per
// item. They live in space the terminal leaves free, or fold into tabs that
// open a drawer over it (rail-layout.ts) — the terminal's rect is never theirs.
// A browser of a BACKGROUND workspace is not running on the desktop, so it is
// shown as its title and address, never as a live view.
import { useEffect, useState } from 'react'
import type { LevelsAgentDetail } from '../../../shared/strata'
import { railLayout, type Box } from './rail-layout'

type Note = LevelsAgentDetail['notes'][number]
type Browser = LevelsAgentDetail['browsers'][number]
type Side = 'notes' | 'browsers'

function NoteBody({ note }: { note: Note }): React.JSX.Element {
  return <pre className="cr-embed-note">{note.content}</pre>
}

function BrowserBody({ browser }: { browser: Browser }): React.JSX.Element {
  const urls = browser.tabs.length > 0 ? browser.tabs.map((t) => t.url) : browser.url ? [browser.url] : []
  return (
    <div className="cr-embed-browser">
      {!browser.live && <p className="cr-embed-muted">Not running — its workspace is in the background on that machine.</p>}
      {urls.map((url, i) =>
        // Only a web address becomes a link: a desktop's file:// or anything
        // stranger is shown, never followed from cookrew.dev.
        /^https?:\/\//i.test(url) ? (
          <a key={`${i}-${url}`} href={url} target="_blank" rel="noopener noreferrer" className="cr-embed-url">
            {url}
          </a>
        ) : (
          <span key={`${i}-${url}`} className="cr-embed-url">
            {url}
          </span>
        )
      )}
      {urls.length === 0 && <p className="cr-embed-muted">No address.</p>}
    </div>
  )
}

function Panel({ side, detail, picked, onPick }: { side: Side; detail: LevelsAgentDetail; picked: string | null; onPick: (id: string) => void }): React.JSX.Element {
  const items: Array<{ id: string; title: string }> = side === 'notes' ? detail.notes : detail.browsers
  const current = items.find((i) => i.id === picked) ?? items[0]
  return (
    <div className="cr-embed-panel">
      <div role="tablist" aria-label={side === 'notes' ? 'Notes' : 'Browsers'} className="cr-embed-tabs">
        {items.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={item.id === current?.id}
            className={`cr-embed-tab${item.id === current?.id ? ' on' : ''}`}
            onClick={() => onPick(item.id)}
          >
            {item.title || (side === 'notes' ? 'Note' : 'Browser')}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="cr-embed-tabpanel">
        {side === 'notes'
          ? detail.notes.filter((n) => n.id === current?.id).map((n) => <NoteBody key={n.id} note={n} />)
          : detail.browsers.filter((b) => b.id === current?.id).map((b) => <BrowserBody key={b.id} browser={b} />)}
      </div>
    </div>
  )
}

export function AttachmentRails({
  detail,
  terminal,
  focusAttachmentId
}: {
  detail: LevelsAgentDetail
  terminal: Box | null
  focusAttachmentId: string | null
}): React.JSX.Element | null {
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight })
  const [open, setOpen] = useState<Side | null>(null)
  const [picked, setPicked] = useState<string | null>(focusAttachmentId)

  useEffect(() => {
    const onResize = (): void => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // A dive that names an attachment opens on it.
  useEffect(() => {
    if (!focusAttachmentId) return
    setPicked(focusAttachmentId)
    setOpen(detail.browsers.some((b) => b.id === focusAttachmentId) ? 'browsers' : 'notes')
  }, [focusAttachmentId, detail])

  // Esc closes a drawer before it ever reaches the terminal's own Esc.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      setOpen(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  const notes = detail.notes.length
  const browsers = detail.browsers.length
  if (!terminal || notes + browsers === 0) return null
  const layout = railLayout(viewport, terminal)
  const panel = (side: Side) => <Panel side={side} detail={detail} picked={picked} onPick={setPicked} />

  if (layout.mode === 'rails') {
    const at = (box: Box) => ({ left: box.x, top: box.y, width: box.width, height: box.height })
    return (
      <>
        {layout.left && notes > 0 && (
          <aside className="cr-embed-rail left" style={at(layout.left)} aria-label="Notes">
            {panel('notes')}
          </aside>
        )}
        {layout.right && browsers > 0 && (
          <aside className="cr-embed-rail right" style={at(layout.right)} aria-label="Browsers">
            {panel('browsers')}
          </aside>
        )}
      </>
    )
  }

  const toggle = (side: Side) => setOpen((now) => (now === side ? null : side))
  if (layout.mode === 'sheet') {
    return (
      <>
        <button className="cr-embed-pill sheet" aria-expanded={open !== null} onClick={() => toggle(notes > 0 ? 'notes' : 'browsers')}>
          {notes > 0 && `NOTES ${notes}`}
          {notes > 0 && browsers > 0 && ' · '}
          {browsers > 0 && `BROWSERS ${browsers}`}
        </button>
        {open && (
          <div className="cr-embed-sheet" role="dialog" aria-label="Attachments">
            <div className="cr-embed-sheet-head">
              {notes > 0 && (
                <button className={`cr-embed-tab${open === 'notes' ? ' on' : ''}`} onClick={() => setOpen('notes')}>
                  NOTES {notes}
                </button>
              )}
              {browsers > 0 && (
                <button className={`cr-embed-tab${open === 'browsers' ? ' on' : ''}`} onClick={() => setOpen('browsers')}>
                  BROWSERS {browsers}
                </button>
              )}
              <button className="cr-embed-close" aria-label="Close attachments" onClick={() => setOpen(null)}>
                ✕
              </button>
            </div>
            {panel(open)}
          </div>
        )}
      </>
    )
  }

  return (
    <>
      {notes > 0 && (
        <button className="cr-embed-pill left" aria-expanded={open === 'notes'} onClick={() => toggle('notes')}>
          NOTES {notes}
        </button>
      )}
      {browsers > 0 && (
        <button className="cr-embed-pill right" aria-expanded={open === 'browsers'} onClick={() => toggle('browsers')}>
          BROWSERS {browsers}
        </button>
      )}
      {open && (
        <aside className={`cr-embed-drawer ${open === 'notes' ? 'left' : 'right'}`} aria-label={open === 'notes' ? 'Notes' : 'Browsers'}>
          {panel(open)}
        </aside>
      )}
    </>
  )
}
