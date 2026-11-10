/**
 * THE CONSOLE, WIRED: the session, the gate, the machines and the address,
 * and the one thing that follows from them, which machine (if any) is in
 * scope. console-navigator.ts decides; this carries the decision out and
 * listens for whatever would change it.
 *
 * Its parts are handed in (console-wiring.ts builds the real ones), so the
 * whole order of events runs in a test with no browser.
 */
import type { DeviceGrant } from '../../../shared/account-pair'
import type { CompleteResult, SessionState, StartResult } from './console-session'
import type { GateState } from './console-gate'
import type { ConsoleDevicesState } from './console-devices'
import { DEVICES_ROUTE, consoleRoutePath, parseConsoleRoute, type ConsoleRoute } from './console-route'
import { decideView, type ConsoleView, type DoorState } from './console-navigator'

/** What a machine's door said to this browser. */
export type DoorAnswer = { readonly kind: 'open' } | { readonly kind: 'needs-proof' } | { readonly kind: 'refused'; readonly message: string }

export interface RuntimeDeps {
  readonly session: {
    get(): SessionState
    subscribe(listener: () => void): () => void
    boot(): Promise<void>
    complete(back: { code: string | null; state: string | null; error: string | null }): Promise<CompleteResult>
    signIn(returnTo: string): Promise<StartResult>
    signOut(): Promise<void>
  }
  readonly gate: {
    get(): GateState
    subscribe(listener: () => void): () => void
    check(): Promise<void>
    took(grant: DeviceGrant): Promise<void>
    reproof(): Promise<void>
    forget(): void
  }
  readonly devices: {
    get(): ConsoleDevicesState
    subscribe(listener: () => void): () => void
    start(): () => void
    gateChanged(): void
  }
  readonly router: {
    get(): ConsoleRoute
    subscribe(listener: () => void): () => void
    go(route: ConsoleRoute): void
  }
  /** This browser into one machine: the key it holds for it, or its door entered with the pass. */
  readonly openDoor: (machineId: string) => Promise<DoorAnswer>
  /** Let go of this browser's key for one machine. */
  readonly forgetDoor: (machineId: string) => void
  /** Put a machine in scope, or none (machine-scope.ts · enterMachine). */
  readonly enterScope: (machineId: string | null) => void
  /** Stand on a workspace of the machine now in scope (device-seat.ts). */
  readonly takeSeat: (workspaceId: string) => void
  /** Signed out: every machine's key and seat this browser kept. */
  readonly forgetMachines: () => void
}

export interface RuntimeState {
  readonly view: ConsoleView
  /** One sentence over the machines: why the page is here and not where it was going. */
  readonly notice: string | null
}

export interface ConsoleRuntime {
  get(): RuntimeState
  subscribe(listener: () => void): () => void
  boot(): Promise<void>
  signIn(): Promise<StartResult>
  signOut(): Promise<void>
  /** Go to a machine (the Devices level's tile), optionally straight to one of its workspaces. */
  open(machineId: string, workspaceId?: string | null): void
  /** Back to the machines. */
  leave(): void
  /** The machine in scope no longer takes this browser's key. */
  keyRefused(machineId: string): void
  dismissNotice(): void
}

const CANCELLED = 'Cancelled.'

export function createConsoleRuntime(deps: RuntimeDeps): ConsoleRuntime {
  const listeners = new Set<() => void>()
  let state: RuntimeState = { view: { kind: 'starting' }, notice: null }
  let entered: string | null = null
  let door: DoorState | null = null
  let booted = false
  let stopDevices: (() => void) | null = null
  /** A machine whose door was re-asked because it refused the key: a second refusal is said, not retried. */
  let retried: string | null = null

  const tell = (view: ConsoleView, notice: string | null = state.notice): void => {
    if (JSON.stringify(view) === JSON.stringify(state.view) && notice === state.notice) return
    state = { view, notice }
    for (const listener of listeners) listener()
  }

  const leaveScope = (): void => {
    if (entered === null) return
    entered = null
    deps.enterScope(null)
  }

  const askDoor = (machineId: string): void => {
    door = { machine: machineId, state: 'asking' }
    void deps
      .openDoor(machineId)
      .catch((): DoorAnswer => ({ kind: 'refused', message: 'That machine is not answering.' }))
      .then((answer) => {
        // Answered for a door nobody is waiting at any more: it opens nothing.
        if (door?.machine !== machineId || door.state !== 'asking') return
        if (answer.kind === 'needs-proof') {
          door = null
          return void deps.gate.reproof().then(evaluate)
        }
        door = answer.kind === 'open' ? { machine: machineId, state: 'open' } : { machine: machineId, state: 'refused', message: answer.message }
        evaluate()
      })
  }

  function evaluate(): void {
    if (!booted) return
    // Each act changes what is known; decide again until there is nothing left to do.
    for (let turn = 0; turn < 8; turn += 1) {
      const route = deps.router.get()
      const { view, act } = decideView({ session: deps.session.get(), gate: deps.gate.get().status, route, devices: deps.devices.get(), entered, door })
      if (act.kind === 'none') {
        if (view.kind !== 'entering' && view.kind !== 'machine') door = door?.state === 'asking' ? null : door
        return tell(view)
      }
      if (act.kind === 'leave') {
        leaveScope()
        door = null
      } else if (act.kind === 'open-door') {
        askDoor(act.machine)
        return tell(view)
      } else if (act.kind === 'enter') {
        entered = act.machine
        deps.enterScope(act.machine)
        if (route.kind === 'machine' && route.workspace !== null) deps.takeSeat(route.workspace)
      } else {
        leaveScope()
        door = null
        state = { ...state, notice: act.notice }
        deps.router.go(DEVICES_ROUTE)
      }
    }
  }

  const onSession = (): void => {
    const signedIn = deps.session.get().status === 'signed-in'
    if (signedIn && stopDevices === null) {
      void deps.gate.check()
      stopDevices = deps.devices.start()
    }
    if (!signedIn && stopDevices !== null) {
      stopDevices()
      stopDevices = null
      leaveScope()
      door = null
      retried = null
      deps.gate.forget()
      deps.forgetMachines()
      deps.router.go(DEVICES_ROUTE)
    }
    evaluate()
  }

  return {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    boot: async () => {
      const first = deps.router.get()
      await deps.session.boot()
      if (first.kind === 'auth-complete') {
        const done = await deps.session.complete(first)
        if (done.ok && done.grant) await deps.gate.took(done.grant)
        if (!done.ok && done.message !== CANCELLED) state = { ...state, notice: done.message }
        const back = new URL(done.returnTo, 'https://console.invalid')
        deps.router.go(parseConsoleRoute(back.pathname, back.search))
      }
      booted = true
      deps.session.subscribe(onSession)
      deps.gate.subscribe(() => {
        deps.devices.gateChanged()
        evaluate()
      })
      deps.devices.subscribe(evaluate)
      deps.router.subscribe(evaluate)
      onSession()
      // Said even when nothing else changed (a notice from the way back).
      for (const listener of listeners) listener()
    },
    signIn: () => deps.session.signIn(consoleRoutePath(deps.router.get())),
    signOut: () => deps.session.signOut(),
    open: (machineId, workspaceId = null) => {
      retried = null
      state = { ...state, notice: null }
      deps.router.go({ kind: 'machine', machine: machineId, workspace: workspaceId, agent: null, side: 'agents' })
    },
    leave: () => deps.router.go(DEVICES_ROUTE),
    keyRefused: (machineId) => {
      if (entered !== machineId) return
      deps.forgetDoor(machineId)
      leaveScope()
      door = null
      if (retried === machineId) {
        const name = deps.devices.get().machines.find((machine) => machine.id === machineId)?.name ?? 'That machine'
        door = { machine: machineId, state: 'refused', message: `${name} did not let this browser in.` }
      }
      retried = machineId
      evaluate()
    },
    dismissNotice: () => tell(state.view, null)
  }
}
