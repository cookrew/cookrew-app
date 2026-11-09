import type { ReactNode, Ref } from 'react'
import type { BarBand } from './remote-layout'
import { hostWords, remoteView, type CardControl, type RemoteAction, type RemoteConfirm, type RemoteHostView, type RemoteState, type RemoteWhere } from '../../../shared/remote-access'
import { machineCopy } from '../../../shared/machine-words'
import type { UseStatus } from '../../../shared/use-signal'
import './remote.css'

/**
 * THE REMOTE DESKTOP, DRAWN FROM ONE MODEL (shared/remote-access.ts): the card,
 * the sheet and the device page show this same panel, and the words come from
 * the state, never from whoever drew it. Everything here is props in, so each
 * state can be drawn and tested with no machine behind it.
 */

/** The frame takes pointers for itself: a press on a control stays on the control. */
const hold = (event: React.PointerEvent): void => event.stopPropagation()
/** Anything at all on the bar stays on the bar: it never goes on to the machine. */
const keep = (event: { stopPropagation(): void }): void => event.stopPropagation()

/**
 * What the frame's own listeners treat as Cookrew's controls, not the picture.
 * MobileBrowserFrame attaches some listeners natively (wheel, touch), and a
 * React stopPropagation does not reach those: they ask this instead.
 */
export const FRAME_CONTROLS = 'button, textarea, .rp-bar, .rp-cover, .remote-keybar'

export function RemotePanel({
  state,
  where,
  busy,
  note,
  onAct
}: {
  state: RemoteState
  where: RemoteWhere
  busy: boolean
  /** What the last action did. */
  note: string | null
  onAct: (action: RemoteAction) => void
}): React.JSX.Element {
  const view = remoteView(state, where)
  return (
    <div className={`rp-panel${view.needsYouThere ? ' rp-needs-you' : ''}`} role="alert" data-remote-state={state.id}>
      <h3>{view.title}</h3>
      <p className="rp-sentence">{view.sentence}</p>
      {view.next && <p className="rp-next">{view.next}</p>}
      {view.note && <p className="rp-note">{view.note}</p>}
      {view.actions.length > 0 && (
        <div className="rp-actions">
          {view.actions.map((action, index) => (
            <button key={action.id} type="button" className={index === 0 ? 'rp-action rp-primary' : 'rp-action'} disabled={busy} onPointerDown={hold} onClick={() => onAct(action)}>
              {action.label}
            </button>
          ))}
        </div>
      )}
      {note && <p className="rp-said" role="status">{note}</p>}
    </div>
  )
}

/**
 * WHAT STANDS OVER THE FRAME. A screen that cannot be read is covered, so a
 * held picture can never pass for a live one. A closed window keeps its own
 * way on (UseOverlay · GoneOffer), and a device with no desk its own line.
 */
export function coverState(input: { status: UseStatus | null; lineLost: boolean; lastHeardAt: number | null }): RemoteState | null {
  const { status, lineLost, lastHeardAt } = input
  if (status?.remote) return status.remote
  if (status?.use !== 'computer' || status.gone || !lineLost) return null
  return {
    id: 'unreachable',
    platform: status.control?.machine ?? 'darwin',
    // Nothing about a build is said in this state; the words read only the time.
    build: { settingsName: 'Cookrew', sourceBuild: false, restart: 'by-hand', agents: 'keep' },
    then: null,
    detail: null,
    lastSeenAt: lastHeardAt,
    until: null,
    waiting: false
  }
}

/** The picture has stopped and nothing has said why yet: it may not read as live. */
export const frameIsStale = (input: { computer: boolean; hasPicture: boolean; live: boolean }): boolean => input.computer && input.hasPicture && !input.live

export type RemoteConnection = 'live' | 'stalled' | 'reconnecting'

const CONNECTION: Record<RemoteConnection, string> = { live: 'Live', stalled: 'Waiting for a frame', reconnecting: 'Reconnecting' }

/** Where the switch is turned on: a Mac's ⋯ menu, and on Linux a shell there as well (a headless box has no one at its screen). */
function switchOffHint(control: CardControl, where: RemoteWhere): string {
  if (control.machine === 'linux') {
    return where === 'here'
      ? 'Remote control is off: turn it on in the ⋯ menu, or run cookrew remote on in a shell here.'
      : 'Remote control is off, and only someone at the machine can turn it on: in its ⋯ menu, or with cookrew remote on in a shell on it.'
  }
  return where === 'here' ? 'Remote control is off: turn it on in the ⋯ menu.' : 'Remote control is off, and only someone at the Mac can turn it on.'
}

function controlLine(control: CardControl, where: RemoteWhere, now: number): { text: string; hint: string | null } {
  if (control.until !== null) return { text: `You have control · ${Math.max(1, Math.round((control.until - now) / 60_000))} min left`, hint: null }
  if (control.heldBy !== null) return { text: `${control.heldBy} has control`, hint: null }
  if (control.switchOn) return { text: 'View only', hint: null }
  return { text: 'View only', hint: switchOffHint(control, where) }
}

/** A button's words, and the short ones a narrow band shows instead (remote.css · container query). */
const Label = ({ long, short }: { long: string; short: string }): React.JSX.Element => (
  <>
    <span className="rp-long">{long}</span>
    <span className="rp-short" aria-hidden="true">{short}</span>
  </>
)

/** What a viewer of a computer's screen can do: take control, give it back, and leave. */
export function RemoteBarView({
  control,
  where,
  connection,
  zoomed,
  now,
  error,
  busy,
  onTake,
  onGive,
  onEnd,
  onFit,
  band = null,
  extras = null,
  notice = null,
  measureRef
}: {
  control: CardControl
  where: RemoteWhere
  connection: RemoteConnection
  zoomed: boolean
  now: number
  error: string | null
  busy: boolean
  onTake: () => void
  onGive: () => void
  onEnd: () => void
  onFit: () => void
  /** The bar's own band beside the picture (remote-layout.ts). Absent: the old place, over the top of the frame. */
  band?: BarBand | null
  /** The frame's own buttons, which ride here instead of over the picture. */
  extras?: ReactNode
  /** The row's content, measured for the band's height. */
  measureRef?: Ref<HTMLDivElement>
  /** A word for the person (a copy, a note): it takes the status's place, so it never stands on the picture. */
  notice?: ReactNode
}): React.JSX.Element {
  const line = controlLine(control, where, now)
  const mine = control.until !== null
  const canTake = !mine && control.switchOn && control.heldBy === null
  const word = (sentence: string): string => machineCopy(sentence, control.machine)
  const place = band?.place ?? 'row'
  const hint = line.hint ? word(line.hint) : null
  const awake = control.awake ? word('Keeping the Mac awake while you watch') : null
  const style = band ? { left: band.rect.left, top: band.rect.top, width: band.rect.width, height: band.rect.height } : undefined
  const shared = {
    role: 'group',
    'aria-label': 'Remote desktop',
    style,
    onPointerDown: hold,
    onTouchStart: keep,
    onTouchEnd: keep,
    onClick: keep,
    onPointerMove: keep,
    onWheel: keep,
    onContextMenu: keep
  } as const
  const minutes = mine ? Math.max(1, Math.round(((control.until ?? now) - now) / 60_000)) : 0
  if (place === 'pill') {
    const said = [CONNECTION[connection], line.text, hint, awake].filter((part) => part !== null).join(' · ')
    return (
      <div className="rp-bar rp-bar-band rp-bar-pill" {...shared}>
        <span className={`rp-link rp-link-${connection}`} aria-label={CONNECTION[connection]} />
        {/* Everything said stays inside the column: an error or a notice takes the state's place. */}
        {error ? (
          <span className="rp-pill-state rp-bar-error" role="alert" title={error}>{error}</span>
        ) : notice ? (
          <span className="rp-pill-state">{notice}</span>
        ) : (
          <span className="rp-pill-state" title={said}>{mine ? `${minutes} min` : control.heldBy !== null ? 'Held' : control.switchOn ? 'View' : 'Off'}</span>
        )}
        {canTake && <button type="button" className="rp-bar-btn rp-take" aria-label="Take control" title="Take control" disabled={busy} onClick={onTake}>Take</button>}
        {mine && <button type="button" className="rp-bar-btn" aria-label="Give back" title="Give back" disabled={busy} onClick={onGive}>Give</button>}
        {zoomed && <button type="button" className="rp-bar-btn" aria-label="Fit" title="Fit" onClick={onFit}>Fit</button>}
        {extras}
        <button type="button" className="rp-bar-btn rp-end" aria-label="End session" title="End session" onClick={onEnd}>End</button>
      </div>
    )
  }
  return (
    <div className={`rp-bar${band ? ' rp-bar-band' : ''}`} {...shared}>
      <div className="rp-bar-inner" ref={measureRef}>
        <div className="rp-bar-row">
          <span className={`rp-link rp-link-${connection}`}>{CONNECTION[connection]}</span>
          {/* One line, whatever is said: an error takes this place, so the band keeps its height. */}
          {error ? (
            <span className="rp-control rp-bar-error" role="alert" title={error}>{error}</span>
          ) : notice ? (
            <span className="rp-control rp-notice">{notice}</span>
          ) : (
            <span className="rp-control" title={line.text}>{mine ? <Label long={line.text} short={`${minutes} min left`} /> : line.text}</span>
          )}
          <span className="rp-bar-acts">
            {canTake && <button type="button" className="rp-bar-btn rp-take" aria-label="Take control" disabled={busy} onClick={onTake}><Label long="Take control" short="Take" /></button>}
            {mine && <button type="button" className="rp-bar-btn" aria-label="Give back" disabled={busy} onClick={onGive}><Label long="Give back" short="Give" /></button>}
            {zoomed && <button type="button" className="rp-bar-btn" onClick={onFit}>Fit</button>}
            {extras}
            <button type="button" className="rp-bar-btn rp-end" aria-label="End session" onClick={onEnd}><Label long="End session" short="End" /></button>
          </span>
        </div>
        {hint && <p className="rp-bar-hint">{hint}</p>}
        {/* Always its line, said or not: other viewers coming and going must not move the picture. */}
        {band ? <p className={`rp-bar-hint${awake ? '' : ' rp-unsaid'}`} aria-hidden={awake ? undefined : true}>{awake ?? '\u00a0'}</p> : awake && <p className="rp-bar-hint">{awake}</p>}
      </div>
    </div>
  )
}

export function RemoteConfirmView({ confirm, onYes, onNo }: { confirm: RemoteConfirm; onYes: () => void; onNo: () => void }): React.JSX.Element {
  return (
    <div className="rp-confirm-scrim" role="dialog" aria-modal="true" aria-label={confirm.title} onPointerDown={hold}>
      <div className="rp-confirm">
        <h3>{confirm.title}</h3>
        <p>{confirm.sentence}</p>
        <div className="rp-actions">
          <button type="button" className="rp-action rp-primary" onClick={onYes}>{confirm.yes}</button>
          <button type="button" className="rp-action" onClick={onNo}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

/** Who is on this machine, in its own window, with the way to end it. */
export function RemoteHostBannerView({ view, platform, onStop }: { view: RemoteHostView; platform: string | undefined; onStop: () => void }): React.JSX.Element | null {
  const words = hostWords(view, platform)
  if (!words) return null
  return (
    <div className="rp-host" role="status" data-remote-host="">
      <span className="rp-host-dot" aria-hidden="true" />
      <span className="rp-host-words">
        <b>{words.line}</b>
        {words.awake && <small>{words.awake}</small>}
      </span>
      <button type="button" className="rp-host-stop" onClick={onStop}>Stop</button>
    </div>
  )
}
