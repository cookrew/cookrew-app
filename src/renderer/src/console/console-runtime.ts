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
import type { CompleteResult, SessionState, SignOutResult, StartResult } from './console-session'
import type { GateState } from './console-gate'
import type { ConsoleDevicesState } from './console-devices'
import { DEVICES_ROUTE, consoleRoutePath, parseConsoleRoute, type ConsoleRoute } from './console-route'
import { decideView, type ConsoleView, type DoorState } from './console-navigator'

/**
 * What came of asking a machine's door. `needs-proof`: it wants a pass this
 * browser may no longer hold. `refused` says who is speaking: the machine (its
 * sentence is its own, and is shown as its own) or this page.
 */
export type DoorAnswer =
  | { readonly kind: 'open' }
  | { readonly kind: 'needs-proof' }
  | { readonly kind: 'refused'; readonly from: 'machine' | 'page'; readonly message: string }

/** A machine's sentence, cut to a sentence's length: it is shown on the console's own page. */
export const MACHINE_WORDS_MAX = 160
export const UNTOLD_SIGN_OUT =
  'Signed out on this browser. Cookrew’s registry could not be reached to end the sign-in, so this browser’s key was erased instead.'

export interface RuntimeDeps {
  readonly session: {
    get(): SessionState
    subscribe(listener: () => void): () => void
    boot(): Promise<void>
    complete(back: { code: string | null; state: string | null; error: string | null }): Promise<CompleteResult>
    signIn(returnTo: string): Promise<StartResult>
    signOut(): Promise<SignOutResult>
  }
  readonly gate: {
    get(): GateState
    subscribe(listener: () => void): () => void
    check(): Promise<void>
    took(grant: DeviceGrant): Promise<void>
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
  readonly now?: () => number
}

/** A key refused again this soon after its door was re-asked is a machine saying no, not a key that aged out. */
export const RETRY_WINDOW_MS = 60_000

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
  const now = deps.now ?? Date.now
  /** The machine whose door was last re-asked because it refused the key, and when. */
  let retried: { machine: string; at: number } | null = null
  /** `evaluate` is running; a change heard meanwhile is decided on its next turn, not inside this one. */
  let deciding = false
  let again = false

  const tell = (view: ConsoleView, notice: string | null = state.notice): void => {
    if (JSON.stringify(view) === JSON.stringify(state.view) && notice === state.notice) return
    state = { view, notice }
    for (const listener of listeners) listener()
  }

  /**
   * Take the machine out of scope. ITS DOOR IS FORGOTTEN FIRST: letting go makes the view write
   * its level back into the address at once (console/zoom-sync.ts), and anything decided on that
   * with the door still marked open would "enter" a machine that is on its way out.
   */
  const leaveScope = (): void => {
    door = null
    if (entered === null) return
    entered = null
    deps.enterScope(null)
  }

  /** The name the REGISTRY knows a machine by: a machine does not name itself on this page. */
  const nameOf = (machineId: string): string => deps.devices.get().machines.find((machine) => machine.id === machineId)?.name ?? 'That machine'

  const askDoor = (machineId: string): void => {
    door = { machine: machineId, state: 'asking' }
    const waiting = (): boolean => door?.machine === machineId && door.state === 'asking'
    void deps
      .openDoor(machineId)
      .catch((): DoorAnswer => ({ kind: 'refused', from: 'page', message: `${nameOf(machineId)} is not answering.` }))
      .then(async (answer) => {
        // Answered for a door nobody is waiting at any more: it opens nothing.
        if (!waiting()) return
        if (answer.kind === 'needs-proof') {
          // The gate looks at its pass again. With none it closes, and the page waits there for a
          // proof. With one still held this is ONE machine's answer: said, and the gate stays
          // open for the others (a machine cannot take the pass from the rest).
          await deps.gate.check().catch(() => undefined)
          if (!waiting()) return
          door = deps.gate.get().status === 'open' ? { machine: machineId, state: 'refused', message: `${nameOf(machineId)} did not take this browser’s pass. Sign out and in to prove it’s you again.` } : null
          return evaluate()
        }
        if (answer.kind === 'open') door = { machine: machineId, state: 'open' }
        else {
          const said = answer.from === 'machine' ? `${nameOf(machineId)} says: ${answer.message.slice(0, MACHINE_WORDS_MAX)}` : answer.message
          door = { machine: machineId, state: 'refused', message: said }
        }
        evaluate()
      })
  }

  function evaluate(): void {
    if (!booted) return
    // ONE DECISION AT A TIME. The acts below tell others (the router, the scope), who tell this
    // back in the same breath; decided inside the act that caused it, a half-made change would be
    // decided on. It is noted and decided when this turn is done.
    if (deciding) {
      again = true
      return
    }
    deciding = true
    let failure: unknown = null
    try {
      do {
        again = false
        try {
          decide()
        } catch (error) {
          // Somebody told by an act threw: what was heard meanwhile is still decided.
          failure ??= error
        }
      } while (again)
    } finally {
      deciding = false
    }
    if (failure !== null) throw failure
  }

  function decide(): void {
    // Each act changes what is known; decide again until there is nothing left to do.
    for (let turn = 0; turn < 8; turn += 1) {
      const route = deps.router.get()
      const { view, act } = decideView({ session: deps.session.get(), gate: deps.gate.get().status, route, devices: deps.devices.get(), entered, door })
      if (act.kind === 'none') {
        // A door still being asked for a machine the page is no longer going to: its answer will open nothing.
        if (view.kind !== 'entering' && view.kind !== 'machine' && door?.state === 'asking') door = null
        return tell(view)
      }
      if (act.kind === 'leave') leaveScope()
      else if (act.kind === 'open-door') {
        askDoor(act.machine)
        return tell(view)
      } else if (act.kind === 'enter') {
        entered = act.machine
        deps.enterScope(act.machine)
        if (route.kind === 'machine' && route.workspace !== null) deps.takeSeat(route.workspace)
      } else {
        leaveScope()
        state = { ...state, notice: act.notice }
        deps.router.go(DEVICES_ROUTE)
      }
    }
    // Not reached while each act settles something; if it ever is, the page still says where it stands.
    tell(decideView({ session: deps.session.get(), gate: deps.gate.get().status, route: deps.router.get(), devices: deps.devices.get(), entered, door }).view)
  }

  const onSession = (): void => {
    const status = deps.session.get().status
    if (status === 'signed-in' && stopDevices === null) {
      void deps.gate.check()
      stopDevices = deps.devices.start()
    }
    if (status === 'signed-out') {
      // WHENEVER NOBODY IS SIGNED IN, not only when somebody just signed out here: a sign-in that
      // ended while the page was away (a week unused, the device taken back) leaves the same
      // things behind, and the next person to sign in on this browser must not find them.
      const wasIn = stopDevices !== null
      stopDevices?.()
      stopDevices = null
      leaveScope()
      retried = null
      deps.gate.forget()
      deps.forgetMachines()
      if (wasIn) deps.router.go(DEVICES_ROUTE)
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
    signOut: async () => {
      const done = await deps.session.signOut()
      if (!done.ended) tell(state.view, UNTOLD_SIGN_OUT)
    },
    open: (machineId, workspaceId = null) => {
      retried = null
      tell(state.view, null)
      deps.router.go({ kind: 'machine', machine: machineId, workspace: workspaceId, agent: null, side: 'agents' })
    },
    leave: () => deps.router.go(DEVICES_ROUTE),
    keyRefused: (machineId) => {
      if (entered !== machineId) return
      deps.forgetDoor(machineId)
      const repeat = retried !== null && retried.machine === machineId && now() - retried.at < RETRY_WINDOW_MS
      retried = { machine: machineId, at: now() }
      leaveScope()
      // Asked again a moment ago and refused again: that is the machine's answer.
      if (repeat) door = { machine: machineId, state: 'refused', message: `${nameOf(machineId)} did not let this browser in.` }
      evaluate()
    },
    dismissNotice: () => tell(state.view, null)
  }
}
