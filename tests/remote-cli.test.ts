// `cookrew remote on|off|status|stop` (main/remote-cli.ts): the machine switch
// from a shell on the machine. On only from a plain shell that confirmed it,
// never from a Cookrew pane (a paired device can type into one); off, Stop and
// status from anywhere on the machine.
import { describe, expect, it, vi } from 'vitest'
import { cmdRemote, REMOTE_FROM_PANE, REMOTE_NOT_CONFIRMED, REMOTE_USAGE, type RemoteCliDeps } from '../src/main/remote-cli'
import { LINUX_NO_XDOTOOL, type RemoteAccess, type RemoteAnswer, type RemoteHostView } from '../src/shared/remote-access'
import type { CliRequest } from '../src/shared/model'

const access = (over: Partial<RemoteAccess['control']> = {}, platform: 'darwin' | 'linux' = 'linux'): RemoteAccess => ({
  state: { id: 'ready', platform, build: { settingsName: 'Cookrew', sourceBuild: false, restart: 'self', agents: 'keep' }, then: null, detail: null, lastSeenAt: null, until: null, waiting: false },
  control: { available: true, switchOn: false, accessibility: true, ...over }
})

function rig(over: Partial<RemoteCliDeps> = {}) {
  const setSwitch = vi.fn((_on: boolean, _how: string): RemoteAnswer => ({ ok: true }))
  const confirmOn = vi.fn(async () => true)
  const stopAll = vi.fn()
  const deps: RemoteCliDeps = {
    platform: 'linux',
    access: async () => access(),
    hostView: (): RemoteHostView => ({ rows: [], awake: false }),
    setSwitch,
    confirmOn,
    stopAll,
    ...over
  }
  return { deps, setSwitch, confirmOn, stopAll }
}

const request = (args: string[], more: Partial<CliRequest> = {}): CliRequest => ({ id: 'r', terminalId: '', cmd: 'remote', args, flags: {}, ...more })
const confirmed = (args: string[], more: Partial<CliRequest> = {}): CliRequest => request(args, { flags: { confirmed: true }, ...more })

describe('cookrew remote on', () => {
  it('turns the switch on from a plain shell that confirmed it, and says what that means', async () => {
    const r = rig()
    const said = await cmdRemote(confirmed(['on']), r.deps)
    expect(r.setSwitch).toHaveBeenCalledWith(true, 'from a shell on this machine')
    expect(said).toContain('Remote control of this machine is on')
    expect(said).toContain('cookrew remote off')
    expect(said).not.toMatch(/\bMac\b/)
  })

  it('is refused from a Cookrew pane: a paired device can type into one', async () => {
    const r = rig()
    await expect(cmdRemote(confirmed(['on'], { terminalId: 't1' }), r.deps)).rejects.toThrow(REMOTE_FROM_PANE)
    await expect(cmdRemote(confirmed(['on'], { sessionId: '5f0c1b0e-0000-4000-8000-000000000000' }), r.deps)).rejects.toThrow(REMOTE_FROM_PANE)
    expect(r.setSwitch).not.toHaveBeenCalled()
  })

  it('is refused without the shell confirming it (an old CLI, or a script with no terminal)', async () => {
    const r = rig()
    await expect(cmdRemote(request(['on']), r.deps)).rejects.toThrow(REMOTE_NOT_CONFIRMED)
    await expect(cmdRemote(request(['on'], { flags: { confirmed: 'yes' } }), r.deps)).rejects.toThrow(REMOTE_NOT_CONFIRMED)
    expect(r.setSwitch).not.toHaveBeenCalled()
  })

  it('asks the machine its own confirmation too (Touch ID on a Mac), and a no is a no', async () => {
    const r = rig({ platform: 'darwin', access: async () => access({}, 'darwin'), confirmOn: vi.fn(async () => false) })
    await expect(cmdRemote(confirmed(['on']), r.deps)).rejects.toThrow('Remote control stays off: it was not confirmed at the Mac.')
    expect(r.setSwitch).not.toHaveBeenCalled()
  })

  it('a machine nothing can drive (Wayland) says why and turns nothing on', async () => {
    const wayland: RemoteAccess = { ...access({ available: false }), state: { ...access().state, id: 'unsupported', detail: 'This Linux session runs Wayland' } }
    const r = rig({ access: async () => wayland })
    await expect(cmdRemote(confirmed(['on']), r.deps)).rejects.toThrow(/Wayland/)
    expect(r.confirmOn).not.toHaveBeenCalled()
    expect(r.setSwitch).not.toHaveBeenCalled()
  })

  it('on without xdotool still turns on, and says the one line that finishes it', async () => {
    const r = rig({ access: async () => access({ accessibility: false }) })
    const said = await cmdRemote(confirmed(['on']), r.deps)
    expect(r.setSwitch).toHaveBeenCalledWith(true, expect.any(String))
    expect(said).toContain(LINUX_NO_XDOTOOL)
  })

  it('on but not saved says so, and still counts as done', async () => {
    const r = rig()
    r.setSwitch.mockReturnValueOnce({ ok: false, error: 'Remote control is on, but it could not be saved: it turns off at the next restart.' })
    expect(await cmdRemote(confirmed(['on']), r.deps)).toContain('turns off at the next restart')
  })
})

describe('cookrew remote off, stop, status', () => {
  it('off works from anywhere on the machine, a pane included', async () => {
    const r = rig()
    expect(await cmdRemote(request(['off'], { terminalId: 't1' }), r.deps)).toContain('is off')
    expect(r.setSwitch).toHaveBeenCalledWith(false, 'from a shell on this machine')
  })

  it('stop ends every session and holds the door', async () => {
    const r = rig()
    expect(await cmdRemote(request(['stop']), r.deps)).toContain('Stopped')
    expect(r.stopAll).toHaveBeenCalledTimes(1)
  })

  it('status says the switch, the screen, the hand, and who is on the machine', async () => {
    const r = rig({
      access: async () => access({ switchOn: true, accessibility: false }),
      hostView: () => ({ rows: [{ key: 'k', who: 'Pixel 9', card: 'c1', cardName: 'Main display', mode: 'controlling', since: 1 }], awake: false })
    })
    const said = await cmdRemote(request(['status']), r.deps)
    expect(said).toContain('Remote control of this machine: on')
    expect(said).toContain('Screen: Ready')
    expect(said).toContain(LINUX_NO_XDOTOOL)
    expect(said).toContain('Pixel 9 is controlling Main display')
    expect(said).not.toMatch(/\bMac\b/)
    expect(r.setSwitch).not.toHaveBeenCalled()
  })

  it('a bare `cookrew remote` is status, and anything else is the usage line', async () => {
    const r = rig()
    expect(await cmdRemote(request([]), r.deps)).toContain('Remote control of this machine: off')
    await expect(cmdRemote(request(['enable']), r.deps)).rejects.toThrow(REMOTE_USAGE)
    await expect(cmdRemote(request(['on', 'extra'], { flags: { confirmed: true } }), r.deps)).rejects.toThrow(REMOTE_USAGE)
  })
})
