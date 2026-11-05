import type { UseSource } from '../../../shared/use-sources'
import { sheetBody, type SheetBody, type SourceLoad, type SourceTab } from './source-sheet'

/**
 * THE PICKER'S SHEET, DRAWN FROM ITS PROPS (SourcePicker.tsx holds the state).
 *
 * Two tabs, Windows and Entire screen; a tile is a picture, the app's icon and
 * a title, and one tap makes the card. A window with no picture is drawn from
 * its name. A missing grant is the grant, with the way to it, not an empty
 * grid: a sheet with nothing in it reads as nothing being open.
 */

export interface SourceSheetProps {
  readonly load: SourceLoad
  readonly tab: SourceTab
  /** A closed window's card is being pointed at something else. */
  readonly replacing: boolean
  /** A pick is on its way: the tiles hold still, so one press makes one card. */
  readonly busy: boolean
  readonly error: string | null
  /** What the settings button did, said to someone who may be on a phone. */
  readonly settingsNote: string | null
  readonly canOpenSettings: boolean
  readonly onTab: (tab: SourceTab) => void
  readonly onPick: (source: UseSource) => void
  readonly onRefresh: () => void
  readonly onSettings: () => void
  readonly onClose: () => void
}

const TABS: ReadonlyArray<{ readonly id: SourceTab; readonly label: string }> = [
  { id: 'windows', label: 'Windows' },
  { id: 'screens', label: 'Entire screen' }
]

function Tile({ source, busy, onPick }: { source: UseSource; busy: boolean; onPick: (source: UseSource) => void }): React.JSX.Element {
  return (
    <button type="button" className="sp-tile" disabled={busy} onClick={() => onPick(source)}>
      <span className="sp-thumb">
        {source.thumb ? <img src={source.thumb} alt="" draggable={false} /> : <span className="sp-noshot">{source.title.slice(0, 1).toUpperCase()}</span>}
      </span>
      <span className="sp-name">
        {source.icon && <img className="sp-icon" src={source.icon} alt="" draggable={false} />}
        <span className="sp-words">
          <span className="sp-title">{source.title}</span>
          {source.app && source.app !== source.title && <small className="sp-app">{source.app}</small>}
        </span>
      </span>
    </button>
  )
}

function Body({ body, props }: { body: SheetBody; props: SourceSheetProps }): React.JSX.Element {
  switch (body.kind) {
    case 'loading':
      return <p className="sp-note" role="status">Looking at this machine’s screen…</p>
    case 'failed':
      return (
        <div className="sp-panel" role="alert">
          <p>{body.text}</p>
          <button type="button" className="sp-action" onClick={props.onRefresh}>Try again</button>
        </div>
      )
    case 'permission':
      return (
        <div className="sp-panel" role="alert">
          <h3>Cookrew needs {body.name}</h3>
          <p>{body.text}</p>
          {props.canOpenSettings && (
            <button type="button" className="sp-action" onClick={props.onSettings}>Open {body.name} settings</button>
          )}
          {props.settingsNote && <p className="sp-settings-note" role="status">{props.settingsNote}</p>}
        </div>
      )
    case 'note':
      return <p className="sp-note">{body.text}</p>
    case 'grid':
      return (
        <div className="sp-grid">
          {body.sources.map((source) => (
            <Tile key={source.id} source={source} busy={props.busy} onPick={props.onPick} />
          ))}
        </div>
      )
  }
}

export function SourceSheet(props: SourceSheetProps): React.JSX.Element {
  const { load, tab, replacing, error, onTab, onRefresh, onClose } = props
  const heading = replacing ? 'Pick another window' : 'Share a window or screen'
  return (
    <div className="gs-scrim cr-sheet sp-scrim" role="dialog" aria-modal="true" aria-label={heading} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gs-sheet cr-sheet sp-sheet" tabIndex={-1}>
        <header className="gs-sheet-head sp-head">
          <h2>{heading}</h2>
          <span className="sp-head-acts">
            <button type="button" className="gs-x" onClick={onRefresh} aria-label="Refresh" title="Look again">↻</button>
            <button type="button" className="gs-x" onClick={onClose} aria-label="Close">✕</button>
          </span>
        </header>
        <p className="gs-sub">{replacing ? 'This card will show what you pick.' : 'Opens as a card in this workspace’s artifacts.'}</p>
        <div className="sp-tabs" role="tablist" aria-label="What to share">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" className="sp-tab" aria-selected={t.id === tab} onClick={() => onTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {error && <p className="sp-error" role="alert">{error}</p>}
        <div className="sp-body" role="tabpanel">
          <Body body={sheetBody(load, tab)} props={props} />
        </div>
      </div>
    </div>
  )
}
