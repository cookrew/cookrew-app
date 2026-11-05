import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RemoteState } from '../../../shared/remote-access'
import type { UseStatus } from '../../../shared/use-signal'
import { useRoster } from '../agent-registry'
import { cookrew } from '../api'
import { useCardCursors, type CardCursor } from '../use-cursors'
import { openSourcePicker } from './source-picker-store'
import { accessOf, remoteWhere, useRemoteActs } from './remote-acts'
import { coverState, frameIsStale, RemoteBarView, RemoteConfirmView, RemotePanel, type RemoteConnection } from './RemotePanel'
import './use-overlay.css'

/**
 * WHAT IS HAPPENING ON A CARD'S SCREEN, OVER THE FRAME (desktop and phone).
 *
 * The cursors: one per agent acting on this card, drawn inside the frame's
 * letterbox so a fraction of the screen is that fraction of the picture,
 * moving where the agent acts, rippling on a tap, heading home to the pet
 * corner when the agent goes quiet (use-cursors.ts).
 *
 * The device line: a use card's device offline says why in the owner's
 * words ("Screen Recording is off…", "No Android device is attached…"),
 * a screen nobody may drive says "view only", a dropped socket says it is
 * dialling again — over the last frame, never instead of it.
 *
 * A window that closed will not come back, so its card also offers the way
 * on: the whole screen, or another window, on this same card.
 *
 * A computer's screen says more (shared/remote-access.ts). When it cannot be
 * read the state stands over the frame, opaque, with its next action: a held
 * picture never passes for a live one. When it can, the remote bar says who
 * may drive, and how to take control, give it back and leave.
 */

/** A line gone this long is the Mac gone: a redial normally lands well inside it. */
export const LINE_LOST_MS = 8000

export interface FrameBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

const HUES = [262, 200, 150, 28, 340, 95, 180, 300]

function hueOf(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return HUES[h % HUES.length]
}

export function UseOverlay({
  card,
  box,
  status,
  reconnecting,
  live = true,
  hasPicture = false,
  lastFrameAt = null,
  zoomed = false,
  onFit,
  onEnd
}: {
  card: string
  box: FrameBox | null
  status: UseStatus | null
  reconnecting: boolean
  /** Frames are arriving. */
  live?: boolean
  hasPicture?: boolean
  /** When this viewer last painted a frame. */
  lastFrameAt?: number | null
  zoomed?: boolean
  onFit?: () => void
  onEnd?: () => void
}): JSX.Element | null {
  const cursors = useCardCursors(card)
  const roster = useRoster()
  const names = useMemo(() => new Map(roster.map((r) => [r.id, r.name])), [roster])
  const lineLost = useLineLost(reconnecting)
  const computer = status?.use === 'computer'
  const cover = coverState({ status, lineLost, lastHeardAt: lastFrameAt })
  const gone = goneOffered(status)
  const bar = computer && !cover && !gone && status?.state !== 'offline' && status?.control ? status.control : null
  // The bar says all this line would, and a cover more.
  const line = cover || (bar && status?.state === 'live') ? null : deviceLine(status, reconnecting)
  if (!line && cursors.length === 0 && !cover && !bar && !gone) return null
  return (
    <div className="use-overlay" aria-hidden={cursors.length > 0 && !line && !cover && !bar ? 'true' : undefined}>
      {frameIsStale({ computer, hasPicture, live }) && !cover && <div className="rp-stale" aria-hidden="true" />}
      {box && box.width > 0 && cursors.length > 0 && (
        <div className="use-cursors" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
          {cursors.map((c) => (
            <Cursor key={c.agent} cursor={c} name={names.get(c.agent) ?? 'agent'} />
          ))}
        </div>
      )}
      {line && (
        <div className={`use-device use-device-${line.tone}`} role="status">
          {line.text}
        </div>
      )}
      {gone && <GoneOffer card={card} />}
      {bar && <RemoteBar card={card} control={bar} connection={reconnecting ? 'reconnecting' : live ? 'live' : 'stalled'} zoomed={zoomed} onFit={onFit} onEnd={onEnd} />}
      {cover && <RemoteCover state={cover} onEnd={onEnd} />}
    </div>
  )
}

/** The line has been down long enough to say so. */
function useLineLost(reconnecting: boolean): boolean {
  const [lost, setLost] = useState(false)
  useEffect(() => {
    setLost(false)
    if (!reconnecting) return
    const timer = setTimeout(() => setLost(true), LINE_LOST_MS)
    return () => clearTimeout(timer)
  }, [reconnecting])
  return lost
}

function RemoteCover({ state, onEnd }: { state: RemoteState; onEnd?: () => void }): JSX.Element {
  // What Check again found, until the card's own status says otherwise.
  const [fresh, setFresh] = useState<RemoteState | null>(null)
  useEffect(() => setFresh(null), [state])
  const check = useCallback(async (): Promise<void> => {
    const access = accessOf(await cookrew().remoteAccess?.())
    if (!access) throw new Error('Still cannot reach it')
    setFresh({ ...access.state, lastSeenAt: state.lastSeenAt })
  }, [state.lastSeenAt])
  const shown = fresh ?? state
  const acts = useRemoteActs({ state: shown, onCheck: check, onOpened: check })
  return (
    <div className="rp-cover">
      <div className="rp-cover-body">
        <RemotePanel state={shown} where={remoteWhere()} busy={acts.busy} note={acts.note} onAct={acts.act} />
        {onEnd && <button type="button" className="rp-leave" onPointerDown={(event) => event.stopPropagation()} onClick={onEnd}>End session</button>}
      </div>
      {acts.confirm && <RemoteConfirmView confirm={acts.confirm} onYes={() => acts.answerConfirm(true)} onNo={() => acts.answerConfirm(false)} />}
    </div>
  )
}

/** Take control, and the minutes left: the only ticking here, and only while it matters. */
function RemoteBar({ card, control, connection, zoomed, onFit, onEnd }: { card: string; control: NonNullable<UseStatus['control']>; connection: RemoteConnection; zoomed: boolean; onFit?: () => void; onEnd?: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<RemoteState | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const mine = useRef(control.until !== null)
  mine.current = control.until !== null
  useEffect(() => {
    if (control.until === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [control.until])
  const ask = (on: boolean): void => {
    setBusy(true)
    setError(null)
    void cookrew()
      .remoteControl?.({ card, on })
      .then((answer) => {
        if (answer.ok) return setRefusal(null)
        setError(answer.state ? null : answer.error)
        setRefusal(answer.state ?? null)
      })
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)))
      .finally(() => setBusy(false))
  }
  const end = (): void => {
    if (mine.current) ask(false)
    onEnd?.()
  }
  return (
    <>
      <RemoteBarView control={control} where={remoteWhere()} connection={connection} zoomed={zoomed} now={now} error={error} busy={busy} onTake={() => ask(true)} onGive={() => ask(false)} onEnd={end} onFit={() => onFit?.()} />
      {refusal && <RemoteRefusalCover state={refusal} onRetry={() => ask(true)} onEnd={end} />}
    </>
  )
}

/** Take control was refused for a reason with a next action. Check again is the same ask again. */
function RemoteRefusalCover({ state, onRetry, onEnd }: { state: RemoteState; onRetry: () => void; onEnd: () => void }): JSX.Element {
  const acts = useRemoteActs({ state, onCheck: onRetry })
  return (
    <div className="rp-cover">
      <div className="rp-cover-body">
        <RemotePanel state={state} where={remoteWhere()} busy={acts.busy} note={acts.note} onAct={acts.act} />
        <button type="button" className="rp-leave" onPointerDown={(event) => event.stopPropagation()} onClick={onEnd}>End session</button>
      </div>
    </div>
  )
}

/** The card's window has closed for good, and the card is still saying so. */
export const goneOffered = (status: UseStatus | null): boolean => status?.state === 'offline' && status.gone === 'window'

/** Points this card at the main display; answers the refusal in words, or null. */
export async function showTheScreen(card: string): Promise<string | null> {
  try {
    const opened = await cookrew().openUseSource?.({ source: 'screen:main', card })
    if (!opened) return 'This client cannot show the screen'
    return opened.ok ? null : opened.error
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function GoneOfferView({ error, busy, onScreen, onAnother }: { error: string | null; busy: boolean; onScreen: () => void; onAnother: () => void }): JSX.Element {
  // The frame under this takes pointers for itself: a press here stays here.
  const stop = (event: React.PointerEvent): void => event.stopPropagation()
  return (
    <div className="use-offer" role="group" aria-label="This card's window has closed">
      <button type="button" disabled={busy} onPointerDown={stop} onClick={onScreen}>Show the screen</button>
      <button type="button" disabled={busy} onPointerDown={stop} onClick={onAnother}>Pick another window</button>
      {error && <span className="use-offer-error" role="alert">{error}</span>}
    </div>
  )
}

function GoneOffer({ card }: { card: string }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onScreen = (): void => {
    setBusy(true)
    setError(null)
    void showTheScreen(card).then((refusal) => {
      setError(refusal)
      setBusy(false)
    })
  }
  return <GoneOfferView error={error} busy={busy} onScreen={onScreen} onAnother={() => openSourcePicker({ card })} />
}

function Cursor({ cursor, name }: { cursor: CardCursor; name: string }): JSX.Element {
  const hue = hueOf(cursor.agent)
  const pointed = cursor.verb === 'tap' || cursor.verb === 'click' || cursor.verb === 'swipe' || cursor.verb === 'fill'
  return (
    <div
      className={`use-cursor${cursor.returningSince !== null ? ' returning' : ''}`}
      data-agent={cursor.agent}
      data-verb={cursor.verb}
      style={{ left: `${cursor.at.x * 100}%`, top: `${cursor.at.y * 100}%`, ['--use-hue' as string]: String(hue) }}
      title={`${name} · ${cursor.verb}`}
    >
      {pointed && cursor.returningSince === null && <span key={cursor.actedAt} className="use-ripple" />}
      <svg className="use-arrow" viewBox="0 0 16 20" width="16" height="20" aria-hidden="true">
        <path d="M1 1 L1 16 L5 12 L8 19 L11 17.6 L8 11 L14 11 Z" />
      </svg>
      <span className="use-badge">{name.slice(0, 1).toUpperCase()}</span>
      <span className="use-verb" key={`v${cursor.actedAt}`}>
        {name} · {cursor.verb}
      </span>
    </div>
  )
}

export function deviceLine(
  status: UseStatus | null,
  reconnecting: boolean
): { text: string; tone: 'warn' | 'quiet' } | null {
  if (reconnecting) return { text: 'reconnecting…', tone: 'quiet' }
  if (!status) return null
  if (status.state === 'offline') return { text: status.message ?? 'the device is offline', tone: 'warn' }
  if (status.state === 'connecting') return { text: `connecting to the ${status.use === 'hardware' ? 'camera' : status.use}…`, tone: 'quiet' }
  if (!status.input) return { text: status.use === 'hardware' ? 'camera · view only' : 'view only', tone: 'quiet' }
  return null
}
