import { describe, expect, it, vi } from 'vitest'
import { createConsoleRuntime, type DoorAnswer, type RuntimeDeps } from '../src/renderer/src/console/console-runtime'
import type { ConsoleDevicesState, ConsoleMachine } from '../src/renderer/src/console/console-devices'
import type { GateState } from '../src/renderer/src/console/console-gate'
import type { SessionState } from '../src/renderer/src/console/console-session'
import type { ConsoleRoute } from '../src/renderer/src/console/console-route'
import type { DeviceGrant } from '../src/shared/account-pair'

/**
 * THE CONSOLE, WIRED: the session, the gate, the machines and the address,
 * and the one thing that follows from them, which machine (if any) is in
 * scope. Each case drives the parts and looks at what was put in scope, what
 * door was asked, and what the page says.
 */

const M = '11111111-1111-4111-8111-111111111111'
const N = '22222222-2222-4222-8222-222222222222'
const W = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const DEVICES: ConsoleRoute = { kind: 'devices' }
const at = (machine = M, workspace: string | null = null): ConsoleRoute => ({ kind: 'machine', machine, workspace, agent: null, side: 'agents' })

const machine = (id: string, standing: ConsoleMachine['standing'] = 'live', say: string | null = null): ConsoleMachine => ({ id, name: id === M ? 'Studio Mac' : 'Solis', os: 'darwin', online: true, lastSeenAt: 1, standing, say, workspaces: [], counts: null })

function store<T>(start: T): { get: () => T; set: (next: T) => void; subscribe: (listener: () => void) => () => void } {
  let value = start
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next) => {
      value = next
      listeners.forEach((listener) => listener())
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }
  }
}

interface World {
  deps: RuntimeDeps
  session: ReturnType<typeof store<SessionState>>
  gate: ReturnType<typeof store<GateState>>
  devices: ReturnType<typeof store<ConsoleDevicesState>>
  route: ReturnType<typeof store<ConsoleRoute>>
  scope: (string | null)[]
  doors: { machine: string; answer: (answer: DoorAnswer) => void }[]
  seats: string[]
  log: string[]
  completes: { ok: boolean; returnTo: string; grant?: DeviceGrant; message?: string }
  registryReachable: boolean
  /** What the gate finds when it looks at its pass again. */
  passHeld: boolean
}

const world = (start: { route?: ConsoleRoute; session?: SessionState; gate?: GateState; machines?: ConsoleMachine[] } = {}): World => {
  const session = store<SessionState>(start.session ?? { status: 'signed-in', username: 'drej' })
  const gate = store<GateState>(start.gate ?? { status: 'open', until: 9e15 })
  const devices = store<ConsoleDevicesState>({ status: 'ready', machines: start.machines ?? [machine(M), machine(N)], error: null })
  const route = store<ConsoleRoute>(start.route ?? DEVICES)
  const w: World = {
    session,
    gate,
    devices,
    route,
    scope: [],
    doors: [],
    seats: [],
    log: [],
    completes: { ok: true, returnTo: '/' },
    registryReachable: true,
    passHeld: true,
    deps: {
      session: {
        get: session.get,
        subscribe: session.subscribe,
        boot: async () => void w.log.push('boot'),
        complete: async () => {
          w.log.push('complete')
          return w.completes.ok
            ? { ok: true as const, intent: w.completes.grant ? ('grant' as const) : ('sign-in' as const), returnTo: w.completes.returnTo, ...(w.completes.grant ? { grant: w.completes.grant } : {}) }
            : { ok: false as const, intent: 'sign-in' as const, returnTo: w.completes.returnTo, message: w.completes.message ?? 'no' }
        },
        signIn: async (returnTo) => (w.log.push(`sign-in ${returnTo}`), { ok: true as const }),
        signOut: async () => {
          w.log.push('sign-out')
          session.set({ status: 'signed-out' })
          return { ended: w.registryReachable }
        }
      },
      gate: {
        get: gate.get,
        subscribe: gate.subscribe,
        check: async () => {
          w.log.push('gate-check')
          if (!w.passHeld && gate.get().status === 'open') gate.set({ status: 'closed', ways: { passkey: true, password: true }, line: null, busy: false })
        },
        took: async (grant) => void w.log.push(`took ${grant.grant}`),
        forget: () => {
          w.log.push('gate-forget')
          gate.set({ status: 'unknown' })
        }
      },
      devices: {
        get: devices.get,
        subscribe: devices.subscribe,
        start: () => (w.log.push('devices-start'), () => void w.log.push('devices-stop')),
        gateChanged: () => void w.log.push('gate-changed')
      },
      router: {
        get: route.get,
        subscribe: route.subscribe,
        go: (next) => route.set(next)
      },
      openDoor: (id) => new Promise<DoorAnswer>((answer) => void w.doors.push({ machine: id, answer })),
      forgetDoor: (id) => void w.log.push(`forget-door ${id}`),
      enterScope: (id) => void w.scope.push(id),
      takeSeat: (workspace) => void w.seats.push(workspace),
      forgetMachines: () => void w.log.push('forget-machines')
    }
  }
  return w
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

describe('opening the page', () => {
  it('signed in at the machines: the gate is checked, the machines are read, nothing is in scope', async () => {
    const w = world()
    const runtime = createConsoleRuntime(w.deps)
    await runtime.boot()
    expect(runtime.get().view).toEqual({ kind: 'devices', wants: null })
    expect(w.log).toEqual(['boot', 'gate-check', 'devices-start'])
    expect(w.scope).toEqual([])
    expect(w.doors).toEqual([])
  })

  it('signed out: the way in, and nothing asked of the registry about machines', async () => {
    const w = world({ session: { status: 'signed-out' } })
    const runtime = createConsoleRuntime(w.deps)
    await runtime.boot()
    expect(runtime.get().view).toEqual({ kind: 'sign-in' })
    // And nothing a sign-in that ended while the page was away left behind is kept: no pass, no machine's key.
    expect(w.log.filter((line) => line !== 'gate-changed')).toEqual(['boot', 'gate-forget', 'forget-machines'])
    expect(w.log).not.toContain('devices-start')
    await runtime.signIn()
    expect(w.log.at(-1)).toBe('sign-in /')
  })

  it('signing in from an address that names a machine comes back to it', async () => {
    const w = world({ session: { status: 'signed-out' }, route: at(M, W) })
    const runtime = createConsoleRuntime(w.deps)
    await runtime.boot()
    await runtime.signIn()
    expect(w.log.at(-1)).toBe(`sign-in /d/${M}/w/${W}`)
  })

  it('back from the auth host signed in: goes where it was going', async () => {
    const w = world({ route: { kind: 'auth-complete', code: 'c', state: 's', error: null } })
    w.completes = { ok: true, returnTo: `/d/${M}` }
    const runtime = createConsoleRuntime(w.deps)
    await runtime.boot()
    expect(w.log.slice(0, 2)).toEqual(['boot', 'complete'])
    expect(w.route.get()).toEqual(at(M))
  })

  it('back from the auth host with a pass: the gate takes it', async () => {
    const w = world({ route: { kind: 'auth-complete', code: 'c', state: 's', error: null } })
    w.completes = { ok: true, returnTo: '/', grant: { grant: 'a-pass', exp: 1, deviceId: 'd' } }
    const runtime = createConsoleRuntime(w.deps)
    await runtime.boot()
    expect(w.log).toContain('took a-pass')
    expect(w.route.get()).toEqual(DEVICES)
  })

  it('back from the auth host with nothing: says why, at the machines or the way in', async () => {
    const w = world({ route: { kind: 'auth-complete', code: null, state: 's', error: 'x' } })
    w.completes = { ok: false, returnTo: `/d/${M}`, message: 'That did not finish. Try again.' }
    const runtime = createConsoleRuntime(w.deps)
    await runtime.boot()
    expect(runtime.get().notice).toBe('That did not finish. Try again.')
    runtime.dismissNotice()
    expect(runtime.get().notice).toBeNull()
  })
})

describe('entering a machine', () => {
  it('asks its door, and puts it in scope only when the door opens', async () => {
    const w = world()
    const runtime = createConsoleRuntime(w.deps)
    await runtime.boot()
    runtime.open(M)
    expect(w.route.get()).toEqual(at(M))
    expect(runtime.get().view).toEqual({ kind: 'entering', machine: M })
    expect(w.doors.map((door) => door.machine)).toEqual([M])
    expect(w.scope).toEqual([])
    w.doors[0].answer({ kind: 'open' })
    await settle()
    expect(w.scope).toEqual([M])
    expect(runtime.get().view).toEqual({ kind: 'machine', machine: M })
  })

  it('at an address that names a workspace, stands on that workspace from the first request', async () => {
    const w = world({ route: at(M, W) })
    const runtime = createConsoleRuntime(w.deps)
    await runtime.boot()
    w.doors[0].answer({ kind: 'open' })
    await settle()
    expect(w.scope).toEqual([M])
    expect(w.seats).toEqual([W])
  })

  it('a door that refuses: back at the machines with its words, nothing in scope', async () => {
    const w = world({ route: at(M) })
    const runtime = createConsoleRuntime(w.deps)
    await runtime.boot()
    w.doors[0].answer({ kind: 'refused', from: 'machine', message: 'Remote access is off on this Mac.' })
    await settle()
    expect(w.scope).toEqual([])
    expect(w.route.get()).toEqual(DEVICES)
    // Said as the machine's words, under the name the registry knows it by: a machine does not get to speak as the page.
    expect(runtime.get()).toMatchObject({ view: { kind: 'devices', wants: null }, notice: 'Studio Mac says: Remote access is off on this Mac.' })
  })

  it('a machine’s words are cut to a sentence’s length; the page’s own are said as they are', async () => {
    const w = world({ route: at(M) })
    const runtime = createConsoleRuntime(w.deps)
    await runtime.boot()
    w.doors[0].answer({ kind: 'refused', from: 'machine', message: `Your session expired. ${'Sign in again at a place of my choosing. '.repeat(20)}` })
    await settle()
    expect((runtime.get().notice ?? '').length).toBeLessThanOrEqual('Studio Mac says: '.length + 161)
    runtime.open(N)
    w.doors[1].answer({ kind: 'refused', from: 'page', message: 'This browser keeps nothing for this page.' })
    await settle()
    expect(runtime.get().notice).toBe('This browser keeps nothing for this page.')
  })

  it('no pass held after all: the gate looks again, closes, and keeps where the page was going', async () => {
    const w = world({ route: at(M) })
    const runtime = createConsoleRuntime(w.deps)
    await runtime.boot()
    w.passHeld = false
    w.doors[0].answer({ kind: 'needs-proof' })
    await settle()
    expect(w.log.filter((line) => line === 'gate-check')).toHaveLength(2)
    expect(w.log).not.toContain('gate-forget')
    expect(w.scope).toEqual([])
    expect(runtime.get().view).toEqual({ kind: 'devices', wants: M })
    // Proved again: the same machine's door is asked again.
    w.gate.set({ status: 'open', until: 9e15 })
    await settle()
    expect(w.doors.map((door) => door.machine)).toEqual([M, M])
  })

  it('one machine asking for a new proof while the pass is good does not close the gate for the others', async () => {
    const w = world({ route: at(M) })
    const runtime = createConsoleRuntime(w.deps)
    await runtime.boot()
    // The pass is still held: this is one machine's answer, not the account's.
    w.doors[0].answer({ kind: 'needs-proof' })
    await settle()
    expect(w.gate.get().status).toBe('open')
    expect(w.log).not.toContain('gate-forget')
    expect(w.doors).toHaveLength(1)
    expect(w.route.get()).toEqual(DEVICES)
    expect(runtime.get().notice).toBe('Studio Mac did not take this browser’s pass.')
  })

  it('a door answered after the page went elsewhere opens nothing', async () => {
    const w = world({ route: at(M) })
    const runtime = createConsoleRuntime(w.deps)
    await runtime.boot()
    runtime.leave()
    w.doors[0].answer({ kind: 'open' })
    await settle()
    expect(w.scope).toEqual([])
    expect(runtime.get().view).toEqual({ kind: 'devices', wants: null })
  })

  it('from one machine to another: the first is left before the second’s door is asked', async () => {
    const w = world({ route: at(M) })
    const runtime = createConsoleRuntime(w.deps)
    await runtime.boot()
    w.doors[0].answer({ kind: 'open' })
    await settle()
    runtime.open(N)
    expect(w.scope).toEqual([M, null])
    expect(w.doors.map((door) => door.machine)).toEqual([M, N])
    w.doors[1].answer({ kind: 'open' })
    await settle()
    expect(w.scope).toEqual([M, null, N])
  })
})

describe('inside a machine', () => {
  const inside = async (): Promise<{ w: World; runtime: ReturnType<typeof createConsoleRuntime> }> => {
    const w = world({ route: at(M) })
    const runtime = createConsoleRuntime(w.deps)
    await runtime.boot()
    w.doors[0].answer({ kind: 'open' })
    await settle()
    return { w, runtime }
  }

  it('leaving takes it out of scope and shows the machines', async () => {
    const { w, runtime } = await inside()
    runtime.leave()
    expect(w.scope).toEqual([M, null])
    expect(w.route.get()).toEqual(DEVICES)
    expect(runtime.get().view).toEqual({ kind: 'devices', wants: null })
  })

  it('the machine no longer taking this browser’s key: its door is asked again, once, and then it is said', async () => {
    const { w, runtime } = await inside()
    runtime.keyRefused(M)
    expect(w.log).toContain(`forget-door ${M}`)
    expect(w.scope).toEqual([M, null])
    expect(w.doors.map((door) => door.machine)).toEqual([M, M])
    w.doors[1].answer({ kind: 'open' })
    await settle()
    expect(w.scope).toEqual([M, null, M])
    // Refused again at once: no third try, the person is told.
    runtime.keyRefused(M)
    await settle()
    expect(w.doors).toHaveLength(2)
    expect(w.route.get()).toEqual(DEVICES)
    expect(runtime.get().notice).toBe('Studio Mac did not let this browser in.')
  })

  it('the gate closing takes the page out of the machine', async () => {
    const { w, runtime } = await inside()
    w.gate.set({ status: 'closed', ways: { passkey: true, password: true }, line: null, busy: false })
    await settle()
    expect(w.scope).toEqual([M, null])
    expect(runtime.get().view).toEqual({ kind: 'devices', wants: M })
  })

  it('the machine going off its line takes the page out of it, saying so', async () => {
    const { w, runtime } = await inside()
    w.devices.set({ status: 'ready', machines: [machine(M, 'offline', 'Open Cookrew on Studio Mac.'), machine(N)], error: null })
    await settle()
    expect(w.scope).toEqual([M, null])
    expect(runtime.get()).toMatchObject({ view: { kind: 'devices', wants: null }, notice: 'Open Cookrew on Studio Mac.' })
  })
})

describe('signing out', () => {
  it('leaves the machine, forgets the pass and every machine’s key, and stops reading', async () => {
    const w = world({ route: at(M) })
    const runtime = createConsoleRuntime(w.deps)
    await runtime.boot()
    w.doors[0].answer({ kind: 'open' })
    await settle()
    await runtime.signOut()
    await settle()
    expect(w.scope).toEqual([M, null])
    expect(w.log).toEqual(expect.arrayContaining(['sign-out', 'gate-forget', 'forget-machines', 'devices-stop']))
    expect(runtime.get().view).toEqual({ kind: 'sign-in' })
    expect(w.route.get()).toEqual(DEVICES)
  })

  it('says so when the registry could not be told', async () => {
    const w = world()
    const runtime = createConsoleRuntime(w.deps)
    await runtime.boot()
    w.registryReachable = false
    await runtime.signOut()
    expect(runtime.get().view).toEqual({ kind: 'sign-in' })
    expect(runtime.get().notice).toContain('could not be reached')
  })

  it('the registry ending the session does the same', async () => {
    const w = world()
    const runtime = createConsoleRuntime(w.deps)
    await runtime.boot()
    w.session.set({ status: 'signed-out' })
    await settle()
    expect(w.log).toEqual(expect.arrayContaining(['gate-forget', 'forget-machines', 'devices-stop']))
    expect(runtime.get().view).toEqual({ kind: 'sign-in' })
  })

  it('tells whoever draws it', async () => {
    const w = world()
    const runtime = createConsoleRuntime(w.deps)
    const heard = vi.fn()
    runtime.subscribe(heard)
    await runtime.boot()
    expect(heard).toHaveBeenCalled()
  })
})
