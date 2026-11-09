import { describe, expect, it } from 'vitest'
import type { MachineProfile } from '../src/shared/fleet'
import { machinesConsole, type ConsoleMachine } from '../registry/src/site-machines'

/**
 * cookrew.dev/me AS THE CONSOLE (owner 2026-11-10): every machine of the
 * account, drawn as what it is; before the reader proves it is them, a machine
 * says only its name, its platform and whether it is there.
 */

const mac: MachineProfile = { kind: 'laptop', model: 'MacBookPro18,1', label: 'MacBook Pro 16-inch', vendor: 'Apple', os: 'darwin', osVersion: '27.2', arch: 'arm64', cpus: 10, memoryGb: 32, evidence: [] }
const NOW = Date.UTC(2026, 10, 10, 12)
const machines: ConsoleMachine[] = [
  { id: '135928f2-49c7-821e-8735-c5241315e81a', name: 'MacBook Pro', online: true, lastSeenAt: NOW, profile: mac, workspaces: ['Cookrew Dev', 'GOAT Team'] },
  { id: '7200b968-0000-4000-8000-000000000001', name: 'Solis-Core', online: false, lastSeenAt: NOW - 3 * 3600_000, profile: { ...mac, kind: 'desktop', os: 'linux', label: null, osVersion: 'Ubuntu 24.04' }, workspaces: ['Box Lab'] }
]

describe('the machines on cookrew.dev/me', () => {
  it('draws each as what it is, with its name and platform', () => {
    const html = machinesConsole('anvztor', machines, NOW)
    expect(html).toContain('id="me-machines"')
    expect(html.match(/<svg class="ms"/g)).toHaveLength(2)
    expect(html).toContain('MacBook Pro 16-inch')
    expect(html).toContain('Linux · Ubuntu 24.04')
    expect(html).toContain('Solis-Core')
  })

  it('shows no workspace names: nothing from inside a machine before its gate', () => {
    const html = machinesConsole('anvztor', machines, NOW)
    expect(html).not.toContain('Cookrew Dev')
    expect(html).not.toContain('Box Lab')
  })

  it('an online machine is a way in to its own page; an offline one says when it was last seen and opens nothing', () => {
    const html = machinesConsole('anvztor', machines, NOW)
    expect(html).toContain('href="/relay/@anvztor/desktop/135928f2-49c7-821e-8735-c5241315e81a/"')
    expect(html).not.toContain('href="/relay/@anvztor/desktop/7200b968')
    expect(html).toMatch(/data-machine="7200b968[^"]*"[^>]*data-online="0"/)
    expect(html).toContain('last seen 3 h ago')
    expect(html).toContain('online')
  })

  it('says so when there are none, and escapes what a machine called itself', () => {
    expect(machinesConsole('anvztor', [], NOW)).toContain('No machine')
    const named = machinesConsole('anvztor', [{ ...machines[0], name: '<img onerror=x>' }], NOW)
    expect(named).not.toContain('<img onerror')
  })

  it('carries the gate, hidden until the page knows whether this browser holds a pass', () => {
    expect(machinesConsole('anvztor', machines, NOW)).toMatch(/id="me-gate"[^>]*hidden/)
  })
})

describe('the scripts /me loads', () => {
  it('are every one in the bundle cookrew.dev serves (a missing one is a 404 and a dead console)', async () => {
    const { mePage } = await import('../registry/src/site-account')
    const { ASSETS } = await import('../registry/src/assets-bundle')
    const account = { username: 'anvztor', avatar: null, displayName: '', claimedAt: NOW, devices: [], desktops: [], recovery: [], passwordless: false } as never
    const html = mePage({ account, currentDeviceId: 'x', machines: [], now: NOW }).body
    const scripts = [...html.matchAll(/\/assets\/([\w.-]+\.js)\?/g)].map((m) => m[1])
    expect(scripts).toContain('machines.js')
    for (const name of scripts) expect(ASSETS[name], name).toBeDefined()
  })
})
