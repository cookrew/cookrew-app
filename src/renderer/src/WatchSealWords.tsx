import { useCallback, useEffect, useState } from 'react'
import { cookrew } from './api'

/**
 * SIX WORDS, ON THE WATCH AND HERE (main/seal-watch-keys.ts).
 *
 * A watch's claim crossed the network in the clear, so the key it brought is only
 * believed once the owner sees the same words on the watch and on this Mac: the
 * words are made from both keys, and a key swapped on its way gives other words.
 * Same words: from then on the watch talks to this Mac end to end, through the
 * relay. Not the same: the key is dropped, and the watch keeps its old way.
 */

export interface PendingWatchKey {
  readonly deviceId: string
  readonly x: string
  readonly words: readonly string[]
}

const POLL_MS = 1500

export function WatchSealWordsView({
  pending,
  busy,
  note = null,
  onSame,
  onNotSame
}: {
  pending: readonly PendingWatchKey[]
  busy: boolean
  /** Said once a confirm was refused: the key on the watch changed between the words shown and the click. */
  note?: string | null
  onSame: (row: PendingWatchKey) => void
  onNotSame: (row: PendingWatchKey) => void
}): React.JSX.Element | null {
  if (pending.length === 0 && note === null) return null
  return (
    <section className="gs-seal-words" aria-label="Compare the watch's words">
      {note !== null && (
        <p className="gs-paste-error" role="alert">
          {note}
        </p>
      )}
      {pending.map((row) => (
        <div key={`${row.deviceId}:${row.x}`}>
          <p className="gs-consequence">The watch shows six words. Are they these?</p>
          <p className="gs-words" lang="en">
            {row.words.join(' ')}
          </p>
          <div className="gs-sheet-foot">
            <button type="button" className="gs-ghost" onClick={() => onNotSame(row)} disabled={busy}>
              NOT THE SAME
            </button>
            <button type="button" className="gs-primary" onClick={() => onSame(row)} disabled={busy}>
              SAME WORDS ON THE WATCH
            </button>
          </div>
        </div>
      ))}
    </section>
  )
}

/** The watches waiting for their words, asked of this Mac while the sheet is open. Owner's Mac only. */
export function WatchSealWords(): React.JSX.Element | null {
  const api = cookrew()
  const [pending, setPending] = useState<readonly PendingWatchKey[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const ask = useCallback(() => {
    void api.watchSealPending?.().then(setPending, () => undefined)
  }, [api])
  useEffect(() => {
    ask()
    const timer = setInterval(ask, POLL_MS)
    return () => clearInterval(timer)
  }, [ask])
  const answer = (done: Promise<unknown> | undefined, confirming: boolean): void => {
    setBusy(true)
    setNote(null)
    void (done ?? Promise.resolve(false))
      .then((said) => {
        if (confirming && said !== true) setNote('The watch’s key changed since these words. Compare the new words.')
      })
      .catch(() => undefined)
      .finally(() => {
        setBusy(false)
        ask()
      })
  }
  return (
    <WatchSealWordsView
      pending={pending}
      busy={busy}
      note={note}
      onSame={(row) => answer(api.watchSealConfirm?.(row.deviceId, row.x), true)}
      onNotSame={(row) => answer(api.watchSealForget?.(row.deviceId), false)}
    />
  )
}
