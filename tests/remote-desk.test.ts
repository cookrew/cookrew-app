// THE ONE PLACE THAT SAYS WHERE THIS MACHINE'S SCREEN STANDS, AND WHO MAY DRIVE IT.
// Everything here runs on fake lock, permission and session readers.
import { describe, expect, it, vi } from 'vitest'
import { createRemoteDesk, CONTROL_GRACE_MS, READY_WATCH_MS, STOP_HOLD_MS, type RemoteDeskDeps, type RemoteSession } from '../src/main/remote-desk'
import { CONTROL_MS, MAC_VIEWER, type RemoteBuild, type ViewerWho } from '../src/shared/remote-access'

const phone: ViewerWho = { key: 'device:p1', name: 'Pixel 9', here: false }
const tablet: ViewerWho = { key: 'device:t1', name: 'iPad', here: false }
const build: RemoteBuild = { settingsName: 'Electron', sourceBuild: true, restart: 'by-hand', agents: 'keep' }

function rig(over: Partial<RemoteDeskDeps> = {}, facts: Partial<RemoteSession> = {}) {
  let now = 1_000_000
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = []
  const session: RemoteSession = { locked: false, displayAsleep: false, grant: true, ...facts }
  const access = { screen: 'granted', accessibility: true, on: false, waiting: null as string | null, served: new Set<string>() }
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
      read: () => ({ on: access.on, waiting: access.waiting as never }),
      write: (next) => {
        access.on = next.on
        access.waiting = next.waiting
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

  it('agents keep the rule they had: the switch, with Accessibility on top', () => {
    const r = rig()
    r.access.accessibility = false
    expect(r.desk.inputRefusal()).toMatch(/Remote control/)
    r.desk.setSwitch(true)
    expect(r.desk.inputRefusal()).toMatch(/Accessibility is off/)
    expect(r.desk.inputRefusal()).toContain('Electron')
  })

  it('remembers across a restart, and reads off when the file says nothing good', () => {
    const r = rig()
    r.access.on = true
    expect(createRemoteDesk({ ...rigDeps(r), settings: { read: () => ({ on: true, waiting: null }), write: () => undefined } }).controlFacts().switchOn).toBe(true)
  })
})

function rigDeps(r: ReturnType<typeof rig>): RemoteDeskDeps {
  return {
    platform: 'darwin', build: () => build, linuxRefusal: () => null, screenAccess: () => 'granted', accessibility: () => true,
    session: async () => r.session, settings: { read: () => ({ on: false, waiting: null }), write: () => undefined },
    servedWorkspace: () => false, workspaceOfCard: () => 'ws', cardName: () => 'c', record: () => undefined, keepAwake: r.awake,
    host: r.host, refreshCards: r.refresh, dropViewers: r.drop, openSettings: r.openSettings, relaunch: r.relaunch
  }
}

describe('the switch when the disk says no', () => {
  it('an unreadable file reads off', () => {
    const r = rig({ settings: { read: () => { throw new Error('garbled') }, write: () => undefined } })
    expect(r.desk.controlFacts().switchOn).toBe(false)
  })

  it('a switch that could not be saved stays off, and says why', () => {
    const r = rig({ settings: { read: () => ({ on: false, waiting: null }), write: () => { throw new Error('read-only disk') } } })
    expect(r.desk.setSwitch(true)).toMatchObject({ ok: false, error: 'read-only disk' })
    expect(r.desk.controlFacts().switchOn).toBe(false)
    expect(r.types()).not.toContain('remote.switch-on')
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

  it('refuses on a locked Mac: nothing here reaches a lock screen', async () => {
    const r = rig({}, { locked: true })
    r.desk.setSwitch(true)
    const answer = await r.desk.takeControl('c1', phone)
    expect(answer).toMatchObject({ ok: false, state: { id: 'locked' } })
    expect((answer as { error: string }).error).toContain('someone at the Mac')
  })

  it('there is no control on Linux, whatever the switch says', async () => {
    const r = rig({ platform: 'linux' })
    expect(r.desk.controlFacts().available).toBe(false)
    expect((await r.desk.takeControl('c1', phone)).ok).toBe(false)
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
    expect(r.desk.admit('c1', phone)).toMatch(/served session/i)
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
    expect(r.desk.inputRefusal()).toMatch(/Stopped at the Mac/)
    expect((await r.desk.takeControl('c1', phone)).ok).toBe(false)
    r.tick(STOP_HOLD_MS)
    expect(r.desk.admit('c1', phone)).toBeNull()
    expect(r.desk.inputRefusal()).toBeNull()
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
    await r.desk.openSettings('screen', 'away')
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
    const r = rig({ settings: { read: () => ({ on: false, waiting: 'screen' }), write: () => undefined } }, { grant: true })
    r.desk.start()
    r.tick(0)
    await r.flush()
    expect(r.types()).toContain('remote.ready')
  })
})

describe('restart', () => {
  it('relaunches a build that can, and logs it', () => {
    const r = rig({ build: () => ({ ...build, restart: 'self' }) })
    expect(r.desk.restart(phone).ok).toBe(true)
    expect(r.relaunch).toHaveBeenCalled()
    expect(r.records.find((e) => e.type === 'remote.restart')?.details).toContain('Pixel 9')
  })

  it('refuses in words on a build that cannot', () => {
    const r = rig()
    const answer = r.desk.restart(MAC_VIEWER)
    expect(answer.ok).toBe(false)
    expect(r.relaunch).not.toHaveBeenCalled()
  })
})
