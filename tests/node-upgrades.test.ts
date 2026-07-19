import { describe, expect, it } from 'vitest'
import { upgradeNode } from '../src/main/node-upgrades'
import { DEFAULT_ORCH_PRESET } from '../src/main/presets'
import type { BrowserNodeData, TerminalNodeData } from '../src/shared/model'

const terminal = (patch: Partial<TerminalNodeData> = {}): TerminalNodeData => ({
  kind: 'terminal',
  id: 't1',
  name: 'Terminal',
  preset: 'Shell',
  command: '',
  cwd: '/tmp',
  orch: false,
  role: null,
  position: { x: 0, y: 0 },
  size: { width: 400, height: 300 },
  ...patch
})

describe('upgradeNode', () => {
  it('migrates legacy portal nodes to browser', () => {
    const portal = {
      kind: 'portal',
      id: 'b1',
      name: 'Portal',
      url: 'https://example.com',
      position: { x: 0, y: 0 },
      size: { width: 400, height: 300 }
    } as unknown as BrowserNodeData
    expect(upgradeNode(portal).kind).toBe('browser')
  })

  it('migrates legacy maestro field to orch', () => {
    const legacy = { ...terminal(), maestro: true } as unknown as TerminalNodeData
    delete (legacy as unknown as Record<string, unknown>).orch
    const upgraded = upgradeNode(legacy) as TerminalNodeData
    expect(upgraded.orch).toBe(true)
    expect('maestro' in upgraded).toBe(false)
  })

  it('upgrades the pre-bypass seeded Conductor shell to the default orch preset', () => {
    const seeded = terminal({ name: 'Conductor', orch: true })
    const upgraded = upgradeNode(seeded) as TerminalNodeData
    expect(upgraded.preset).toBe(DEFAULT_ORCH_PRESET.name)
    expect(upgraded.command).toBe(DEFAULT_ORCH_PRESET.command)
    expect(upgraded.command).toContain('bypassPermissions')
  })

  it('upgrades a Conductor still carrying the legacy maestro flag', () => {
    const legacy = { ...terminal({ name: 'Conductor' }), maestro: true } as unknown as TerminalNodeData
    delete (legacy as unknown as Record<string, unknown>).orch
    const upgraded = upgradeNode(legacy) as TerminalNodeData
    expect(upgraded.orch).toBe(true)
    expect(upgraded.command).toBe(DEFAULT_ORCH_PRESET.command)
  })

  it('leaves deliberate shell terminals untouched', () => {
    const shell = terminal({ name: 'Scratch shell' })
    expect(upgradeNode(shell)).toEqual(shell)
  })

  it('leaves orch terminals with custom commands untouched', () => {
    const custom = terminal({ name: 'Conductor', orch: true, preset: 'Codex', command: 'codex' })
    expect(upgradeNode(custom)).toEqual(custom)
  })
})
