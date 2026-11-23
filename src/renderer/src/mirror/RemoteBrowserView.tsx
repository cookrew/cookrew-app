import { useCallback, useState } from 'react'
import { MobileBrowserFrame } from '../MobileBrowserFrame'
import { ProxyView } from './ProxyView'
import { chooseRemoteBrowserMode, remoteBrowserMode, type RemoteBrowserMode } from './mirror-mode'

/**
 * A WEB PAGE'S CARD, SEEN FROM ANOTHER DEVICE (mirror/RemoteBrowserView.tsx).
 *
 * The zoomed card draws the proxied page on this device. Screen opens the
 * computer's live view and Page returns here. When zoomed out, show the card's
 * thumbnail.
 */
export function RemoteBrowserView({
  browserId,
  cardUrl,
  zoomed,
  actions
}: {
  browserId: string
  cardUrl: string
  zoomed: boolean
  actions?: React.ReactNode
}): React.JSX.Element {
  const [mode, setMode] = useState<RemoteBrowserMode>(() => remoteBrowserMode(browserId))
  const choose = useCallback(
    (next: RemoteBrowserMode): void => {
      chooseRemoteBrowserMode(browserId, next)
      setMode(next)
    },
    [browserId]
  )
  if (zoomed && mode === 'page') {
    return <ProxyView key={cardUrl} browserId={browserId} cardUrl={cardUrl} actions={actions} onScreen={() => choose('screen')} />
  }
  return (
    <MobileBrowserFrame
      browserId={browserId}
      open={zoomed}
      streamEnabled
      desktopStreamToken={null}
      fallback="loading"
      actions={
        zoomed ? (
          <>
            <button
              type="button"
              className="browser-frame-btn mirror-page-btn"
              title="Show the page drawn on this device"
              data-proxy-page="true"
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={() => choose('page')}
            >
              Page
            </button>
            {actions}
          </>
        ) : null
      }
    />
  )
}
