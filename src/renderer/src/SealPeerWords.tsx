import { createPortal } from 'react-dom'
import { useCallback, useEffect, useState } from 'react'
import { cookrew } from './api'
import './grant-surface.css'
import './team-fork.css'

/**
 * ANOTHER OF YOUR COMPUTERS, MET FOR THE FIRST TIME (main/seal-pins.ts).
 *
 * Two desktops of one account seal with each other on their account keys; which
 * keys are the owner's is cookrew.dev's word until the owner has compared. Both
 * screens show these same six words for the pair. Same: the pair is pinned. Not
 * the same: that computer is refused from now on, whatever the account lists.
 */

export interface WaitingPeer {
  readonly deviceId: string
  /** This computer's own words: the other screen shows them as "the other computer". */
  readonly mine: readonly string[]
  /** The other computer's words: its screen shows them as "this computer". */
  readonly theirs: readonly string[]
}

export type PeerAnswer = 'same' | 'not-same' | 'later'

export function SealPeerWordsView({ peer, busy, onAnswer }: { peer: WaitingPeer; busy: boolean; onAnswer: (answer: PeerAnswer) => void }): React.JSX.Element {
  return (
    <div className="gs-scrim cr-sheet" role="dialog" aria-modal="true" aria-label="Compare words with another computer">
      <div
        className="gs-sheet gs-small cr-sheet"
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Escape' && !busy) onAnswer('later')
        }}
      >
        <header className="gs-sheet-head">
          <h2>Another of your computers</h2>
        </header>
        <p className="gs-consequence">
          This computer just connected to another one on your account ({peer.deviceId.slice(0, 8)}). The other computer shows this same sheet. Check across the two screens:
        </p>
        <p className="gs-consequence">This computer</p>
        <p className="gs-words" lang="en">
          {peer.mine.join(' ')}
        </p>
        <p className="gs-consequence">The other computer</p>
        <p className="gs-words" lang="en">
          {peer.theirs.join(' ')}
        </p>
        <p className="gs-consequence">
          Press SAME WORDS only if the other screen shows this sheet too, with these words swapped: its "This computer" is the "The other computer" here. Not the same: that computer is refused, whatever your account says.
        </p>
        <div className="gs-sheet-foot">
          {/* Focus starts here, so Escape (Later) works at once and Enter never presses SAME by accident. */}
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <button type="button" className="gs-ghost" onClick={() => onAnswer('later')} disabled={busy} autoFocus>
            LATER
          </button>
          <button type="button" className="gs-ghost" onClick={() => onAnswer('not-same')} disabled={busy}>
            NOT THE SAME
          </button>
          <button type="button" className="gs-primary" onClick={() => onAnswer('same')} disabled={busy}>
            SAME WORDS
          </button>
        </div>
      </div>
    </div>
  )
}

/** Said when NOT THE SAME could not be written whole on this Mac (main/seal-blocked.ts · answerPeer said false). */
export const BLOCKED_PARTLY =
  'That computer was cut off, but its block could not be saved in full here. If its words show again, answer again; otherwise quit and reopen Cookrew to finish blocking it.'

/** Did the answer fail? NOT THE SAME says true only when every part of the block was written. */
export const answerFailed = (answer: PeerAnswer, said: unknown): boolean => answer === 'not-same' && said !== true

export function SealPeerFailedView({ onDismiss }: { onDismiss: () => void }): React.JSX.Element {
  return (
    <div className="gs-scrim cr-sheet" role="alertdialog" aria-modal="true" aria-label="The block is not finished">
      <div className="gs-sheet gs-small cr-sheet">
        <header className="gs-sheet-head">
          <h2>Blocked only in part</h2>
        </header>
        <p className="gs-consequence">{BLOCKED_PARTLY}</p>
        <div className="gs-sheet-foot">
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <button type="button" className="gs-primary" onClick={onDismiss} autoFocus>
            OK
          </button>
        </div>
      </div>
    </div>
  )
}

/** Which sheet shows: a block not written whole first (never closed silently, Relay round 4, F2), then a computer waiting. */
export function SealPeerSheet({
  peer,
  failed,
  busy,
  onAnswer,
  onDismiss
}: {
  peer: WaitingPeer | undefined
  failed: boolean
  busy: boolean
  onAnswer: (answer: PeerAnswer) => void
  onDismiss: () => void
}): React.JSX.Element | null {
  if (failed) return <SealPeerFailedView onDismiss={onDismiss} />
  return peer === undefined ? null : <SealPeerWordsView peer={peer} busy={busy} onAnswer={onAnswer} />
}

const POLL_MS = 5000

/** Asked of this Mac while the app runs: nothing shows unless a computer waits. */
export function SealPeerWords(): React.JSX.Element | null {
  const api = cookrew()
  const [waiting, setWaiting] = useState<readonly WaitingPeer[]>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const ask = useCallback(() => {
    void api.sealPeersWaiting?.().then(setWaiting, () => undefined)
  }, [api])
  useEffect(() => {
    if (api.sealPeersWaiting === undefined) return undefined
    ask()
    const timer = setInterval(ask, POLL_MS)
    return () => clearInterval(timer)
  }, [api, ask])
  const peer = waiting[0]
  if (typeof document === 'undefined' || (peer === undefined && !failed)) return null
  const onAnswer = (answer: PeerAnswer): void => {
    if (peer === undefined) return
    setBusy(true)
    void (api.sealPeerAnswer?.(peer.deviceId, answer) ?? Promise.resolve(false))
      .then(
        (said) => setFailed(answerFailed(answer, said)),
        () => setFailed(answerFailed(answer, false))
      )
      .finally(() => {
        setBusy(false)
        ask()
      })
  }
  return createPortal(<SealPeerSheet peer={peer} failed={failed} busy={busy} onAnswer={onAnswer} onDismiss={() => setFailed(false)} />, document.body)
}
