import { describe, expect, it } from 'vitest'
import { decideView, type NavigatorInput } from '../src/renderer/src/console/console-navigator'
import type { ConsoleMachine } from '../src/renderer/src/console/console-devices'
import type { ConsoleRoute } from '../src/renderer/src/console/console-route'

/**
 * WHAT THE CONSOLE SHOWS, decided in one place from what it knows: is anyone
 * signed in, is the gate open, what does the address name, and can that
 * machine be entered. The rule that matters: NO MACHINE IS IN SCOPE, and so
 * nothing is asked of it or drawn from it, until the person is signed in, the
 * gate is open, the machine is one of the account's that can be read, and its
 * own door has let this browser in.
 */

const M = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const at = (machine = M): ConsoleRoute => ({ kind: 'machine', machine, workspace: null, agent: null, side: 'agents' })
const DEVICES: ConsoleRoute = { kind: 'devices' }

const machine = (id: string, standing: ConsoleMachine['standing'], say: string | null = null): ConsoleMachine => ({
  id,
  name: 'Studio Mac',
  os: 'darwin',
  online: standing !== 'offline',
  lastSeenAt: 1,
  standing,
  say,
  workspaces: [],
  counts: null,
  view: null
})

const input = (over: Partial<NavigatorInput> = {}): NavigatorInput => ({
  session: { status: 'signed-in', username: 'drej' },
  gate: 'open',
  route: at(),
  devices: { status: 'ready', machines: [machine(M, 'live')], error: null },
  entered: null,
  door: null,
  ...over
})

describe('nobody signed in', () => {
  it('shows the way in, whatever the address names, and no machine is in scope', () => {
    expect(decideView(input({ session: { status: 'signed-out' } }))).toEqual({ view: { kind: 'sign-in' }, act: { kind: 'none' } })
    expect(decideView(input({ session: { status: 'signed-out' }, entered: M }))).toEqual({ view: { kind: 'sign-in' }, act: { kind: 'leave' } })
  })

  it('shows nothing yet while the page is still finding out', () => {
    expect(decideView(input({ session: { status: 'starting' } })).view).toEqual({ kind: 'starting' })
  })
})

describe('signed in, at the machines', () => {
  // THE DEVICES LEVEL ENTERS NO MACHINE (owner 2026-11-12): every machine a peer on the console's own canvas.
  it('is the Devices level, past the gate too, and asks no door', () => {
    expect(decideView(input({ route: DEVICES }))).toEqual({ view: { kind: 'devices', wants: null }, act: { kind: 'none' } })
    expect(decideView(input({ route: DEVICES, door: { machine: M, state: 'open' } }))).toEqual({ view: { kind: 'devices', wants: null }, act: { kind: 'none' } })
  })

  it('leaves the machine it was in', () => {
    expect(decideView(input({ route: DEVICES, entered: M }))).toEqual({ view: { kind: 'devices', wants: null }, act: { kind: 'leave' } })
  })

  it('before the gate: the Devices level of the page, and the machine it was in is left', () => {
    expect(decideView(input({ route: DEVICES, gate: 'closed' }))).toEqual({ view: { kind: 'devices', wants: null }, act: { kind: 'none' } })
    expect(decideView(input({ route: DEVICES, gate: 'closed', entered: M }))).toEqual({ view: { kind: 'devices', wants: null }, act: { kind: 'leave' } })
  })

  it('before the gate: the Devices level, remembering where it was going, and no machine in scope', () => {
    for (const gate of ['closed', 'unknown'] as const) {
      expect(decideView(input({ gate }))).toEqual({ view: { kind: 'devices', wants: M }, act: { kind: 'none' } })
    }
    // The gate closing under a machine that was open takes the page out of it.
    expect(decideView(input({ gate: 'closed', entered: M }))).toEqual({ view: { kind: 'devices', wants: M }, act: { kind: 'leave' } })
  })

  it('past the gate, while the account’s machines are still being read: wait, and enter nothing', () => {
    expect(decideView(input({ devices: { status: 'loading', machines: [], error: null } }))).toEqual({ view: { kind: 'entering', machine: M }, act: { kind: 'none' } })
  })

  it('a machine that can be read: its door is asked, once', () => {
    expect(decideView(input())).toEqual({ view: { kind: 'entering', machine: M }, act: { kind: 'open-door', machine: M } })
    expect(decideView(input({ door: { machine: M, state: 'asking' } }))).toEqual({ view: { kind: 'entering', machine: M }, act: { kind: 'none' } })
    // A machine being read for the first time is entered too: its summary is not what lets a browser in.
    expect(decideView(input({ devices: { status: 'ready', machines: [machine(M, 'reading')], error: null } })).act).toEqual({ kind: 'open-door', machine: M })
  })

  it('its door open: the machine is entered, and then shown', () => {
    expect(decideView(input({ door: { machine: M, state: 'open' } }))).toEqual({ view: { kind: 'entering', machine: M }, act: { kind: 'enter', machine: M } })
    expect(decideView(input({ door: { machine: M, state: 'open' }, entered: M }))).toEqual({ view: { kind: 'machine', machine: M }, act: { kind: 'none' } })
  })

  it('a door that was opened for another machine opens nothing here', () => {
    expect(decideView(input({ door: { machine: OTHER, state: 'open' } })).act).toEqual({ kind: 'open-door', machine: M })
  })

  it('its door refused: back to the machines, with the door’s own words', () => {
    expect(decideView(input({ door: { machine: M, state: 'refused', message: 'Remote access is off on this Mac.' } }))).toEqual({
      view: { kind: 'devices', wants: null },
      act: { kind: 'back', notice: 'Remote access is off on this Mac.' }
    })
  })

  it('a machine that cannot be read: back to the machines, with the one thing to do', () => {
    for (const [standing, say] of [
      ['offline', 'Open Cookrew on Studio Mac.'],
      ['outdated', 'Update Cookrew on Studio Mac.'],
      ['blocked', 'Studio Mac is not answering.']
    ] as const) {
      expect(decideView(input({ devices: { status: 'ready', machines: [machine(M, standing, say)], error: null } }))).toEqual({
        view: { kind: 'devices', wants: null },
        act: { kind: 'back', notice: say }
      })
    }
  })

  it('a machine that goes off its line while it is open takes the page out of it, saying so', () => {
    expect(decideView(input({ entered: M, door: { machine: M, state: 'open' }, devices: { status: 'ready', machines: [machine(M, 'offline', 'Open Cookrew on Studio Mac.')], error: null } }))).toEqual({
      view: { kind: 'devices', wants: null },
      act: { kind: 'back', notice: 'Open Cookrew on Studio Mac.' }
    })
  })

  it('a machine that is not one of this account’s: back to the machines', () => {
    expect(decideView(input({ route: at(OTHER) }))).toEqual({ view: { kind: 'devices', wants: null }, act: { kind: 'back', notice: 'That machine is not one of this account’s.' } })
  })

  it('another machine named while one is open: the open one is left first', () => {
    const devices = { status: 'ready' as const, machines: [machine(M, 'live'), machine(OTHER, 'live')], error: null }
    expect(decideView(input({ route: at(OTHER), entered: M, door: { machine: M, state: 'open' }, devices }))).toEqual({ view: { kind: 'entering', machine: OTHER }, act: { kind: 'leave' } })
  })

  it('the registry unreachable on the way in: wait at the machines with what it says, entering nothing', () => {
    expect(decideView(input({ devices: { status: 'failed', machines: [], error: 'not answering' } }))).toEqual({ view: { kind: 'devices', wants: M }, act: { kind: 'none' } })
  })
})
