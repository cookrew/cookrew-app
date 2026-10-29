import { useState } from 'react'
import { isDemoMode, isRemoteMode } from './api'
import { HeaderMore } from './HeaderMore'
import { HeaderRoute } from './HeaderRoute'
import { CrIcon } from './icons'
import { levelsRoute } from './levels/levels-history'
import { LocalNetworkRow } from './LocalNetworkRow'
import { CompanionAvatar, PathSheet, usePathBadge } from './PathBadge'
import type { RouteStatus } from '../../shared/route'
import './header.css'

/**
 * What the window shows: the STAGE (stage/StageView.tsx) — levels, canvas and
 * board merged into one (2026-10-30). The other three are DEPRECATED: kept
 * reachable from the More menu, not developed further.
 */
export type MainView = 'stage' | 'levels' | 'canvas' | 'agents'

interface HeaderProps {
  workspaceName: string
  dir: string
  terminalCount: number
  busyCount: number
  attentionCount: number
  /** Which view the stage is showing — drives the pressed state of the switch. */
  view: MainView
  onViewChange: (view: MainView) => void
  /**
   * Opens the screen wall (WorkspaceWall.tsx) — switching, making, managing
   * and removing workspaces, and the activity history, all live behind it.
   */
  onWall: () => void
  /**
   * Opens the Routing panel (routing/RoutingPanel.tsx) — Magpie's models,
   * accounts and live routes inside Cookrew. Null status = not read yet.
   */
  onRouting?: () => void
  routeStatus?: RouteStatus | null
  /** Re-pull the canvas and re-establish the push channel. */
  onResync: () => void
  /** The agent whose terminal the canvas has zoomed into (or the stage shows): the route's last step. */
  zoomedAgent?: string | null
  /** The stage's agent's workspace, which need not be the canvas's. */
  stageWorkspace?: string | null
  /**
   * The account avatar (identity v2, D1), or null where there is no account
   * surface — the phone companion and the demo tab feature-detect to nothing.
   * Passed in rather than rendered here so the header stays a bar and the
   * identity state lives in src/renderer/src/account.
   */
  avatar?: React.ReactNode
}

/**
 * THE ONE BAR. Two halves:
 *
 *   left  — the ROUTE (HeaderRoute.tsx): device / workspace / agent, each
 *           step a way out to its level.
 *   right — the FUNCTION BAR: the More menu (HeaderMore.tsx, which also
 *           holds the deprecated views) and the avatar; a way back to the
 *           stage while one of those views is up.
 *
 * It replaces a bar that put everything on one line in the order it was
 * added — mark, path badge, avatar, switch, status, routing lamp, workspace
 * chip. Whatever is neither a way to move nor a button to press now lives
 * behind ⋯, and each row there opens the sheet its chip used to. A zoomed
 * terminal keeps its own head: the bar only names it.
 *
 * Attention lives on the stage's faces now (the rose ones). The account's
 * waiting devices ride the avatar, which is why the avatar stays on the bar.
 */
export function Header({
  workspaceName,
  dir,
  terminalCount,
  busyCount,
  attentionCount,
  view,
  onViewChange,
  onWall,
  onRouting,
  routeStatus,
  onResync,
  zoomedAgent = null,
  stageWorkspace = null,
  avatar
}: HeaderProps): React.JSX.Element {
  const remote = isRemoteMode()
  const path = usePathBadge()
  const [pathOpen, setPathOpen] = useState(false)

  return (
    <header className="cr-header">
      <HeaderRoute
        view={view}
        workspaceName={workspaceName}
        dir={dir}
        path={path}
        zoomedAgent={zoomedAgent}
        stageWorkspace={stageWorkspace}
        onViewChange={onViewChange}
      />
      <div className="cr-fn" role="toolbar" aria-label="Functions">
        {/* The stage is the view; the three it merged are deprecated and live
            in the More menu. Away on one of them, the way back is on the bar. */}
        {view !== 'stage' && (
          <button type="button" className="cr-fn-stage" title="Back to the stage" onClick={() => onViewChange('stage')}>
            <CrIcon name="prev" />
            <span>Stage</span>
          </button>
        )}
        <HeaderMore
          view={view}
          onViewChange={onViewChange}
          attentionCount={attentionCount}
          busyCount={busyCount}
          terminalCount={terminalCount}
          connection={remote ? path : null}
          onConnection={() => {
            // Both, in this order: the refresh is what the badge's tap did and
            // the reader expects it at once; the sheet explains what they just
            // refreshed.
            onResync()
            setPathOpen(true)
          }}
          onRouting={onRouting}
          routeStatus={routeStatus ?? null}
          onWall={onWall}
          onFind={view === 'levels' ? levelsRoute.requestFind : undefined}
          onResync={onResync}
          demo={isDemoMode()}
        />
        {avatar}
        {remote && <CompanionAvatar />}
      </div>
      {/* UNDER the bar, not inside the menu: the local-network ask has to be
          visible without a tap, because a permission nobody knows to look for
          is a permission nobody grants. It renders nothing in three of the
          four states, so on most phones the bar is exactly as it is. */}
      {remote && <LocalNetworkRow />}
      {pathOpen && <PathSheet view={path} onClose={() => setPathOpen(false)} />}
    </header>
  )
}
