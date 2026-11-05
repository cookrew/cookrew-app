import { useEffect, useState } from 'react'
import { cookrew } from './api'
import { CrIcon } from './icons'

/**
 * ⋯ → APPLE WATCH: the row that opens the sheet (WatchPairSheet.tsx), and, with
 * a watch paired, the one that forgets it. The sheet is the header's to hold: a
 * tap in it is a tap outside this menu, and the menu goes when that happens.
 */
export function WatchPairRow({ onPair }: { onPair: () => void }): React.JSX.Element | null {
  const api = cookrew()
  const [failed, setFailed] = useState(false)
  const [paired, setPaired] = useState(false)
  /** Forgetting a watch takes a second tap: it means pairing again on the wrist. */
  const [forgetting, setForgetting] = useState(false)

  useEffect(() => {
    let live = true
    void api.watchState?.().then(
      (state) => {
        if (live) setPaired(state.paired)
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [api])

  if (!api.watchCode) return null
  const forget = (event: React.MouseEvent): void => {
    event.stopPropagation()
    if (!forgetting) return setForgetting(true)
    setForgetting(false)
    api.watchForget?.().then(
      () => setPaired(false),
      () => setFailed(true)
    )
  }
  return (
    <>
      <button type="button" className="cr-more-item" title="Pair an Apple Watch with this Mac" onClick={onPair}>
        <CrIcon name="watch" />
        <span className="cr-more-label">{failed ? 'Apple Watch · try again' : 'Apple Watch…'}</span>
      </button>
      {paired && (
        <button type="button" className="cr-more-item" title="The paired watch stops working here and now" onClick={forget}>
          <CrIcon name="close" />
          <span className="cr-more-label">{forgetting ? 'Tap again to forget it' : 'Forget the watch'}</span>
        </button>
      )}
    </>
  )
}
