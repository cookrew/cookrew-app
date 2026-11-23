import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { artifactView, HttpStatusError } from '../remote-api'
import { cacheKeyOf, isSaved, saveCopy } from './artifact-cache'
import { showOf, type ArtifactPayload, type ArtifactShow } from './artifact-decode'
import { closeArtifact, useOpenArtifact } from './open-artifact'
import './artifact-sheet.css'

/**
 * AN ARTIFACT, SHOWN ON THIS DEVICE (owner, 2026-11-23). The phone or the
 * console asks the computer for the artifact once (remote-api.ts ·
 * artifactView) and draws it itself, instead of streaming the computer's screen.
 *
 * THE ONE RULE: whatever an agent wrote never runs with this page's origin.
 * That origin holds the pairing token. A note or an HTML/markdown file is drawn
 * in an iframe sandboxed to `allow-scripts` only, from srcdoc, so its document
 * has an opaque origin of its own. Pictures go in an <img>, where an SVG's
 * scripts do not run; a PDF in an <object> of an object URL typed as a PDF.
 * Nothing here writes HTML into this document (tests/artifact-sheet-render).
 */

export type SheetState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'failed'; readonly why: string }
  | {
      readonly phase: 'ready'
      readonly payload: ArtifactPayload
      readonly show: ArtifactShow
      /** The bytes (or the note's markdown) as an object URL; null for a link or a refusal. */
      readonly objectUrl: string | null
      readonly saveName: string
      readonly saved: boolean
    }

/** The only sandbox an artifact frame gets: its scripts, never this origin. */
const FRAME_SANDBOX = 'allow-scripts'

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function Body({ state, title }: { state: SheetState; title: string }): React.JSX.Element {
  if (state.phase === 'loading') return <p className="cr-artifact-note">Loading…</p>
  if (state.phase === 'failed') return <p className="cr-artifact-note">{state.why}</p>
  const { show, objectUrl } = state
  switch (show.as) {
    case 'frame':
      return <iframe className="cr-artifact-frame" title={title} sandbox={FRAME_SANDBOX} srcDoc={show.srcdoc} referrerPolicy="no-referrer" />
    case 'image':
      return objectUrl ? <img className="cr-artifact-image" src={objectUrl} alt={title} /> : <p className="cr-artifact-note">No picture to show.</p>
    case 'pdf':
      return objectUrl ? (
        <object className="cr-artifact-frame" data={objectUrl} type="application/pdf" aria-label={title}>
          <p className="cr-artifact-note">This device cannot show the PDF here. Save it to read it.</p>
        </object>
      ) : (
        <p className="cr-artifact-note">No PDF to show.</p>
      )
    case 'save-only':
      return <p className="cr-artifact-note">This kind of file is not shown here. Save it to open it on this device.</p>
    case 'link':
      return (
        <p className="cr-artifact-note">
          {/* A real anchor, tapped: the gesture iOS and Android need to hand the page to its app. */}
          <a className="cr-artifact-link" href={show.url} target="_blank" rel="noopener noreferrer">
            Open {hostOf(show.url)}
          </a>
        </p>
      )
    case 'unavailable':
      return <p className="cr-artifact-note">{show.why}</p>
  }
}

export function ArtifactSheetView({ title, state, onClose, onSave }: { title: string; state: SheetState; onClose: () => void; onSave: () => void }): React.JSX.Element {
  const heading = state.phase === 'ready' && state.payload.kind === 'note' ? state.payload.title : title
  const save = state.phase === 'ready' && state.objectUrl !== null ? state : null
  return (
    <div
      className="cr-artifact-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="cr-artifact-panel" role="dialog" aria-modal="true" aria-label={heading}>
        <header className="cr-artifact-head">
          <span className="cr-artifact-title">{heading}</span>
          <button type="button" className="cr-artifact-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="cr-artifact-body">
          <Body state={state} title={heading} />
        </div>
        {save && (
          <footer className="cr-artifact-foot">
            <a className="cr-artifact-save" href={save.objectUrl ?? undefined} download={save.saveName} onClick={onSave}>
              Save to this device
            </a>
            {save.saved && <span className="cr-artifact-saved">Saved on this device</span>}
          </footer>
        )}
      </div>
    </div>
  )
}

/** What the Save anchor hands over: the file's bytes, or the note as markdown. */
function blobOf(payload: ArtifactPayload): Blob | null {
  if (payload.kind === 'file') return new Blob([payload.bytes], { type: payload.mime })
  if (payload.kind === 'note') return new Blob([payload.markdown], { type: 'text/markdown;charset=utf-8' })
  return null
}

const saveNameOf = (payload: ArtifactPayload): string =>
  payload.kind === 'note' && !/\.(md|markdown)$/i.test(payload.name) ? `${payload.name}.md` : payload.name

const failureWords = (error: unknown): string =>
  error instanceof HttpStatusError ? error.message : 'This could not be fetched from the computer. Try again in a moment.'

/** One artifact: fetched once when it opens, its object URL let go when it closes. */
export function ArtifactSheet({ id, name, onClose }: { id: string; name: string; onClose: () => void }): React.JSX.Element {
  const [state, setState] = useState<SheetState>({ phase: 'loading' })
  const kept = useRef<{ key: string | null; blob: Blob | null }>({ key: null, blob: null })

  useEffect(() => {
    let live = true
    let url: string | null = null
    void (async () => {
      try {
        const payload = await artifactView(id, name)
        const key = await cacheKeyOf(id, payload)
        const saved = key === null ? false : await isSaved(key)
        if (!live) return
        const blob = blobOf(payload)
        url = blob === null ? null : URL.createObjectURL(blob)
        kept.current = { key, blob }
        setState({ phase: 'ready', payload, show: showOf(payload), objectUrl: url, saveName: saveNameOf(payload), saved })
      } catch (error) {
        // Left for another machine: nothing to say about this one.
        if (!live || (error as Error | undefined)?.name === 'AbortError') return
        setState({ phase: 'failed', why: failureWords(error) })
      }
    })()
    return () => {
      live = false
      if (url !== null) URL.revokeObjectURL(url)
    }
  }, [id, name])

  // Esc closes the sheet and nothing under it (App's zoom-back, ZoomView's step out).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const onSave = useCallback(() => {
    const { key, blob } = kept.current
    if (key === null || blob === null) return
    const fileName = state.phase === 'ready' ? state.saveName : name
    void saveCopy(key, blob, fileName).then((ok) => {
      if (ok) setState((now) => (now.phase === 'ready' ? { ...now, saved: true } : now))
    })
  }, [state, name])

  return <ArtifactSheetView title={name} state={state} onClose={onClose} onSave={onSave} />
}

/** Mounted once in App: the sheet for whichever artifact a card asked to open here. */
export function ArtifactSheetHost(): React.JSX.Element | null {
  const open = useOpenArtifact()
  if (open === null || typeof document === 'undefined') return null
  return createPortal(<ArtifactSheet key={open.id} id={open.id} name={open.name} onClose={closeArtifact} />, document.body)
}
