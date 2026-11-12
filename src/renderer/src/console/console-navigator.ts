/**
 * WHAT THE CONSOLE SHOWS, decided in one place from what it knows. Pure: the
 * runtime (console-runtime.ts) feeds it and carries out the one act it names.
 *
 * THE RULE THAT MATTERS: no machine is in scope, and so nothing is asked of it
 * or drawn from it, until the person is signed in, the gate is open, the
 * machine is one of the account's that can be read, and its own door has let
 * this browser in. Anything else is the Devices level, with the one thing to
 * do said there.
 */
import type { SessionState } from './console-session'
import type { GateState } from './console-gate'
import type { ConsoleDevicesState } from './console-devices'
import type { ConsoleRoute } from './console-route'

export type ConsoleView =
  | { readonly kind: 'starting' }
  | { readonly kind: 'sign-in' }
  /** `wants`: the machine the address names, entered once the gate opens. */
  | { readonly kind: 'devices'; readonly wants: string | null }
  | { readonly kind: 'entering'; readonly machine: string }
  | { readonly kind: 'machine'; readonly machine: string }

export type NavigatorAct =
  | { readonly kind: 'none' }
  /** Take the machine in scope out of scope. */
  | { readonly kind: 'leave' }
  /** Ask this machine's door to let this browser in. */
  | { readonly kind: 'open-door'; readonly machine: string }
  /** Put this machine in scope. */
  | { readonly kind: 'enter'; readonly machine: string }
  /** Back to the machines (leaving any that is open), saying why. */
  | { readonly kind: 'back'; readonly notice: string }

export interface DoorState {
  readonly machine: string
  readonly state: 'asking' | 'open' | 'refused'
  readonly message?: string
}

export interface NavigatorInput {
  readonly session: SessionState
  readonly gate: GateState['status']
  readonly route: ConsoleRoute
  readonly devices: ConsoleDevicesState
  /** The machine in scope now. */
  readonly entered: string | null
  readonly door: DoorState | null
}

export const NOT_YOURS = 'That machine is not one of this account’s.'

const NONE: NavigatorAct = { kind: 'none' }

export function decideView(input: NavigatorInput): { view: ConsoleView; act: NavigatorAct } {
  const leaveOr = (act: NavigatorAct): NavigatorAct => (input.entered !== null ? { kind: 'leave' } : act)
  if (input.session.status === 'starting') return { view: { kind: 'starting' }, act: NONE }
  if (input.session.status === 'signed-out') return { view: { kind: 'sign-in' }, act: leaveOr(NONE) }
  // The Devices level enters no machine (owner 2026-11-12): every machine a peer on the console's own canvas.
  if (input.route.kind !== 'machine') return { view: { kind: 'devices', wants: null }, act: leaveOr(NONE) }
  const wanted = input.route.machine
  if (input.gate !== 'open') return { view: { kind: 'devices', wants: wanted }, act: leaveOr(NONE) }
  if (input.devices.status === 'failed') return { view: { kind: 'devices', wants: wanted }, act: leaveOr(NONE) }
  if (input.devices.status === 'loading') return { view: { kind: 'entering', machine: wanted }, act: NONE }
  const machine = input.devices.machines.find((one) => one.id === wanted)
  const back = (notice: string): { view: ConsoleView; act: NavigatorAct } => ({ view: { kind: 'devices', wants: null }, act: { kind: 'back', notice } })
  if (machine === undefined) return back(NOT_YOURS)
  if (machine.standing !== 'live' && machine.standing !== 'reading') return back(machine.say ?? `${machine.name} cannot be opened right now.`)
  // Checked before the one in scope is left: a machine chosen on its canvas that cannot be entered leaves nothing (review 2026-11-11).
  // One machine at a time: the one that is open is left before another is asked anything.
  if (input.entered !== null && input.entered !== wanted) return { view: { kind: 'entering', machine: wanted }, act: { kind: 'leave' } }
  const door = input.door?.machine === wanted ? input.door : null
  if (door === null) return { view: { kind: 'entering', machine: wanted }, act: { kind: 'open-door', machine: wanted } }
  if (door.state === 'asking') return { view: { kind: 'entering', machine: wanted }, act: NONE }
  if (door.state === 'refused') return back(door.message ?? `${machine.name} did not let this browser in.`)
  if (input.entered !== wanted) return { view: { kind: 'entering', machine: wanted }, act: { kind: 'enter', machine: wanted } }
  return { view: { kind: 'machine', machine: wanted }, act: NONE }
}
