import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CrIcon } from '../icons'
import type { ConsoleParts } from './console-wiring'
import type { ConsoleMachine } from './console-devices'
import type { ConsoleView } from './console-navigator'
import type { GateState } from './console-gate'
import { consoleRoutePath } from './console-route'
import type { PathWord } from './machine-paths'
import { DevicesCanvas, type CanvasMachine } from '../zoom/DevicesCanvas'
import '../header.css'
import type { MachineView } from '../zoom/zoom-model'

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

/** A machine with nothing read from it: its frame, blank, with the one thing to do on its screen. */
const blankView = (machine: ConsoleMachine): MachineView => ({ id: machine.id, name: machine.name, local: false, online: machine.online, detail: 'listed', os: machine.os, workspaces: [], marks: [], agents: null, waiting: null })

/** Under its name: its platform and line, and how much it holds. */
function captionOf(machine: ConsoleMachine): string {
  const waiting = machine.counts?.waiting ?? 0
  return [
    underName(machine),
    machine.counts ? `${countOf(machine.workspaces.length, 'workspace')} · ${countOf(machine.counts.agents, 'agent')}` : null,
    waiting > 0 ? `${waiting} waiting` : null
  ].filter(Boolean).join(' · ')
}

const PATH_SAYS: Record<PathWord, string> = {
  LAN: 'Reached directly over this network',
  TAILNET: 'Reached over your tailnet',
  RELAY: 'Reached through the Cookrew relay'
}

/** Can it be gone into from here: a locked one can (its door asks for proof), one offline, outdated or blocked cannot. */
const openable = (machine: ConsoleMachine): boolean => machine.standing === 'locked' || machine.standing === 'reading' || machine.standing === 'live'

/**
 * Its screen: lit with its own tiles only when it is read (`live`); else the
 * one thing to do. Nothing of a machine is drawn before the gate opens.
 */
const sayOf = (machine: ConsoleMachine): string | null => machine.say ?? (machine.standing === 'live' ? null : machine.standing === 'locked' ? 'Prove it’s you to see inside.' : '…')

/** One machine on the canvas, as this page knows it. */
export function canvasMachineOf(machine: ConsoleMachine, path: PathWord): CanvasMachine {
  const reached = machine.standing === 'live' || machine.standing === 'reading'
  const say = sayOf(machine)
  return {
    view: say === null && machine.view ? machine.view : blankView(machine),
    say,
    caption: captionOf(machine),
    standing: machine.standing,
    openable: openable(machine),
    // How this page reaches it now. Only for one it does reach: one that cannot be read has no path to name.
    badge: reached ? (
      <span className="cd-path" data-path={path} title={PATH_SAYS[path]} aria-label={PATH_SAYS[path]}>
        {path}
      </span>
    ) : null
  }
}

/** "drej" → "DR", "ada lovelace" → "AL": the letters the app's avatar wears (account-store.ts · initialsOf). */
export function initialsOf(username: string): string {
  const words = username.trim().split(/[\s._-]+/).filter((w) => w.length > 0)
  if (words.length === 0) return '?'
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : words[0].slice(0, 2)).toUpperCase()
}

/**
 * THE TOP BAR, THE APP'S OWN (owner 2026-11-12: the top bar the same before
 * the password and after, the logo at its front). The Co, the route (here,
 * the account's devices: no machine is entered), and on the right the
 * account's avatar, its menu the way to the account and out. Inside a machine
 * the app's own bar stands in the same place (Header.tsx), so stepping in or
 * out changes what it says, never what it is.
 */
export function TopBar({ username, accountHref, onSignOut }: { username: string; accountHref: string; onSignOut: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return undefined
    const away = (e: Event): void => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', away, true)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', away, true)
    }
  }, [open])
  return (
    <header className="cr-header cd-bar">
      <span className="cr-mark" role="img" aria-label="Cookrew" />
      <nav className="cr-route" aria-label="Route">
        <span className="cr-route-step cr-route-device">
          <span className="cr-route-here" aria-current="page">
            <CrIcon name="device" />
            <span className="cr-route-label">Devices</span>
          </span>
        </span>
      </nav>
      <div className="cr-fn cd-acct" role="toolbar" aria-label="Functions" ref={box}>
        {/* The app's avatar, in a finger's box: the console holds its own controls to 40px. */}
        <button type="button" className="cd-acct-btn" title={`@${username}`} aria-label={`Account @${username}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
          <span className="cr-acct-avatar cr-acct-claimed" aria-hidden="true">
            <span className="cr-acct-initials">{initialsOf(username)}</span>
          </span>
        </button>
        {open && (
          <div className="cd-acct-menu" role="menu" aria-label={`@${username}`}>
            <span className="cd-user">@{username}</span>
            <a className="cd-quiet" role="menuitem" href={accountHref}>
              Account &amp; security
            </a>
            <button type="button" className="cd-quiet" role="menuitem" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
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
    <main className="cd-page cd-canvas-page">
      <TopBar username={username} accountHref={`${config.authOrigin}/account`} onSignOut={() => void runtime.signOut()} />
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
      <div className="cd-canvas">
        <DevicesCanvas
          machines={list.machines.map((machine) => canvasMachineOf(machine, paths.of(machine.id)))}
          openingId={openingId}
          onEnter={(id, workspace, side) => runtime.open(id, workspace, side)}
        />
        {openingId !== null && (
          <p className="cd-opening" role="status">
            Opening {list.machines.find((machine) => machine.id === openingId)?.name ?? 'your machine'}…
          </p>
        )}
      </div>
    </main>
  )
}
