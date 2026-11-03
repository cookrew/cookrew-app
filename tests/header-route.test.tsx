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
