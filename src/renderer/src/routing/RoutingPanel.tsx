import type { SetupRunning } from './setup-line-state'
import { useEffect, useState } from 'react'
import type { HarnessRow, RouteState } from '../../../shared/route'
import { ROUTING_COPY } from '../../../shared/route-view'
import { Accounts, Harnesses, LiveRoutes, Rented, SignInLink, StatusLine, type RunLine } from './RoutingSections'
import { SetupScreen } from './SetupScreen'
import './routing-panel.css'

/**
 * R1 · THE ROUTING PANEL — Magpie's Agents and Providers pages, inside Cookrew.
 *
 * One sheet over the stage with one status line, three sections and one row,
 * read from the gateway (`cookrew().routeState()`, pushed by `onRoute`).
 * Writes are never a Cookrew form: every button types one command line into
 * the Setup terminal card, whose live screen is folded under the sections,
 * and the status line re-reads by itself when the line has run. There is no
 * connect button — the plugin writes the file, or the probe finds the port.
 *
 * A menu entry in the header, and nothing more: Magpie is optional, so this
 * never opens by itself (round 2: it covered the first run, in red).
 */

export interface RoutingPanelProps {
  open: boolean
  onClose: () => void
  state: RouteState | null
  /** False on a bridge without the route methods. */
  available: boolean
  /** Type one line into the Setup card (use-setup-terminal). */
  onRun: RunLine
  /** The Setup card, once it exists — its screen is shown under the sections. */
  setupTerminalId: string | null
  /** Bumped when the screen should take focus (a key line was typed). */
  focusTick: number
  /** The Setup line still running, so its button says so and cannot be pressed twice. */
  running?: SetupRunning | null
  onSetDefault: (model: string | null) => void
  onSetSharedMcp?: (on: boolean) => void
  /** Why the last default pick or Setup line did nothing; one line under the status. */
  error?: string | null
  onAddToDock?: (harness: HarnessRow) => void
  /** Card names for the live rows. */
  names: ReadonlyMap<string, string>
  onZoom?: (terminalId: string) => void
  /** The person's own endpoint: where it is changed once the first run is over. */
  access?: React.ReactNode
}

export function RoutingPanel(props: RoutingPanelProps): React.JSX.Element | null {
  const { open, onClose, state, available, onRun, setupTerminalId, focusTick, onSetDefault, onSetSharedMcp, error, onAddToDock, names, onZoom, running = null } = props
  const [setupOpen, setSetupOpen] = useState(true)
  // A key line was typed: the fold opens so the paste has somewhere to land.
  useEffect(() => {
    if (focusTick > 0) setSetupOpen(true)
  }, [focusTick])
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="cr-routing" role="dialog" aria-modal="true" aria-label={ROUTING_COPY.title} onClick={onClose}>
      <div className="cr-routing-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cr-routing-title">
          ⇄ {ROUTING_COPY.title}
          <span className="sp" />
          <button type="button" className="cr-routing-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {!available || state === null ? (
          <div className="cr-routing-empty">
            <b>{available ? 'READING THE GATEWAY…' : 'NOT ON THIS BRIDGE'}</b>
            {available ? 'one moment' : 'this desktop does not answer for routing yet — update it'}
          </div>
        ) : (
          <>
            <StatusLine state={state} onRun={onRun} running={running} />
            <SignInLink running={running} />
            {error && (
              <div className="cr-routing-bad" role="alert">
                {error}
              </div>
            )}
            <Harnesses rows={state.harnesses} onRun={onRun} onAddToDock={onAddToDock} running={running} />
            <Accounts state={state} onRun={onRun} onSetDefault={onSetDefault} onSetSharedMcp={onSetSharedMcp} running={running} />
            <LiveRoutes state={state} names={names} onZoom={onZoom} />
            <Rented state={state} />
          </>
        )}
        {props.access}
        <details className="cr-routing-fold cr-routing-setup" open={setupOpen} onToggle={(e) => setSetupOpen((e.target as HTMLDetailsElement).open)}>
          <summary>▾ Setup terminal · every button above lands on one line here · the phone drives the same PTY</summary>
          <div>
            {setupTerminalId === null ? (
              <div className="cr-routing-hint">the Setup card appears on the canvas the first time a button needs it</div>
            ) : (
              <SetupScreen terminalId={setupTerminalId} focusTick={focusTick} />
            )}
          </div>
        </details>
      </div>
    </div>
  )
}

/** The header entry: a chip with the gateway's lamp, same weight as the workspace chip. */
export function RoutingEntry({ status, onOpen }: { status: RouteState['status'] | null; onOpen: () => void }): React.JSX.Element {
  const title =
    status === 'online' ? 'Routing — Magpie is on; models, accounts, live routes' : status === 'offline' ? 'Routing — Magpie is offline' : 'Routing — install Magpie to route models'
  return (
    <button type="button" className={`cr-routing-entry${status ? ` ${status}` : ''}`} onClick={onOpen} title={title} aria-haspopup="dialog">
      <span className="cr-routing-lamp" />
      <span className="word">Routing</span>
    </button>
  )
}
