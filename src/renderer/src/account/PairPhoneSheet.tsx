import { useEffect, useRef, useState } from 'react'
import { cookrew } from '../api'
import { qrMatrix, qrPath } from '../../../shared/qr'
import {
  PAIRING_COPY,
  pairingPopoutView,
  type PairingPopoutView
} from '../../../shared/pairing-qr'
import { startPairingPoll, type PairingPollState } from './pairing-poll'
import '../grant-surface.css'

/**
 * PAIR A PHONE — the popout, in v2 shape.
 *
 * What it shows is deliberately small: a QR carrying the desktop id and a
 * six-character key, the key in readable type, how long until it renews, and
 * which Mac this is. NO URL. The phone is already signed in at cookrew.dev and
 * gets the address from there; putting one on this screen was the thing that
 * made a photograph of this window a permanent credential and a route home.
 *
 * A Mac with no account keeps the old QR, because it has nowhere to publish
 * itself and the phone has nothing to sign in to. It says so in a sentence
 * rather than silently degrading.
 */

/**
 * The clock, as a module-level default.
 *
 * It was `now = () => Date.now()` in the parameter list, which makes a NEW
 * function every render — and that function was in the effect's dependency
 * array. See pairing-poll.ts for what that cost. One stable reference, and a
 * loop that lives outside React where it can be tested.
 */
const wallClock = (): number => Date.now()

export function PairPhoneSheet({
  onClose,
  legacyUrl = null,
  now = wallClock
}: {
  onClose: () => void
  legacyUrl?: string | null
  now?: () => number
}): React.JSX.Element {
  const [poll, setPoll] = useState<PairingPollState>(() => ({
    handout: null,
    asked: false,
    tick: now()
  }))

  // Held in a ref so a caller that passes an inline `now` still gets ONE
  // interval for the life of the sheet rather than one per render.
  const clock = useRef(now)
  clock.current = now

  useEffect(
    () =>
      startPairingPoll({
        load: () => cookrew().accountPairingKey?.() ?? Promise.resolve(null),
        now: () => clock.current(),
        onState: setPoll
      }),
    // Empty on purpose: nothing in here may change while the sheet is open.
    []
  )

  const { handout } = poll
  const view = pairingPopoutView({
    desktopName: handout?.desktopName ?? 'This Mac',
    key: handout
      ? { deviceId: handout.deviceId, key: handout.key, expiresAt: handout.expiresAt }
      : null,
    legacyUrl,
    // Derived from the live clock every tick, so the countdown cannot freeze.
    now: poll.tick
  })

  return (
    <div className="gs-scrim cr-sheet" role="dialog" aria-modal="true" aria-label="Pair a phone">
      <div
        className="gs-sheet gs-small cr-sheet"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape') onClose()
        }}
      >
        <header className="gs-sheet-head">
          <h2>Pair a phone</h2>
          <button className="gs-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {!poll.asked ? (
          <p className="gs-sub">Reading this Mac&rsquo;s key&hellip;</p>
        ) : (
          <PairBody view={view} />
        )}
      </div>
    </div>
  )
}

export function PairBody({ view }: { view: PairingPopoutView }): React.JSX.Element {
  if (view.mode === 'legacy') {
    return (
      <>
        <p className="gs-sub">{view.sentence}</p>
        {view.qr && <Qr text={view.qr} label="Pairing URL" />}
      </>
    )
  }
  return (
    <>
      <Qr text={view.qr} label="Pairing code" />
      <p className="cr-pair-key">{view.key}</p>
      <p className="cr-pair-renews">renews in {view.renewsIn}</p>
      <p className="cr-pair-desktop">
        {view.desktopName} · id {view.deviceIdPrefix}
      </p>
      <p className="gs-hint">{PAIRING_COPY.TYPED_KEY}</p>
    </>
  )
}

/**
 * One SVG path for the whole symbol. A grid of rects is thousands of nodes
 * that React then has to diff every second as the key rotates; a path is one.
 */
function Qr({ text, label }: { text: string; label: string }): React.JSX.Element {
  const modules = qrMatrix(text)
  if (!modules) return <p className="gs-paste-error">That code is too long to draw.</p>
  const size = modules.length
  return (
    <svg
      className="cr-pair-qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={qrPath(modules)} fill="#000000" />
    </svg>
  )
}
