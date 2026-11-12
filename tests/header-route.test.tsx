// THE ONE BAR: the route device / workspace / agent on the left. The device
// step is the way out to the workspaces of this Mac (zoom −1, and −2 for every
// device); the workspace step goes back to its crew; the agent is where you are.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { deviceLabel, routeAgent } from '../src/renderer/src/HeaderRoute'

const source = readFileSync('src/renderer/src/HeaderRoute.tsx', 'utf8')

describe('the device step', () => {
  it('names this desktop without the mDNS suffix, and says so when it has no name', () => {
    expect(deviceLabel('drej-mbp.local')).toBe('drej-mbp')
    expect(deviceLabel('TenonWorkspace-4560')).toBe('TenonWorkspace-4560')
    expect(deviceLabel(null)).toBe('This desktop')
  })

  it('is the way out: the device opens the workspaces of this Mac, and again every device', () => {
    const device = source.slice(source.indexOf('cr-route-device'), source.indexOf('cr-route-workspace'))
    expect(device).toContain('<button')
    expect(source).toContain('const toDevice = (): void => {')
    expect(source).toMatch(/zoomStore\.get\(\)\.v <= -1 \? -2 : -1/)
  })

  it('reads the desktop from main on the desktop, and from the path on the phone', () => {
    expect(source).toContain('deviceLabel(remote ? path.desktopName : machine)')
    expect(source).toContain("cookrew().machineName")
  })
})

describe('the workspace step', () => {
  it('goes back to the workspace: its crew, on the stage', () => {
    expect(source).toMatch(/const toWorkspace = \(\): void => \{\s*stageSelect\.clear\(\)\s*zoomStore\.go\(1, 'agents'\)\s*onViewChange\('stage'\)/)
  })
})

describe('the agent step', () => {
  it('names the agent zoomed on the stage, and nothing when none is', () => {
    expect(routeAgent('stage', 'Conductor')).toBe('Conductor')
    expect(routeAgent('stage', null)).toBeNull()
  })
})

// INSIDE ANOTHER MACHINE THE TITLE IS ITS (owner 2026-11-12): Solis-Core where this Mac's name was,
// its workspace where this Mac's was, and no amber line of its own over the stage.
describe('the route inside another machine', () => {
  it('names that machine, its workspace and its agent; outside, nothing', async () => {
    const { remoteRoute } = await import('../src/renderer/src/HeaderRoute')
    expect(remoteRoute({ machine: null, workspace: null, agent: null, item: null, side: 'agents' })).toBeNull()
    const machine = { id: 'm', name: 'Solis-Core', os: 'linux' }
    expect(remoteRoute({ machine, workspace: null, agent: null, item: null, side: 'agents' })).toEqual({ device: 'Solis-Core', workspace: null, agent: null, item: null })
    expect(remoteRoute({ machine, workspace: { id: 'w', name: 'My Workspace' }, agent: { id: 'a', name: 'Herdr Env' }, item: null, side: 'agents' })).toEqual({ device: 'Solis-Core', workspace: 'My Workspace', agent: 'Herdr Env', item: null })
    // A browser open on that agent's card is the last step, as the stage's own line named it.
    const deep = { machine, workspace: { id: 'w', name: 'My Workspace' }, agent: { id: 'a', name: 'Herdr Env' }, item: { id: 'b', title: 'Grafana', kind: 'browser' as const }, side: 'agents' as const }
    expect(remoteRoute(deep)).toEqual({ device: 'Solis-Core', workspace: 'My Workspace', agent: 'Herdr Env', item: 'Grafana' })
  })

  it('its device step goes back to its workspaces, and from them out to every device: never a dead button', async () => {
    const { remoteDeviceStep, remoteRoute } = await import('../src/renderer/src/HeaderRoute')
    const { remotePlace } = await import('../src/renderer/src/zoom/remote-machine-store')
    const step = (): void => {
      const inside = remoteRoute(remotePlace.get())
      if (!inside) throw new Error('not inside a machine')
      remoteDeviceStep(inside)()
    }
    remotePlace.enter({ id: 'm', name: 'Solis-Core', os: 'linux' })
    remotePlace.workspace({ id: 'w', name: 'My Workspace' })
    remotePlace.agent({ id: 'a', name: 'Herdr Env' })
    step()
    expect(remotePlace.get()).toMatchObject({ machine: { id: 'm' }, workspace: null, agent: null })
    step()
    expect(remotePlace.get().machine).toBeNull()
  })

  it('the stage draws no line of its own saying whose it is: the title says it', () => {
    expect(readFileSync('src/renderer/src/zoom/RemoteMachineView.tsx', 'utf8')).not.toContain('rm-where')
  })
})
