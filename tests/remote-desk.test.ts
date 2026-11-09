// THE ONE PLACE THAT SAYS WHERE THIS MACHINE'S SCREEN STANDS, AND WHO MAY DRIVE IT.
// Everything here runs on fake lock, permission and session readers.
import { describe, expect, it, vi } from 'vitest'
import { createRemoteDesk, remoteGate, CONTROL_GRACE_MS, READY_WATCH_MS, STOP_HOLD_MS, WAKE_REST_MS, type RemoteDeskDeps, type RemoteSession } from '../src/main/remote-desk'
import { CONTROL_MS, LINUX_NO_XDOTOOL, MAC_VIEWER, type RemoteBuild, type ViewerWho } from '../src/shared/remote-access'
import { SERVED_USE_REFUSED } from '../src/main/use-commands'

const phone: ViewerWho = { key: 'device:p1', name: 'Pixel 9', here: false }
const tablet: ViewerWho = { key: 'device:t1', name: 'iPad', here: false }
const build: RemoteBuild = { settingsName: 'Electron', sourceBuild: true, restart: 'by-hand', agents: 'keep' }

function rig(over: Partial<RemoteDeskDeps> = {}, facts: Partial<RemoteSession> = {}) {
  let now = 1_000_000
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = []
  const session: { -readonly [K in keyof RemoteSession]: RemoteSession[K] } = { locked: false, displayAsleep: false, grant: true, ...facts }
  const access = { screen: 'granted', accessibility: true, waiting: null as string | null, holdUntil: 0, served: new Set<string>() }
  const records: Array<{ type: string; card: string; details: string | undefined }> = []
  const awake = { start: vi.fn(), stop: vi.fn() }
  const host = vi.fn()
  const refresh = vi.fn()
  const drop = vi.fn()
  const openSettings = vi.fn(() => Promise.resolve())
  const relaunch = vi.fn()
  const deps: RemoteDeskDeps = {
    platform: 'darwin',
    build: () => build,
    linuxRefusal: () => null,
    screenAccess: () => access.screen,
    accessibility: () => access.accessibility,
    session: async () => ({ ...session }),
    settings: {
      read: () => ({ waiting: access.waiting as never, holdUntil: access.holdUntil }),
      write: (next) => {
        access.waiting = next.waiting
        access.holdUntil = next.holdUntil
      }
    },
    servedWorkspace: (id) => access.served.has(id),
    workspaceOfCard: () => 'ws',
    cardName: (id) => `Card ${id}`,
    record: (type, card, _name, details) => records.push({ type, card, details }),
    keepAwake: awake,
    host,
    refreshCards: refresh,
    dropViewers: drop,
    openSettings,
    relaunch,
    now: () => now,
    schedule: (fn, ms) => {
      const timer = { at: now + ms, fn, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    ...over
  }
  const desk = createRemoteDesk(deps)
  const tick = (ms: number): void => {
    const end = now + ms
    for (;;) {
      const next = timers.filter((t) => !t.cancelled && t.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      next.cancelled = true
      now = next.at
      next.fn()
    }
    now = end
  }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  }
  return { desk, session, access, records, awake, host, refresh, drop, openSettings, relaunch, tick, flush, types: () => records.map((r) => r.type) }
}

describe('state', () => {
  it('reads ready when nothing stands in the way', async () => {
    const { desk } = rig()
    expect((await desk.state('here')).id).toBe('ready')
  })

  it('a lock outranks everything, and names what comes after it', async () => {
    const r = rig({}, { locked: true, grant: false })
    r.access.screen = 'denied'
    const state = await r.desk.state('away')
    expect(state.id).toBe('locked')
    expect(state.then).toBe('needs-screen-recording')
  })

  it('denied and no fresh grant needs Screen Recording', async () => {
    const r = rig({}, { grant: false })
    r.access.screen = 'denied'
    expect((await r.desk.state('here')).id).toBe('needs-screen-recording')
  })

  it('a fresh process seeing the grant while this one does not is a restart waiting', async () => {
    const r = rig({}, { grant: true })
    r.access.screen = 'denied'
    expect((await r.desk.state('here')).id).toBe('needs-restart')
  })

  it('an unreadable fresh answer does not claim a grant', async () => {
    const r = rig({}, { grant: null })
    r.access.screen = 'denied'
    expect((await r.desk.state('here')).id).toBe('needs-screen-recording')
  })

  it('a sleeping display is its own state, under the permissions', async () => {
    const r = rig({}, { displayAsleep: true })
    expect((await r.desk.state('here')).id).toBe('display-asleep')
    r.access.screen = 'denied'
    r.session.grant = false
    expect((await r.desk.state('here')).id).toBe('needs-screen-recording')
  })

  it('a machine with no screen source says so, with no button', async () => {
    const r = rig({ platform: 'win32' })
    expect((await r.desk.state('here')).id).toBe('unsupported')
  })

  it('Linux: Wayland is refused by name and the same lock states apply', async () => {
    const wayland = rig({ platform: 'linux', linuxRefusal: () => 'This Linux session runs Wayland' })
    const state = await wayland.desk.state('here')
    expect(state).toMatchObject({ id: 'unsupported', detail: 'This Linux session runs Wayland', platform: 'linux' })
    const locked = rig({ platform: 'linux' }, { locked: true })
    expect((await locked.desk.state('here')).id).toBe('locked')
    const asleep = rig({ platform: 'linux' }, { displayAsleep: true })
    expect((await asleep.desk.state('here')).id).toBe('display-asleep')
  })

  it('Linux never asks about macOS grants', async () => {
    const r = rig({ platform: 'linux', screenAccess: () => 'denied' })
    expect((await r.desk.state('here')).id).toBe('ready')
  })
})

describe('remoteGate: the desk as one card sees it', () => {
  it('binds the card, so a card can only ever ask about itself', async () => {
    const r = rig()
    r.desk.setSwitch(true)
    await r.desk.takeControl('c1', phone)
    expect(remoteGate(r.desk, 'c1').mayDrive(phone)).toBe(true)
    expect(remoteGate(r.desk, 'c2').mayDrive(phone)).toBe(false)
    const leave = remoteGate(r.desk, 'c1').enter('v', phone)
    expect(r.host).toHaveBeenLastCalledWith(expect.objectContaining({ rows: [expect.objectContaining({ card: 'c1' })] }))
    leave()
  })
})

describe('blocked: what a device asks before each frame', () => {
  it('answers nothing when the screen can be read', async () => {
    expect(await rig().desk.blocked()).toBeNull()
  })

  it('answers the state when it cannot', async () => {
    const r = rig({}, { locked: true })
    expect((await r.desk.blocked())?.id).toBe('locked')
  })

  it('after a failed capture, a grant the process still believes in is checked against a fresh one', async () => {
    const r = rig({}, { grant: false })
    expect(await r.desk.blocked()).toBeNull()
    expect((await r.desk.blocked({ afterFailure: true }))?.id).toBe('needs-screen-recording')
  })
})

describe('the machine switch', () => {
  const remembering = (held = false) => {
    const memory = { held, writes: [] as boolean[], read: () => memory.held, write: (on: boolean) => { memory.held = on; memory.writes.push(on) } }
    return memory
  }
  const up = () => ({ running: false, start() { this.running = true }, stop() { this.running = false } })

  it('stays on across a restart: the owner sets it once and then works from anywhere', () => {
    const memory = remembering()
    rig({ switchMemory: memory }).desk.setSwitch(true)
    expect(memory.writes).toEqual([true])
    const next = rig({ switchMemory: memory })
    expect(next.desk.controlFacts().switchOn).toBe(false)
    next.desk.restoreSwitch()
    expect(next.desk.controlFacts().switchOn).toBe(true)
    expect(next.desk.inputRefusal()).toBeNull()
  })

  it('off is remembered too, and a restart leaves it off', () => {
    const memory = remembering(true)
    const r = rig({ switchMemory: memory })
    r.desk.restoreSwitch()
    r.desk.setSwitch(false)
    expect(memory.held).toBe(false)
    const next = rig({ switchMemory: memory })
    next.desk.restoreSwitch()
    expect(next.desk.controlFacts().switchOn).toBe(false)
  })

  it('a restore is on the record, and names itself', () => {
    const r = rig({ switchMemory: remembering(true) })
    r.desk.restoreSwitch()
    expect(r.records).toContainEqual(expect.objectContaining({ type: 'remote.switch-on', details: 'restored at launch' }))
  })

  it('memory that cannot be read leaves it off', () => {
    const r = rig({ switchMemory: { read: () => { throw new Error('no key') }, write: () => undefined } })
    r.desk.restoreSwitch()
    expect(r.desk.controlFacts().switchOn).toBe(false)
  })

  it('still turns on for this run when it cannot be remembered, and says so', () => {
    const r = rig({ switchMemory: { read: () => false, write: () => { throw new Error('no key') } } })
    expect(r.desk.setSwitch(true)).toMatchObject({ ok: false, error: expect.stringContaining('next restart') })
    expect(r.desk.controlFacts().switchOn).toBe(true)
  })

  it('pressing off always clears what is kept, even when it already reads off', () => {
    const memory = remembering(true)
    const r = rig({ switchMemory: memory })
    expect(r.desk.controlFacts().switchOn).toBe(false)
    r.desk.setSwitch(false)
    expect(memory.held).toBe(false)
  })

  it('a door closed by wrong passwords stays closed across a restart', () => {
    const memory = remembering(true)
    const r = rig({ switchMemory: memory })
    r.desk.restoreSwitch()
    r.desk.forgetSwitch()
    expect(memory.held).toBe(false)
    expect(r.desk.controlFacts().switchOn).toBe(true)
    const next = rig({ switchMemory: memory })
    next.desk.restoreSwitch()
    expect(next.desk.controlFacts().switchOn).toBe(false)
  })

  it('pressing on again puts back what a closed door took away', () => {
    const memory = remembering(true)
    const r = rig({ switchMemory: memory })
    r.desk.restoreSwitch()
    r.desk.forgetSwitch()
    r.desk.setSwitch(true)
    expect(memory.held).toBe(true)
  })

  it('tells the host it is on, with nobody watching: the menu bar must show it', () => {
    const r = rig({ switchMemory: remembering(true) })
    r.desk.restoreSwitch()
    expect(r.desk.hostView()).toMatchObject({ rows: [], switchOn: true })
    expect(r.host).toHaveBeenLastCalledWith(expect.objectContaining({ switchOn: true }))
  })

  it('clears what is kept before anything that could fail on the way', () => {
    const memory = remembering(true)
    const r = rig({ switchMemory: memory, host: () => { throw new Error('tray') } })
    r.desk.restoreSwitch = r.desk.restoreSwitch
    expect(() => r.desk.setSwitch(false)).not.toThrow()
    expect(memory.held).toBe(false)
  })

  it('a Linux machine restores its switch the same way', () => {
    const r = rig({ platform: 'linux', switchMemory: remembering(true) })
    r.desk.restoreSwitch()
    expect(r.desk.controlFacts().switchOn).toBe(true)
  })

  it('a machine that cannot be driven at all (Wayland) restores nothing', () => {
    const r = rig({ platform: 'linux', linuxRefusal: () => 'This Linux session runs Wayland', switchMemory: remembering(true) })
    r.desk.restoreSwitch()
    expect(r.desk.controlFacts().switchOn).toBe(false)
  })

  it('keeps the Mac from sleeping while it is on, or a locked Mac drops off the network', () => {
    const stayUp = up()
    const r = rig({ stayUp })
    r.desk.setSwitch(true)
    expect(stayUp.running).toBe(true)
    r.desk.setSwitch(false)
    expect(stayUp.running).toBe(false)
  })

  it('a restored switch keeps it up as well', () => {
    const stayUp = up()
    rig({ stayUp, switchMemory: remembering(true) }).desk.restoreSwitch()
    expect(stayUp.running).toBe(true)
  })

  it('is off by default, and off means no viewer and no agent', async () => {
    const r = rig()
    expect(r.desk.controlFacts().switchOn).toBe(false)
    expect(r.desk.inputRefusal()).toMatch(/Remote control .* off/)
    expect((await r.desk.takeControl('c1', phone)).ok).toBe(false)
  })

  it('turning it on is an event and lets input through once a card is taken', async () => {
    const r = rig()
    r.desk.setSwitch(true)
    expect(r.types()).toContain('remote.switch-on')
    expect(r.desk.inputRefusal()).toBeNull()
    expect(r.desk.mayDrive('c1', phone)).toBe(false)
    expect((await r.desk.takeControl('c1', phone)).ok).toBe(true)
    expect(r.desk.mayDrive('c1', phone)).toBe(true)
  })

  it('turning it off ends every grant at once', async () => {
    const r = rig()
    r.desk.setSwitch(true)
    await r.desk.takeControl('c1', phone)
    r.desk.setSwitch(false)
    expect(r.desk.mayDrive('c1', phone)).toBe(false)
    expect(r.types()).toContain('remote.control-off')
    expect(r.types()).toContain('remote.switch-off')
    expect(r.refresh).toHaveBeenCalled()
  })

  it('turns off even if nothing could be written, because nothing is', () => {
    const r = rig()
    r.desk.setSwitch(true)
    r.desk.setSwitch(false)
    expect(r.desk.controlFacts().switchOn).toBe(false)
  })

  it('agents keep the rule they had: the switch, with Accessibility on top', () => {
    const r = rig()
    r.access.accessibility = false
    expect(r.desk.inputRefusal()).toMatch(/Remote control/)
    r.desk.setSwitch(true)
    expect(r.desk.inputRefusal()).toMatch(/Accessibility is off/)
    expect(r.desk.inputRefusal()).toContain('Electron')
  })

  it('a plain file cannot turn it on: only what the app itself sealed can', () => {
    const r = rig({ settings: { read: () => ({ on: true, waiting: null, holdUntil: 0 }) as never, write: () => undefined } })
    expect(r.desk.controlFacts().switchOn).toBe(false)
    expect(r.desk.inputRefusal()).toMatch(/Remote control/)
  })

  it('never writes itself to disk', () => {
    const write = vi.fn()
    const r = rig({ settings: { read: () => ({ waiting: null, holdUntil: 0 }), write } })
    r.desk.setSwitch(true)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('when the disk says no', () => {
  it('an unreadable file is no wait and no hold', async () => {
    const r = rig({ settings: { read: () => { throw new Error('garbled') }, write: () => undefined } })
    expect((await r.desk.state('away')).id).toBe('ready')
  })

  it('Stop holds even when it cannot be written down', () => {
    const r = rig({ settings: { read: () => ({ waiting: null, holdUntil: 0 }), write: () => { throw new Error('read-only disk') } } })
    r.desk.stopAll()
    expect(r.desk.admit('c1', phone)).toBeTruthy()
  })
})

describe('take control', () => {
  it('lasts fifteen minutes and is then off again, on its own', async () => {
    const r = rig()
    r.desk.setSwitch(true)
    await r.desk.takeControl('c1', phone)
    expect(r.desk.cardControl('c1', phone).until).toBeGreaterThan(0)
    r.tick(CONTROL_MS - 1000)
    expect(r.desk.mayDrive('c1', phone)).toBe(true)
    r.tick(1000)
    expect(r.desk.mayDrive('c1', phone)).toBe(false)
    expect(r.records.find((e) => e.type === 'remote.control-off')?.details).toContain('15 minutes')
    expect(r.refresh).toHaveBeenCalled()
  })

  it('belongs to one device: a second viewer of the card still only watches', async () => {
    const r = rig()
    r.desk.setSwitch(true)
    await r.desk.takeControl('c1', phone)
    expect(r.desk.mayDrive('c1', tablet)).toBe(false)
    expect(r.desk.cardControl('c1', tablet).heldBy).toBe('Pixel 9')
    const second = await r.desk.takeControl('c1', tablet)
    expect(second).toMatchObject({ ok: false })
  })

  it('per card: control of one card is not control of another', async () => {
    const r = rig()
    r.desk.setSwitch(true)
    await r.desk.takeControl('c1', phone)
    expect(r.desk.mayDrive('c2', phone)).toBe(false)
  })

  it('refuses without Accessibility, naming the state to show', async () => {
    const r = rig()
    r.desk.setSwitch(true)
    r.access.accessibility = false
    const answer = await r.desk.takeControl('c1', phone)
    expect(answer).toMatchObject({ ok: false, state: { id: 'needs-accessibility' } })
  })

  it('refuses on a locked Mac: control waits for the unlock, which has its own door', async () => {
    const r = rig({}, { locked: true })
    r.desk.setSwitch(true)
    const answer = await r.desk.takeControl('c1', phone)
    expect(answer).toMatchObject({ ok: false, state: { id: 'locked' } })
    expect((answer as { error: string }).error).toContain('Unlock it from here')
  })

  it('there is no control on Wayland, whatever the switch says', async () => {
    const r = rig({ platform: 'linux', linuxRefusal: () => 'This Linux session runs Wayland' })
    r.desk.setSwitch(true)
    expect(r.desk.controlFacts()).toMatchObject({ available: false, switchOn: false })
    const answer = await r.desk.takeControl('c1', phone)
    expect(answer).toMatchObject({ ok: false })
    expect((answer as { error: string }).error).toContain('Wayland')
    expect(r.desk.mayDrive('c1', phone)).toBe(false)
  })

  it('every grant and every end lands in the event log, with who', async () => {
    const r = rig()
    r.desk.setSwitch(true)
    await r.desk.takeControl('c1', phone)
    r.desk.endControl('c1', phone)
    const on = r.records.find((e) => e.type === 'remote.control-on')
    const off = r.records.find((e) => e.type === 'remote.control-off')
    expect(on?.details).toContain('Pixel 9')
    expect(off?.details).toContain('Pixel 9')
    expect(r.desk.mayDrive('c1', phone)).toBe(false)
  })

  it('another device cannot end someone else\'s control, the Mac can', async () => {
    const r = rig()
    r.desk.setSwitch(true)
    await r.desk.takeControl('c1', phone)
    r.desk.endControl('c1', tablet)
    expect(r.desk.mayDrive('c1', phone)).toBe(true)
    r.desk.endControl('c1', MAC_VIEWER)
    expect(r.desk.mayDrive('c1', phone)).toBe(false)
  })

  it('a viewer gone for good gives control back; a redial inside the grace keeps it', async () => {
    const r = rig()
    r.desk.setSwitch(true)
    const leave = r.desk.enter('c1', 'v1', phone)
    await r.desk.takeControl('c1', phone)
    leave()
    r.tick(CONTROL_GRACE_MS - 1000)
    const again = r.desk.enter('c1', 'v2', phone)
    r.tick(5000)
    expect(r.desk.mayDrive('c1', phone)).toBe(true)
    again()
    r.tick(CONTROL_GRACE_MS)
    expect(r.desk.mayDrive('c1', phone)).toBe(false)
  })
})

describe('take control of a Linux X11 machine', () => {
  const linux = (over: Partial<RemoteDeskDeps> = {}) => rig({ platform: 'linux', linuxInput: () => null, accessibility: () => false, ...over })

  it('the switch exists on Linux, off by default', async () => {
    const r = linux()
    expect(r.desk.controlFacts()).toMatchObject({ available: true, switchOn: false, accessibility: true })
    expect(r.desk.controlFacts().unlockWords).toBeUndefined()
    const answer = await r.desk.takeControl('c1', phone)
    expect(answer.ok).toBe(false)
    const said = (answer as { error: string }).error
    expect(said).toContain('cookrew remote on')
    expect(said).not.toMatch(/\bMac\b/)
  })

  it('switch on, then a grant for one device and one card, for 15 minutes', async () => {
    const r = linux()
    r.desk.setSwitch(true)
    expect(await r.desk.takeControl('c1', phone)).toEqual({ ok: true })
    expect(r.desk.mayDrive('c1', phone)).toBe(true)
    expect(r.desk.mayDrive('c1', tablet)).toBe(false)
    expect(r.desk.mayDrive('c2', phone)).toBe(false)
    expect(r.desk.cardControl('c1', phone)).toMatchObject({ switchOn: true, machine: 'linux', until: expect.any(Number) })
    expect(r.desk.cardControl('c1', tablet)).toMatchObject({ heldBy: 'Pixel 9' })
    r.tick(CONTROL_MS)
    expect(r.desk.mayDrive('c1', phone)).toBe(false)
  })

  it('the machine says who holds control', async () => {
    const r = linux()
    r.desk.setSwitch(true)
    r.desk.enter('c1', 'v1', phone)
    await r.desk.takeControl('c1', phone)
    expect(r.desk.hostView().rows).toEqual([expect.objectContaining({ who: 'Pixel 9', mode: 'controlling' })])
  })

  it('xdotool missing: the grant is refused in one sentence naming the fix, and agents hear it too', async () => {
    const r = linux({ linuxInput: () => LINUX_NO_XDOTOOL })
    r.desk.setSwitch(true)
    expect(r.desk.controlFacts().accessibility).toBe(false)
    expect(r.desk.inputRefusal()).toBe(LINUX_NO_XDOTOOL)
    expect(r.desk.agentRefusal()).toBe(LINUX_NO_XDOTOOL)
    const answer = await r.desk.takeControl('c1', phone)
    expect(answer).toMatchObject({ ok: false, error: LINUX_NO_XDOTOOL, state: { id: 'needs-accessibility', platform: 'linux' } })
  })

  it('served work is refused on Linux too', async () => {
    const r = linux()
    r.desk.setSwitch(true)
    r.access.served.add('ws')
    expect(await r.desk.takeControl('c1', phone)).toMatchObject({ ok: false, error: SERVED_USE_REFUSED })
    expect(r.desk.mayDrive('c1', phone)).toBe(false)
  })

  it('switch off ends every grant at once', async () => {
    const r = linux()
    r.desk.setSwitch(true)
    await r.desk.takeControl('c1', phone)
    r.desk.setSwitch(false)
    expect(r.desk.mayDrive('c1', phone)).toBe(false)
    expect(r.records.find((e) => e.type === 'remote.control-off')?.details).toContain('turned off at the machine')
  })

  it('Stop at the machine holds the door the same way', async () => {
    const r = linux()
    r.desk.setSwitch(true)
    await r.desk.takeControl('c1', phone)
    r.desk.stopAll()
    expect(r.desk.mayDrive('c1', phone)).toBe(false)
    expect((await r.desk.takeControl('c1', phone)).ok).toBe(false)
  })

  it('a Linux machine is still never unlocked from here', () => {
    const r = linux()
    r.desk.setSwitch(true)
    expect(r.desk.unlockRefusal(phone)).not.toBeNull()
  })
})

describe('served sessions and sandboxes', () => {
  it('never get control, whatever the switch says', async () => {
    const r = rig()
    r.desk.setSwitch(true)
    r.access.served.add('ws')
    expect((await r.desk.takeControl('c1', phone)).ok).toBe(false)
  })

  it('lose it the moment a workspace turns served', async () => {
    const r = rig()
    r.desk.setSwitch(true)
    await r.desk.takeControl('c1', phone)
    r.access.served.add('ws')
    expect(r.desk.mayDrive('c1', phone)).toBe(false)
  })

  it('cannot watch either', () => {
    const r = rig()
    r.access.served.add('ws')
    expect(r.desk.admit('c1', phone)?.message).toMatch(/served session/i)
    expect(r.desk.admit('c1', phone)?.state.id).toBe('unsupported')
  })
})

describe('the host: who is on this machine', () => {
  it('a viewer away from the Mac shows on the host, keeps it awake, and logs its start and stop', () => {
    const r = rig()
    const leave = r.desk.enter('c1', 'v1', phone)
    expect(r.host).toHaveBeenLastCalledWith(expect.objectContaining({ awake: true, rows: [expect.objectContaining({ who: 'Pixel 9', mode: 'watching', card: 'c1' })] }))
    expect(r.awake.start).toHaveBeenCalledTimes(1)
    expect(r.records.find((e) => e.type === 'remote.view-started')?.details).toContain('Pixel 9')
    leave()
    expect(r.host).toHaveBeenLastCalledWith(expect.objectContaining({ awake: false, rows: [] }))
    expect(r.awake.stop).toHaveBeenCalledTimes(1)
    expect(r.types()).toContain('remote.view-ended')
  })

  it('keeps the Mac awake only while watched: one hold however many viewers, released with the last', () => {
    const r = rig()
    const a = r.desk.enter('c1', 'v1', phone)
    const b = r.desk.enter('c2', 'v2', tablet)
    expect(r.awake.start).toHaveBeenCalledTimes(1)
    a()
    expect(r.awake.stop).not.toHaveBeenCalled()
    b()
    expect(r.awake.stop).toHaveBeenCalledTimes(1)
  })

  it('the Mac watching its own card is not a remote session', () => {
    const r = rig()
    r.desk.enter('c1', 'v1', MAC_VIEWER)
    expect(r.awake.start).not.toHaveBeenCalled()
    expect(r.types()).not.toContain('remote.view-started')
  })

  it('leaving twice is one departure', () => {
    const r = rig()
    const leave = r.desk.enter('c1', 'v1', phone)
    leave()
    leave()
    expect(r.awake.stop).toHaveBeenCalledTimes(1)
    expect(r.types().filter((t) => t === 'remote.view-ended')).toHaveLength(1)
  })

  it('a row turns to controlling while the grant lasts', async () => {
    const r = rig()
    r.desk.setSwitch(true)
    r.desk.enter('c1', 'v1', phone)
    await r.desk.takeControl('c1', phone)
    expect(r.host).toHaveBeenLastCalledWith(expect.objectContaining({ rows: [expect.objectContaining({ mode: 'controlling' })] }))
  })

  it('an agent at work on the screen shows too, and goes when it goes quiet', () => {
    const r = rig()
    r.desk.setSwitch(true)
    r.desk.noteAgent('c1', 'Velvet', 'tap')
    expect(r.host).toHaveBeenLastCalledWith(expect.objectContaining({ rows: [expect.objectContaining({ who: 'Velvet', mode: 'controlling' })] }))
    expect(r.types()).toContain('remote.agent-started')
    r.tick(60_000)
    expect(r.host).toHaveBeenLastCalledWith(expect.objectContaining({ rows: [] }))
    expect(r.types()).toContain('remote.agent-ended')
  })

  it('Stop ends everything: viewers, grants, agents, and holds the door for a while', async () => {
    const r = rig()
    r.desk.setSwitch(true)
    r.desk.enter('c1', 'v1', phone)
    await r.desk.takeControl('c1', phone)
    r.desk.stopAll()
    expect(r.drop).toHaveBeenCalled()
    expect(r.desk.mayDrive('c1', phone)).toBe(false)
    expect(r.types()).toContain('remote.stopped')
    expect(r.desk.admit('c1', phone)).toBeTruthy()
    expect(r.desk.agentRefusal()).toMatch(/Stopped at the Mac/)
    expect((await r.desk.takeControl('c1', phone)).ok).toBe(false)
    r.tick(STOP_HOLD_MS)
    expect(r.desk.admit('c1', phone)).toBeNull()
    expect(r.desk.agentRefusal()).toBeNull()
  })

  it('Stop outlives a restart: the door stays held until its time', () => {
    const r = rig()
    r.desk.stopAll()
    const holdUntil = r.access.holdUntil
    expect(holdUntil).toBeGreaterThan(0)
    const again = rig({ settings: { read: () => ({ waiting: null, holdUntil }), write: () => undefined } })
    expect(again.desk.admit('c1', phone)).toBeTruthy()
  })

  it('a stopped device gets no pictures, no restart, no settings page and no wake', async () => {
    const r = rig({ build: () => ({ ...build, restart: 'self' }) }, { grant: true })
    r.access.screen = 'denied'
    r.desk.stopAll()
    expect(r.desk.picturesRefused(phone)).toMatch(/Stopped at the Mac/)
    expect(r.desk.picturesRefused(MAC_VIEWER)).toBeNull()
    expect((await r.desk.restart(phone)).ok).toBe(false)
    expect(r.relaunch).not.toHaveBeenCalled()
    expect((await r.desk.openSettings('screen', 'away')).ok).toBe(false)
    expect(r.openSettings).not.toHaveBeenCalled()
    expect((await r.desk.wake(phone)).ok).toBe(false)
  })

  it('Stop leaves the Mac able to use its own card', async () => {
    const r = rig()
    r.desk.setSwitch(true)
    await r.desk.takeControl('c1', MAC_VIEWER)
    r.desk.stopAll()
    expect(r.desk.inputRefusal()).toBeNull()
    expect((await r.desk.takeControl('c1', MAC_VIEWER)).ok).toBe(true)
    expect(r.desk.mayDrive('c1', MAC_VIEWER)).toBe(true)
  })

  it('Stop never locks the Mac out of its own card', () => {
    const r = rig()
    r.desk.stopAll()
    expect(r.desk.admit('c1', MAC_VIEWER)).toBeNull()
  })

  it('a viewer away from the Mac reads Stopped, with when', async () => {
    const r = rig()
    r.desk.stopAll()
    const state = await r.desk.state('away')
    expect(state.id).toBe('stopped')
    expect(state.until).toBeGreaterThan(0)
    expect((await r.desk.state('here')).id).toBe('ready')
  })
})

describe('away from the Mac', () => {
  it('opening settings from away opens it on the Mac and remembers to say when it is ready', async () => {
    const r = rig({}, { grant: false })
    r.access.screen = 'denied'
    expect((await r.desk.openSettings('screen', 'away')).ok).toBe(true)
    expect(r.openSettings).toHaveBeenCalledWith('screen')
    expect((await r.desk.state('away')).waiting).toBe(true)
    r.session.grant = true
    r.access.screen = 'granted'
    r.tick(READY_WATCH_MS)
    await r.flush()
    expect(r.types()).toContain('remote.ready')
    expect((await r.desk.state('away')).waiting).toBe(false)
  })

  it('says the grant was seen when a restart is still to come', async () => {
    const r = rig({}, { grant: false })
    r.access.screen = 'denied'
    await r.desk.openSettings('screen', 'away')
    r.session.grant = true
    r.tick(READY_WATCH_MS)
    await r.flush()
    expect(r.types()).toContain('remote.restart-needed')
    expect(r.types()).not.toContain('remote.ready')
  })

  it('opening settings at the Mac waits for nothing', async () => {
    const r = rig({}, { grant: false })
    r.access.screen = 'denied'
    await r.desk.openSettings('screen', 'here')
    expect((await r.desk.state('here')).waiting).toBe(false)
  })

  it('a wait survives the restart it was waiting for', async () => {
    const r = rig({ settings: { read: () => ({ waiting: 'screen', holdUntil: 0 }), write: () => undefined } }, { grant: true })
    r.desk.start()
    r.tick(0)
    await r.flush()
    expect(r.types()).toContain('remote.ready')
  })
})

describe('restart', () => {
  const able = (): RemoteBuild => ({ ...build, restart: 'self' })

  it('relaunches a build that can, when a restart is what the Mac is waiting for, and logs it', async () => {
    const r = rig({ build: able }, { grant: true })
    r.access.screen = 'denied'
    expect((await r.desk.restart(phone)).ok).toBe(true)
    expect(r.relaunch).toHaveBeenCalled()
    expect(r.records.find((e) => e.type === 'remote.restart')?.details).toContain('Pixel 9')
  })

  it('from away it is refused when nothing is waiting on it: this is not a remote kill switch', async () => {
    const r = rig({ build: able })
    expect((await r.desk.restart(phone)).ok).toBe(false)
    expect(r.relaunch).not.toHaveBeenCalled()
  })

  it('refuses in words on a build that cannot', async () => {
    const r = rig({}, { grant: true })
    r.access.screen = 'denied'
    const answer = await r.desk.restart(MAC_VIEWER)
    expect(answer.ok).toBe(false)
    expect(r.relaunch).not.toHaveBeenCalled()
  })
})

describe('what ends a grant at once', () => {
  it('a card replaced or deleted: the next window is not what control was given over', async () => {
    const r = rig()
    r.desk.setSwitch(true)
    await r.desk.takeControl('c1', phone)
    r.desk.cardGone('c1')
    expect(r.desk.mayDrive('c1', phone)).toBe(false)
    expect(r.types()).toContain('remote.control-off')
  })

  it('a device forgotten: its grant goes and its viewers are shut out', async () => {
    const r = rig()
    r.desk.setSwitch(true)
    r.desk.enter('c1', 'v1', phone)
    await r.desk.takeControl('c1', phone)
    r.desk.forgetDevice(phone.key)
    expect(r.desk.mayDrive('c1', phone)).toBe(false)
    expect(r.drop).toHaveBeenCalledWith(['c1'])
  })

  it('the pairing token rotated: everyone on the old one is out', async () => {
    const root: ViewerWho = { key: 'root', name: 'A paired device', here: false }
    const r = rig()
    r.desk.setSwitch(true)
    r.desk.enter('c1', 'v1', root)
    await r.desk.takeControl('c1', root)
    r.desk.forgetDevice('root')
    expect(r.desk.mayDrive('c1', root)).toBe(false)
    expect(r.drop).toHaveBeenCalledWith(['c1'])
  })

  it('a workspace turning served: grants end and viewers are dropped, not only masked', async () => {
    const r = rig()
    r.desk.setSwitch(true)
    r.desk.enter('c1', 'v1', phone)
    await r.desk.takeControl('c1', phone)
    r.desk.workspaceServed('ws')
    expect(r.drop).toHaveBeenCalledWith(['c1'])
    expect(r.types()).toContain('remote.control-off')
    r.access.served.clear()
    expect(r.desk.mayDrive('c1', phone)).toBe(false)
  })
})

describe('a hold written by anyone else', () => {
  it('can never be longer than Stop itself', () => {
    const r = rig({ settings: { read: () => ({ waiting: null, holdUntil: 9_000_000_000_000 }), write: () => undefined } })
    r.tick(STOP_HOLD_MS)
    expect(r.desk.admit('c1', phone)).toBeNull()
  })
})

describe('a sleeping display', () => {
  it('can be woken from away, and looks again', async () => {
    const wakeDisplay = vi.fn(async () => undefined)
    const r = rig({ wakeDisplay }, { displayAsleep: true })
    expect((await r.desk.wake(phone)).ok).toBe(true)
    expect(wakeDisplay).toHaveBeenCalled()
    expect(r.types()).toContain('remote.woke')
  })

  it('cannot be held awake from away by waking it over and over', async () => {
    const wakeDisplay = vi.fn(async () => undefined)
    const r = rig({ wakeDisplay }, { displayAsleep: true })
    await r.desk.wake(phone)
    await r.desk.wake(phone)
    expect(wakeDisplay).toHaveBeenCalledTimes(1)
    r.tick(WAKE_REST_MS)
    await r.desk.wake(phone)
    expect(wakeDisplay).toHaveBeenCalledTimes(2)
  })

  it('a locked Mac is not woken for nothing', async () => {
    const wakeDisplay = vi.fn(async () => undefined)
    const r = rig({ wakeDisplay }, { locked: true, displayAsleep: true })
    expect((await r.desk.wake(phone)).ok).toBe(false)
    expect(wakeDisplay).not.toHaveBeenCalled()
  })
})

describe('a wait that was answered twice', () => {
  it('says Ready once', async () => {
    const r = rig({ settings: { read: () => ({ waiting: 'screen', holdUntil: 0 }), write: () => undefined } }, { grant: true })
    r.desk.sessionChanged()
    r.desk.sessionChanged()
    r.tick(0)
    await r.flush()
    expect(r.types().filter((t) => t === 'remote.ready')).toHaveLength(1)
  })
})

describe('who may type a password at the lock screen', () => {
  const phone = { key: 'device:p', name: 'Phone', here: false }

  it('a paired device, with the switch on', () => {
    const r = rig()
    r.desk.setSwitch(true)
    expect(r.desk.unlockRefusal(phone)).toBeNull()
  })

  it('never with the switch off: only someone at the Mac turns that on', () => {
    expect(rig().desk.unlockRefusal(phone)).toContain('Remote control of this Mac is off')
  })

  it('not the Mac’s own window', () => {
    const r = rig()
    r.desk.setSwitch(true)
    expect(r.desk.unlockRefusal({ key: 'mac', name: 'This Mac', here: true })).toContain('at the Mac')
  })

  it('not after Stop', () => {
    const r = rig()
    r.desk.setSwitch(true)
    r.desk.stopAll()
    expect(r.desk.unlockRefusal(phone)).not.toBeNull()
  })

  it('not on Linux', () => {
    expect(rig({ platform: 'linux' }).desk.unlockRefusal(phone)).not.toBeNull()
  })
})

