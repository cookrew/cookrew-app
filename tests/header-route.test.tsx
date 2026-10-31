// THE ONE BAR: the route device / workspace / agent on the left. With the
// levels code gone (2026-10-31) the device is only a name, the workspace step
// goes back to the workspace on the stage, and the agent is where you are.
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

  it('is a name, not a way anywhere: there are no device or workspace levels any more', () => {
    const device = source.slice(source.indexOf('cr-route-device'), source.indexOf('cr-route-workspace'))
    expect(device).toContain('cr-route-here')
    expect(device).not.toContain('<button')
  })

  it('reads the desktop from main on the desktop, and from the path on the phone', () => {
    expect(source).toContain('deviceLabel(remote ? path.desktopName : machine)')
    expect(source).toContain("cookrew().machineName")
  })
})

describe('the workspace step', () => {
  it('goes back to the workspace on the stage: the stage follows what needs you again', () => {
    expect(source).toMatch(/const toWorkspace = \(\): void => \{\s*stageSelect\.clear\(\)\s*onViewChange\('stage'\)/)
  })
})

describe('the agent step', () => {
  it('names the agent zoomed on the stage, and nothing when none is', () => {
    expect(routeAgent('stage', 'Conductor')).toBe('Conductor')
    expect(routeAgent('stage', null)).toBeNull()
  })

  it('is not drawn over the board', () => {
    expect(routeAgent('agents', 'Conductor')).toBeNull()
  })
})
