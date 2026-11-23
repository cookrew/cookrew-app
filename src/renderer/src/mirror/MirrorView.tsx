import { useMemo, useRef, useState } from 'react'
import type { MirrorBlock, MirrorPage } from '../../../shared/dom-mirror'
import { headingTag, linkHint, mirrorRows, type MirrorRow } from './mirror-layout'
import type { MirrorAct } from './mirror-message'
import type { MirrorState } from './mirror-state'
import './mirror.css'

/**
 * A BROWSER CARD'S PAGE, DRAWN ON THIS DEVICE (mirror/MirrorView.tsx).
 *
 * The computer sends what the page IS — headings, paragraphs, links, buttons,
 * fields — and this view lays it out with real elements: it scrolls here, its
 * text selects here, and nothing about it is a picture. A tap sends the ref of
 * the element tapped and one verb; the computer presses THAT element.
 *
 * Every string is drawn as text. A link's address is shown, never followed
 * from this device: a link is a button that presses the page's own link.
 *
 * The screen stream is a mode the viewer picks with the Screen button. Where
 * the page cannot be read, or its meaning lives in pixels, the view says so in
 * words beside that button and goes no further on its own.
 */

export interface MirrorViewProps {
  readonly state: MirrorState
  readonly onAct: (ref: number, act: MirrorAct, value?: string) => void
  readonly onScreen: () => void
  readonly onReload: () => void
  readonly onRetry: () => void
  /** Page-level actions the card owns (open in browser). */
  readonly actions?: React.ReactNode
}

export function MirrorView({ state, onAct, onScreen, onReload, onRetry, actions }: MirrorViewProps): React.JSX.Element {
  const page = state.phase === 'ready' ? state.page : null
  const busy = state.phase === 'ready' && state.busy
  return (
    <div className="browser-body mirror-view nodrag nowheel" data-mirror-state={state.phase} aria-busy={busy || state.phase === 'reading'}>
      <div className="mirror-bar">
        <span className="mirror-bar-title" title={page?.url}>
          {page?.title || page?.url || 'Page'}
        </span>
        {busy && (
          <span className="mirror-bar-busy" role="status">
            Working…
          </span>
        )}
        <button
          type="button"
          className="mirror-bar-btn"
          onClick={onReload}
          disabled={state.phase !== 'ready' || busy}
          title="Read the page again"
          aria-label="Read the page again"
        >
          ↻
        </button>
        <ScreenButton onScreen={onScreen} />
        {actions}
      </div>
      <MirrorBody state={state} onAct={onAct} onScreen={onScreen} onRetry={onRetry} />
    </div>
  )
}

function ScreenButton({ onScreen, label = 'Screen' }: { onScreen: () => void; label?: string }): React.JSX.Element {
  return (
    <button
      type="button"
      className="mirror-bar-btn mirror-screen-btn"
      onClick={onScreen}
      title="Watch the computer's screen of this page instead"
      data-mirror-screen="true"
    >
      {label}
    </button>
  )
}

function MirrorBody({
  state,
  onAct,
  onScreen,
  onRetry
}: Pick<MirrorViewProps, 'state' | 'onAct' | 'onScreen' | 'onRetry'>): React.JSX.Element | null {
  if (state.phase === 'idle') return null
  if (state.phase === 'reading') {
    return (
      <p className="mirror-say" role="status">
        Reading the page…
      </p>
    )
  }
  if (state.phase === 'failed') {
    return (
      <div className="mirror-say mirror-say-failed" role="alert">
        <p>{state.why}</p>
        <p>The page is not shown here. Screen shows the computer's own picture of it.</p>
        <div className="mirror-say-actions">
          <ScreenButton onScreen={onScreen} label="Show the screen" />
          <button type="button" className="mirror-bar-btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    )
  }
  return <MirrorPageBody page={state.page} note={state.note} busy={state.busy} onAct={onAct} onScreen={onScreen} />
}

function MirrorPageBody({
  page,
  note,
  busy,
  onAct,
  onScreen
}: {
  page: MirrorPage
  note: string | null
  busy: boolean
  onAct: MirrorViewProps['onAct']
  onScreen: () => void
}): React.JSX.Element {
  const rows = useMemo(() => mirrorRows(page.blocks), [page.blocks])
  return (
    <div className="mirror-page">
      {note !== null && (
        <p className="mirror-say mirror-say-note" role="status">
          {note}
        </p>
      )}
      {page.pixelOnly && (
        <div className="mirror-say mirror-say-pixels" role="note">
          <p>Part of this page is drawn as pictures (a video, a canvas or an embedded frame) and is not shown here.</p>
          <ScreenButton onScreen={onScreen} label="Show the screen" />
        </div>
      )}
      {rows.length === 0 && <p className="mirror-say">This page has no text or controls to show here.</p>}
      {rows.map((row) => (
        <MirrorRowView key={row.kind === 'list' ? `list-${row.key}` : row.block.ref} row={row} busy={busy} onAct={onAct} />
      ))}
      {page.truncated && <p className="mirror-say">The page goes on; only its first part is shown here.</p>}
    </div>
  )
}

function MirrorRowView({ row, busy, onAct }: { row: MirrorRow; busy: boolean; onAct: MirrorViewProps['onAct'] }): React.JSX.Element {
  if (row.kind === 'list') {
    return (
      <ul className="mirror-list">
        {row.items.map((item) => (
          <li key={item.ref} className="mirror-text">
            {item.text}
          </li>
        ))}
      </ul>
    )
  }
  return <MirrorBlockView block={row.block} busy={busy} onAct={onAct} />
}

function MirrorBlockView({ block, busy, onAct }: { block: MirrorBlock; busy: boolean; onAct: MirrorViewProps['onAct'] }): React.JSX.Element {
  switch (block.role) {
    case 'heading': {
      const Tag = headingTag(block.level)
      return <Tag className="mirror-heading">{block.text}</Tag>
    }
    case 'paragraph':
    case 'listitem':
      return <p className="mirror-text">{block.text}</p>
    case 'link': {
      const hint = linkHint(block.href)
      return (
        <button type="button" className="mirror-link" disabled={busy} onClick={() => onAct(block.ref, 'press')}>
          <span>{block.text}</span>
          {hint !== null && <span className="mirror-link-href">{hint}</span>}
        </button>
      )
    }
    case 'button':
      return (
        <button type="button" className="mirror-button" disabled={busy || block.disabled === true} onClick={() => onAct(block.ref, 'press')}>
          {block.text || 'Button'}
        </button>
      )
    case 'select':
      return (
        <button type="button" className="mirror-button mirror-select" disabled={busy || block.disabled === true} onClick={() => onAct(block.ref, 'press')}>
          {block.text}
          {block.value !== undefined && block.value !== block.text ? `: ${block.value}` : ''}
        </button>
      )
    case 'checkbox':
      return (
        <label className="mirror-check">
          <input
            type="checkbox"
            checked={block.checked === true}
            disabled={busy || block.disabled === true}
            onChange={() => onAct(block.ref, 'check')}
          />
          <span>{block.text}</span>
        </label>
      )
    case 'field':
      return <MirrorField block={block} onAct={onAct} />
    case 'image':
      return <p className="mirror-image">Image: {block.text}</p>
    case 'separator':
      return <hr className="mirror-rule" />
  }
}

/**
 * A field typed into HERE: focus goes to the page's field once per visit, and
 * the words go over when they are submitted (Enter) or left (blur) — not per
 * keystroke. The draft survives a fresh read of the page.
 */
function MirrorField({ block, onAct }: { block: MirrorBlock; onAct: MirrorViewProps['onAct'] }): React.JSX.Element {
  const held = block.value ?? ''
  const [draft, setDraft] = useState<string | null>(null)
  /** What was sent, against the value the page held then: shown until the page says otherwise. */
  const [sent, setSent] = useState<{ value: string; over: string } | null>(null)
  const focusSent = useRef(false)
  const shown = draft ?? (sent !== null && sent.over === held ? sent.value : held)
  const submit = (): void => {
    if (draft !== null && draft !== held) {
      onAct(block.ref, 'type', draft)
      setSent({ value: draft, over: held })
    }
    setDraft(null)
  }
  return (
    <label className="mirror-field">
      <span className="mirror-field-label">{block.text}</span>
      <input
        type="text"
        value={shown}
        disabled={block.disabled === true}
        onFocus={() => {
          if (focusSent.current) return
          focusSent.current = true
          onAct(block.ref, 'focus')
        }}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        }}
        onBlur={() => {
          focusSent.current = false
          submit()
        }}
      />
    </label>
  )
}
