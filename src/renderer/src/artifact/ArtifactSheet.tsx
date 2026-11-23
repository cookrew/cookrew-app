import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
 * in an iframe sandboxed to `allow-scripts` only, using a blob URL with an
 * opaque frame origin. Pictures go in an <img>, where an SVG's scripts do not
 * run. A PDF is shown in an iframe using a blob typed as a PDF.
 * Nothing here writes HTML into this document (tests/artifact-sheet-render).
 */

export type SheetState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'failed'; readonly why: string }
  | {
      readonly phase: 'ready'
      readonly payload: { readonly kind: ArtifactPayload['kind']; readonly title?: string }
      readonly show: { readonly as: 'frame' } | Exclude<ArtifactShow, { as: 'frame' }>
      /** The bytes (or the note's markdown) as an object URL; null for a link or a refusal. */
      readonly objectUrl: string | null
      /** A separate download for a file whose preview was generated from its bytes. */
      readonly downloadUrl?: string
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
      // A blob URL, not srcdoc: a srcdoc document inherits THIS page's CSP, so a
      // console policy that allows no inline script would freeze the artifact.
      return objectUrl
        ? <iframe className="cr-artifact-frame" title={title} sandbox={FRAME_SANDBOX} src={objectUrl} referrerPolicy="no-referrer" />
        : <p className="cr-artifact-note">Nothing to show.</p>
    case 'image':
      return objectUrl ? <img className="cr-artifact-image" src={objectUrl} alt={title} /> : <p className="cr-artifact-note">No picture to show.</p>
    case 'pdf':
      // An iframe, not <object>: the console's policy allows frames from blob: and
      // nothing from object-src, and Chromium shows PDFs in a frame natively.
      return objectUrl ? (
        <iframe className="cr-artifact-frame" title={title} src={objectUrl} referrerPolicy="no-referrer" />
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

interface PanelProps {
  title: string
  onClose: () => void
  onBack?: () => void
  children: ReactNode
  footer?: ReactNode
}

export function ArtifactSheetPanel({ title, onClose, onBack, children, footer }: PanelProps): React.JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => { panel.current?.focus() }, [])
  return (
    <div
      className="cr-artifact-sheet"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div ref={panel} className="cr-artifact-panel" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <header className="cr-artifact-head">
          {onBack && <button type="button" className="cr-artifact-x" onClick={onBack} aria-label="Back">‹</button>}
          <span className="cr-artifact-title">{title}</span>
          <button type="button" className="cr-artifact-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="cr-artifact-body">{children}</div>
        {footer && <footer className="cr-artifact-foot">{footer}</footer>}
      </div>
    </div>
  )
}

export function ArtifactSheetView({ title, state, onClose, onBack, onSave }: Omit<PanelProps, 'children' | 'footer'> & { state: SheetState; onSave: () => void }): React.JSX.Element {
  const heading = state.phase === 'ready' ? state.payload.title ?? title : title
  const save = state.phase === 'ready' && (state.objectUrl !== null || state.downloadUrl !== undefined) ? state : null
  const footer = save && (
    <>
      <a className="cr-artifact-save" href={save.downloadUrl ?? save.objectUrl ?? undefined} download={save.saveName} onClick={onSave}>
        Save to this device
      </a>
      {save.saved && <span className="cr-artifact-saved">Saved on this device</span>}
    </>
  )
  return (
    <ArtifactSheetPanel title={heading} onClose={onClose} onBack={onBack} footer={footer}>
      <Body state={state} title={heading} />
    </ArtifactSheetPanel>
  )
}

/** What the Save anchor hands over: the file's bytes, or the note as markdown. */
function blobOf(payload: ArtifactPayload): Blob | null {
  if (payload.kind === 'file') return new Blob([payload.bytes], { type: payload.mime })
  if (payload.kind === 'note') return new Blob([payload.markdown], { type: 'text/markdown;charset=utf-8' })
  return null
}

function svgImageUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

const saveNameOf = (payload: ArtifactPayload): string =>
  payload.kind === 'note' && !/\.(md|markdown)$/i.test(payload.name) ? `${payload.name}.md` : payload.name

const failureWords = (error: unknown): string =>
  error instanceof HttpStatusError ? error.message : 'This could not be fetched from the computer. Try again in a moment.'

/** Prepare one preview and keep its original bytes available to Save. */
export function useArtifactPreview(id: string, load: (signal: AbortSignal) => Promise<ArtifactPayload>): {
  state: SheetState
  onSave: () => void
} {
  const [state, setState] = useState<SheetState>({ phase: 'loading' })
  const kept = useRef<{ key: string | null; blob: Blob | null }>({ key: null, blob: null })

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    let objectUrl: string | null = null
    let downloadUrl: string | undefined
    setState({ phase: 'loading' })
    void (async () => {
      try {
        const payload = await load(signal)
        if (signal.aborted) return
        const key = await cacheKeyOf(id, payload)
        const saved = key !== null && await isSaved(key)
        if (signal.aborted) return
        const blob = blobOf(payload)
        // An SVG's standalone document gets an opaque origin even if opened from the image menu.
        const svg = blob?.type === 'image/svg+xml' ? await svgImageUrl(blob) : null
        if (signal.aborted) return
        const show = showOf(payload)
        const preview = show.as === 'frame' ? new Blob([show.srcdoc], { type: 'text/html' }) : blob
        if (show.as !== 'save-only' && preview !== null) objectUrl = svg ?? URL.createObjectURL(preview)
        if (blob !== null && (show.as === 'frame' || show.as === 'save-only' || svg !== null)) {
          // The download link carries the original bytes as a download-only blob.
          downloadUrl = URL.createObjectURL(blob.slice(0, blob.size, 'application/octet-stream'))
        }
        kept.current = { key, blob }
        setState({
          phase: 'ready',
          payload: payload.kind === 'note' ? { kind: 'note', title: payload.title } : { kind: payload.kind },
          show: show.as === 'frame' ? { as: 'frame' } : show,
          objectUrl, downloadUrl, saveName: saveNameOf(payload), saved
        })
      } catch (error) {
        if (signal.aborted || (error as Error | undefined)?.name === 'AbortError') return
        setState({ phase: 'failed', why: failureWords(error) })
      }
    })()
    return () => {
      controller.abort()
      kept.current = { key: null, blob: null }
      if (objectUrl?.startsWith('blob:')) URL.revokeObjectURL(objectUrl)
      if (downloadUrl !== undefined) URL.revokeObjectURL(downloadUrl)
    }
  }, [id, load])

  const onSave = useCallback(() => {
    const { key, blob } = kept.current
    if (state.phase !== 'ready' || key === null || blob === null) return
    void saveCopy(key, blob, state.saveName).then((ok) => {
      if (ok) setState((now) => now === state ? { ...state, saved: true } : now)
    })
  }, [state])

  return { state, onSave }
}

export function useSheetEscape(onEscape: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.preventDefault()
      e.stopPropagation()
      onEscape()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onEscape])
}

export function ArtifactSheet({ id, name, onClose }: { id: string; name: string; onClose: () => void }): React.JSX.Element {
  const load = useCallback((signal: AbortSignal) => artifactView(id, name, signal), [id, name])
  const preview = useArtifactPreview(id, load)
  useSheetEscape(onClose)
  return <ArtifactSheetView title={name} onClose={onClose} {...preview} />
}

/** Mounted once in App: the sheet for whichever artifact a card asked to open here. */
export function ArtifactSheetHost(): React.JSX.Element | null {
  const open = useOpenArtifact()
  if (open === null || typeof document === 'undefined') return null
  return createPortal(<ArtifactSheet key={open.id} id={open.id} name={open.name} onClose={closeArtifact} />, document.body)
}
