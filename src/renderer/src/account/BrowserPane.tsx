import { BROWSER_COPY } from './browser-auth-store'

/**
 * THE PAGE'S TWO PIECES OF PIXELS: what pressing will do, and the wait after.
 *
 * Nothing here decides anything; the sheets hold the state and the words come
 * from browser-auth-store.ts.
 */

/** What the button opens, said before it is pressed. */
export function BrowserLede({ lede }: { lede: string }): React.JSX.Element {
  return <p className="gs-hint">{lede}</p>
}

/** Where the person went, and the way out. Cancel ends the trip in main. */
export function BrowserWait({ onCancel }: { onCancel: () => void }): React.JSX.Element {
  return (
    <div className="cr-acct-providers" role="status">
      <p className="gs-consequence">{BROWSER_COPY.WAITING}</p>
      <p className="gs-hint">{BROWSER_COPY.WAITING_WHY}</p>
      <button className="gs-ghost" onClick={onCancel}>
        CANCEL
      </button>
    </div>
  )
}
