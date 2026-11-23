import { useCallback, useState } from 'react'
import { MobileBrowserFrame } from '../MobileBrowserFrame'
import { MirrorView } from './MirrorView'
import { chooseRemoteBrowserMode, remoteBrowserMode, type RemoteBrowserMode } from './mirror-mode'
import { useMirrorPage } from './useMirrorPage'

/**
 * A WEB PAGE'S CARD, SEEN FROM ANOTHER DEVICE (mirror/RemoteBrowserView.tsx).
 *
 * Local by default: zoomed open, the card draws the page from data on this
 * device (MirrorView). The computer's screen of it is a mode — the Screen
 * button — and the Page button comes back. Neither view switches to the other
 * on its own. Zoomed out, the card shows its picture as every card does.
 *
 * Remote viewers only: the desktop keeps its pixel view (BrowserLayer.tsx).
 */
export function RemoteBrowserView({
  browserId,
  zoomed,
  actions
}: {
  browserId: string
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
    return <MirrorPanel browserId={browserId} actions={actions} onScreen={() => choose('screen')} />
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
              data-mirror-page="true"
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

function MirrorPanel({
  browserId,
  actions,
  onScreen
}: {
  browserId: string
  actions?: React.ReactNode
  onScreen: () => void
}): React.JSX.Element {
  const mirror = useMirrorPage(browserId, true)
  return <MirrorView state={mirror.state} onAct={mirror.act} onScreen={onScreen} onReload={mirror.reload} onRetry={mirror.retry} actions={actions} />
}
