import { useEffect, useState } from 'react'
import { cookrew } from '../api'
import { qrMatrix, qrPath } from '../../../shared/qr'
import { pairingPopoutView, type PairingPopoutView } from '../../../shared/pairing-qr'
import type { PairingHandout } from '../../../shared/account-v2'
import '../grant-surface.css'

/**
 * PAIR A PHONE — the popout, in v2.1 shape.
 *
 * ONE QR, of the one URL. It is the same string `cookrew mobile` prints: the
 * relay address for this desktop with the pairing token in its fragment, so a
 * phone scanning it lands on cookrew.dev, stays there, and reaches this Mac
 * from any network. A Mac with no account shows its direct `?token=` URL and
 * says that is what it is.
 *
 * NO CLOCK. The six-character key rotated every two minutes and the sheet had
 * a one-second interval to count it down; there is nothing to count now. The
 * URL changes only when the owner runs `cookrew mobile --rotate`, which is a
 * deliberate act that unpairs every phone — so the sheet asks main ONCE when
 * it opens and says what rotation costs, instead of polling for a change that
 * cannot happen while it is on screen.
 */

export function PairPhoneSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [handout, setHandout] = useState<PairingHandout | null>(null)
  const [asked, setAsked] = useState(false)

  useEffect(() => {
    let live = true
    const settle = (next: PairingHandout | null): void => {
      // A sheet that has been closed must not write state, and a refusal is
      // still an answer: it has to stop saying "reading…" either way.
      if (!live) return
      setHandout(next)
      setAsked(true)
    }
    void (cookrew().accountPairingUrl?.() ?? Promise.resolve(null))
      .then(settle)
      .catch(() => settle(null))
    return () => {
      live = false
    }
  }, [])

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
        {!asked ? (
          <p className="gs-sub">Reading this Mac&rsquo;s pairing URL&hellip;</p>
        ) : (
          <PairBody view={pairingPopoutView(handout)} />
        )}
      </div>
    </div>
  )
}

export function PairBody({ view }: { view: PairingPopoutView }): React.JSX.Element {
  return (
    <>
      <p className="gs-sub">{view.sentence}</p>
      {view.qr && <Qr text={view.qr} label="Pairing URL" />}
      <p className="cr-pair-desktop">
        {view.desktopName}
        {view.deviceIdPrefix ? ` · id ${view.deviceIdPrefix}` : ''}
      </p>
      <p className="gs-hint">{view.rotateNote}</p>
    </>
  )
}

/**
 * THE QUIET ZONE IS FOUR MODULES AND IT IS NOT A MARGIN.
 *
 * It is how a scanner FINDS the symbol: the finder patterns are recognised by
 * their 1:1:3:1:1 run of dark and light, and the outermost light run is the
 * quiet zone itself. This drew the matrix edge to edge inside its own box, and
 * leaned on an 8 px CSS border in cream to stand in for it — under two modules
 * at this size, in the wrong colour, and gone entirely if the box is ever
 * restyled. Now it is inside the SVG, in white, where it cannot be lost.
 *
 * One path for the whole symbol: a grid of rects is thousands of nodes React
 * has to diff, and a path is one.
 */
const QUIET = 4

function Qr({ text, label }: { text: string; label: string }): React.JSX.Element {
  const modules = qrMatrix(text)
  if (!modules) return <p className="gs-paste-error">That code is too long to draw.</p>
  const span = modules.length + QUIET * 2
  return (
    <svg
      className="cr-pair-qr"
      viewBox={`0 0 ${span} ${span}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={span} height={span} fill="#ffffff" />
      <g transform={`translate(${QUIET} ${QUIET})`}>
        <path d={qrPath(modules)} fill="#000000" />
      </g>
    </svg>
  )
}
