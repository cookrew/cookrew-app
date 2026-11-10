import { useEffect, useSyncExternalStore } from 'react'
import type { ConsoleParts } from './console-wiring'
import type { ConsoleMachine } from './console-devices'
import type { ConsoleView } from './console-navigator'
import type { GateState } from './console-gate'
import { consoleRoutePath } from './console-route'
import type { PathWord } from './machine-paths'

/**
 * THE ACCOUNT'S MACHINES. Each is drawn as a machine: a frame, a screen, its
 * name under it. Before the gate the screens are blank: a name, a platform
 * and whether it is online are all the page knows. Past it each screen lights
 * with that machine's own workspaces, and a machine that cannot be read says
 * the one thing to do instead.
 */

const PLATFORM: Record<string, string> = { darwin: 'Mac', linux: 'Linux', win32: 'Windows' }

const underName = (machine: ConsoleMachine): string => [PLATFORM[machine.os ?? ''] ?? null, machine.online ? 'online' : 'offline'].filter(Boolean).join(' · ')

const countOf = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

const PATH_SAYS: Record<PathWord, string> = {
  LAN: 'Reached directly over this network',
  TAILNET: 'Reached over your tailnet',
  RELAY: 'Reached through the Cookrew relay'
}

function MachineTile({ machine, path, opening, onOpen }: { machine: ConsoleMachine; path: PathWord; opening: boolean; onOpen: (workspace?: string) => void }): React.JSX.Element {
  const canOpen = machine.standing === 'locked' || machine.standing === 'reading' || machine.standing === 'live'
  const waiting = machine.counts?.waiting ?? 0
  return (
    <li className="cd-tile" data-standing={machine.standing} data-opening={opening || undefined}>
      <div className="cd-frame">
        <button type="button" className="cd-open" disabled={!canOpen} aria-label={canOpen ? `Open ${machine.name}` : `${machine.name}: ${machine.say ?? 'cannot be opened'}`} onClick={() => onOpen()} />
        <div className="cd-screen">
          {machine.standing === 'live' &&
            machine.workspaces.slice(0, 6).map((workspace) => (
              <button
                type="button"
                key={workspace.id}
                className="cd-ws"
                aria-label={`Open ${workspace.name} on ${machine.name}: ${countOf(workspace.agents, 'agent')}${workspace.waiting > 0 ? `, ${workspace.waiting} waiting` : ''}`}
                onClick={() => onOpen(workspace.id)}
              >
                <span className="cd-ws-name">{workspace.name}</span>
                <span className="cd-ws-count">{workspace.agents}</span>
                {workspace.waiting > 0 && <i className="cd-ws-wait" aria-hidden="true" />}
              </button>
            ))}
          {machine.standing === 'live' && machine.workspaces.length === 0 && <span className="cd-none">no workspaces</span>}
          {machine.standing === 'live' && machine.workspaces.length > 6 && <span className="cd-none">+{machine.workspaces.length - 6} more</span>}
          {machine.standing === 'reading' && <span className="cd-none">…</span>}
        </div>
        <span className="cd-deck" aria-hidden="true" />
      </div>
      <div className="cd-label">
        <b>
          {machine.name}
          {/* How this page reaches it now. Only for a machine it does reach: one that cannot be read has no path to name. */}
          {(machine.standing === 'live' || machine.standing === 'reading') && (
            <span className="cd-path" data-path={path} title={PATH_SAYS[path]} aria-label={PATH_SAYS[path]}>
              {path}
            </span>
          )}
        </b>
        <small>
          {underName(machine)}
          {machine.counts ? ` · ${countOf(machine.workspaces.length, 'workspace')} · ${countOf(machine.counts.agents, 'agent')}` : ''}
          {waiting > 0 ? ` · ${waiting} waiting` : ''}
        </small>
        {machine.say && <em>{machine.say}</em>}
      </div>
    </li>
  )
}

function Gate({ gate, state, wants, returnTo }: { gate: ConsoleParts['gate']; state: Extract<GateState, { status: 'closed' }>; wants: string | null; returnTo: string }): React.JSX.Element {
  return (
    <section className="cd-gate" aria-label="Prove it is you">
      <p>
        Prove it’s you once to see inside your machines{wants ? `, and ${wants} opens` : ''}. It lasts twelve hours on this browser.
      </p>
      <div className="cd-gate-ways">
        {state.ways?.passkey && (
          <button type="button" className="cd-primary" disabled={state.busy} onClick={() => void gate.withPasskey()}>
            Use a passkey
          </button>
        )}
        {state.ways?.password && (
          <button type="button" className={state.ways.passkey ? 'cd-quiet' : 'cd-primary'} disabled={state.busy} onClick={() => void gate.withPassword(returnTo)}>
            Use the account password
          </button>
        )}
        {state.ways === null && (
          <button type="button" className="cd-quiet" disabled={state.busy} onClick={() => void gate.check()}>
            Try again
          </button>
        )}
      </div>
      {state.line && (
        <p className="cd-line" role="status">
          {state.line}
        </p>
      )}
    </section>
  )
}

export function ConsoleDevicesView({ parts, view, notice, username }: { parts: ConsoleParts; view: Extract<ConsoleView, { kind: 'devices' | 'entering' }>; notice: string | null; username: string }): React.JSX.Element {
  const { devices, gate, runtime, router, config, paths } = parts
  useSyncExternalStore(paths.subscribe, paths.version, paths.version)
  const list = useSyncExternalStore(devices.subscribe, devices.get, devices.get)
  const gateState = useSyncExternalStore(gate.subscribe, gate.get, gate.get)
  // On screen: each readable machine is asked for its own summary, and asked again, until this is gone.
  useEffect(() => devices.watch(), [devices])

  const wantsId = view.kind === 'devices' ? view.wants : null
  const wantsName = wantsId ? (list.machines.find((machine) => machine.id === wantsId)?.name ?? null) : null
  const openingId = view.kind === 'entering' ? view.machine : null

  return (
    <main className="cd-page" data-entering={openingId !== null || undefined}>
      <header className="cd-head">
        <h1 className="cd-mark">Cookrew</h1>
        <nav className="cd-who" aria-label="Account">
          <span className="cd-user">@{username}</span>
          <a className="cd-quiet" href={`${config.authOrigin}/account`}>
            Account &amp; security
          </a>
          <button type="button" className="cd-quiet" onClick={() => void runtime.signOut()}>
            Sign out
          </button>
        </nav>
      </header>
      {notice && (
        <p className="cd-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="cd-quiet" onClick={() => runtime.dismissNotice()} aria-label="Dismiss">
            ×
          </button>
        </p>
      )}
      {gateState.status === 'closed' && <Gate gate={gate} state={gateState} wants={wantsName} returnTo={consoleRoutePath(router.get())} />}
      {list.error && (
        <p className="cd-line" role="status">
          {list.error}
        </p>
      )}
      {list.status === 'ready' && list.machines.length === 0 && <p className="cd-empty">No machines yet. Install Cookrew on a computer and sign in to this account there.</p>}
      <ul className="cd-grid">
        {list.machines.map((machine) => (
          <MachineTile key={machine.id} machine={machine} path={paths.of(machine.id)} opening={machine.id === openingId} onOpen={(workspace) => runtime.open(machine.id, workspace ?? null)} />
        ))}
      </ul>
      {openingId !== null && (
        <p className="cd-opening" role="status">
          Opening {list.machines.find((machine) => machine.id === openingId)?.name ?? 'your machine'}…
        </p>
      )}
    </main>
  )
}
