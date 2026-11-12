// THE MORE MENU: everything on the bar that is not a way to move or a button
// of the open terminal — how many agents are working, the path, routing, the
// workspace wall, a refresh — behind one ⋯ at the end of the function bar.
// The board is not here any more: it is the search box left of ⋯. Each row opens its own sheet or panel, as its chip did.
//
// A row closes the menu from the menu's own React onClick, which runs after
// the row's: closing from a native listener instead unmounts the menu before
// React sees a trusted click, and the row would never act.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CrIcon } from './icons'
import { registerZoomMenuClose, setZoomMenuSlot } from './zoom-bar'
import { StatusCoin } from './nodes/AgentAvatar'
import { PathBadge } from './PathBadge'
import { RoutingEntry } from './routing/RoutingPanel'
import { setSoundsOn, useSoundsOn } from './chime-sound'
import { useTheme } from './color-scheme'
import { skinInfo } from '../../shared/skins'
import { SkinSheet } from './skins/SkinSheet'
import { FOLD_LIGHTS, FOLD_LIGHT_NAMES, setFoldLight, useFoldLight } from './zoom/fold-light'
import { canFullscreen, installedFullscreen, pageMedia, toggleFullscreen, useFullscreen } from './fullscreen'
import { TelemetryRow } from './TelemetryRow'
import { UpdateRows, useUpdateStatus } from './UpdateRow'
import { LaunchSettingsRow, LaunchSettingsSheet } from './LaunchSettingsSheet'
import { WatchPairRow } from './WatchPairRow'
import { RemoteSwitchRow } from './use/RemoteSwitch'
import { WatchPairSheet } from './WatchPairSheet'
import { isRemoteMode } from './api'
import { accountPageOf, readConsoleConfig } from './console/console-config'
import type { RouteStatus } from '../../shared/route'
import type { PathBadgeView } from '../../shared/path-badge'

interface HeaderMoreProps {
  busyCount: number
  terminalCount: number
  /** The phone's path: a Connection row that refreshes and opens its sheet. */
  connection: PathBadgeView | null
  onConnection: () => void
  onRouting?: () => void
  routeStatus: RouteStatus | null
  onWall: () => void
  /** Activity and history (MetricsPanel.tsx): what the fleet did, across workspaces. */
  onActivity: () => void
  onResync: () => void
  demo: boolean
}

export function HeaderMore({
  busyCount,
  terminalCount,
  connection,
  onConnection,
  onRouting,
  routeStatus,
  onWall,
  onActivity,
  onResync,
  demo
}: HeaderMoreProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pairingWatch, setPairingWatch] = useState(false)
  const [launchSheet, setLaunchSheet] = useState(false)
  const [skinSheet, setSkinSheet] = useState(false)
  const closeSkinSheet = useCallback(() => setSkinSheet(false), [])
  const closeLaunchSheet = useCallback(() => setLaunchSheet(false), [])
  const sounds = useSoundsOn()
  const theme = useTheme()
  const light = useFoldLight()
  const fullscreen = useFullscreen()
  const update = useUpdateStatus()
  // The phone only: Chrome on Android hides its bars this way; the desktop app has its own window.
  const offerFullscreen =
    isRemoteMode() && typeof document !== 'undefined' && canFullscreen(document) && !installedFullscreen(document, pageMedia)
  // On the console the account's own page is one row away, on the auth host; nowhere else is there such a row.
  const accountPage = useMemo(() => (typeof document === 'undefined' ? null : accountPageOf(readConsoleConfig(document))), [])
  const root = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  // The zoomed card's rows live in a portal, so they close the menu through here.
  useEffect(() => {
    registerZoomMenuClose(close)
    return () => registerZoomMenuClose(null)
  }, [close])

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent): void => {
      if (!root.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // The menu's Esc, not the canvas's zoom-back.
        e.stopPropagation()
        close()
        return
      }
      // Keys pressed in the menu stay there: the arrows must not reach the
      // page behind it. A button's Enter and Space still press it.
      if (root.current?.contains(e.target as Node)) e.stopPropagation()
    }
    // Tab out of the menu closes it, like a click outside.
    const onFocusOut = (e: FocusEvent): void => {
      const next = e.relatedTarget as Node | null
      if (next !== null && !root.current?.contains(next)) close()
    }
    // Capture: the canvas pane swallows mousedown before it bubbles.
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    root.current?.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
      root.current?.removeEventListener('focusout', onFocusOut)
    }
  }, [open, close])

  return (
    <>
    <div className="cr-more" ref={root}>
      <button
        type="button"
        className={`cr-more-btn${open ? ' on' : ''}${busyCount > 0 ? ' busy' : ''}${update?.available ? ' update' : ''}`}
        aria-label={update?.available ? `More, Cookrew ${update.available.version} is available` : 'More'}
        aria-expanded={open}
        aria-controls="cr-more-menu"
        title="More"
        onClick={() => setOpen((now) => !now)}
      >
        <CrIcon name="more" />
      </button>
      {open && (
        <div
          className="cr-more-menu"
          id="cr-more-menu"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('button, a')) close()
          }}
        >
          <div className="cr-more-status" role="presentation">
            <StatusCoin phase={busyCount > 0 ? 'thinking' : 'idle'} />
            <span className="cr-kicker">
              {busyCount}/{terminalCount} working
            </span>
            {demo && (
              <span className="cr-chip violet icon" title="Demo data">
                <CrIcon name="demo" />
              </span>
            )}
          </div>
          {/* The zoomed terminal's own rows (translate, titles, back, close), first:
              they are about what is on screen. Empty with nothing zoomed. */}
          <div className="cr-more-zoom" ref={setZoomMenuSlot} />
          {connection && (
            <button type="button" className="cr-more-item" onClick={onConnection}>
              <PathBadge view={connection} />
              <span className="cr-more-label">Connection</span>
            </button>
          )}
          {onRouting && (
            <div className="cr-more-row" role="presentation">
              <RoutingEntry status={routeStatus} onOpen={onRouting} />
            </div>
          )}
          {/* ACTIVITY IS ONE CLICK FROM HERE (owner, 2026-11-07): it used to sit
              in the wall's footer, three clicks away, behind a screen that is
              not what someone opening their history came for. The wall keeps it
              too, for whoever is already there. */}
          {/* ACCOUNT AND SECURITY FROM THE DEVICES VIEW (owner 2026-11-10): on the console the
              account's own page is a row here, not a second home. It is the auth host's page. */}
          {accountPage !== null && (
            <a className="cr-more-item" href={accountPage}>
              <CrIcon name="lock" />
              <span className="cr-more-label">Account &amp; security</span>
            </a>
          )}
          <button type="button" className="cr-more-item" title="Activity and history" onClick={onActivity} aria-haspopup="dialog">
            <CrIcon name="summary" />
            <span className="cr-more-label">Activity…</span>
          </button>
          <button type="button" className="cr-more-item" onClick={onWall} aria-haspopup="dialog">
            <CrIcon name="canvas" />
            <span className="cr-more-label">Workspaces…</span>
          </button>
          <button
            type="button"
            className={`cr-more-item${sounds ? ' on' : ''}`}
            aria-pressed={sounds}
            title="A chime when an agent is done or needs you"
            onClick={() => setSoundsOn(!sounds)}
          >
            <CrIcon name="speaker" />
            <span className="cr-more-label">{sounds ? 'Sounds on' : 'Sounds off'}</span>
          </button>
          <button
            type="button"
            className="cr-more-item"
            aria-haspopup="dialog"
            title="The whole app's look, for every Mac and phone on your account"
            onClick={() => setSkinSheet(true)}
          >
            <CrIcon name="skin" />
            <span className="cr-more-label">Skin: {skinInfo(theme).name}…</span>
          </button>
          <button
            type="button"
            className={`cr-more-item${light !== 'hover' ? ' on' : ''}`}
            aria-pressed={light !== 'hover'}
            title="How the crew is lit: only the agent under the pointer, every agent its own peak, or one terrain"
            onClick={(e) => {
              // A switch to try the looks in turn: the menu stays open.
              e.stopPropagation()
              setFoldLight(FOLD_LIGHTS[(FOLD_LIGHTS.indexOf(light) + 1) % FOLD_LIGHTS.length])
            }}
          >
            <CrIcon name="dot" />
            <span className="cr-more-label">Agent light: {FOLD_LIGHT_NAMES[light]}</span>
          </button>
          <WatchPairRow
            onPair={() => {
              close()
              setPairingWatch(true)
            }}
          />
          <RemoteSwitchRow />
          {offerFullscreen && (
            <button
              type="button"
              className={`cr-more-item${fullscreen ? ' on' : ''}`}
              aria-pressed={fullscreen}
              title="Hide the browser's address bar and the phone's status and navigation bars"
              onClick={() => void toggleFullscreen(document)}
            >
              <CrIcon name="fullscreen" />
              <span className="cr-more-label">{fullscreen ? 'Exit full screen' : 'Full screen'}</span>
            </button>
          )}
          {update && <UpdateRows status={update} />}
          <TelemetryRow />
          <LaunchSettingsRow
            onOpen={() => {
              close()
              setLaunchSheet(true)
            }}
          />
          <button type="button" className="cr-more-item" onClick={onResync}>
            <CrIcon name="expand" />
            <span className="cr-more-label">Refresh</span>
          </button>
        </div>
      )}
    </div>
    {pairingWatch && <WatchPairSheet onClose={() => setPairingWatch(false)} />}
    {launchSheet && <LaunchSettingsSheet onClose={closeLaunchSheet} />}
    {skinSheet && <SkinSheet onClose={closeSkinSheet} />}
    </>
  )
}
