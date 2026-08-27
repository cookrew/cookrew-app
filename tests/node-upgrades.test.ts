import { describe, expect, it } from 'vitest'
import { upgradeNode } from '../src/main/node-upgrades'
import { DEFAULT_ORCH_PRESET } from '../src/main/presets'
import {
  DEFAULT_BROWSER_SIZE,
  DEFAULT_CANVAS_POSITION,
  DEFAULT_TERMINAL_SIZE,
  type BrowserNodeData,
  type TerminalNodeData
} from '../src/shared/model'

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

  it('preserves the claude session binding through the load-time upgrade', () => {
    const bound = terminal({
      preset: 'Claude Code',
      command: 'claude --permission-mode bypassPermissions',
      claudeSessionId: '4188d6fa-41a0-4618-8e66-ea2af33e42b1'
    })
    const upgraded = upgradeNode(bound) as TerminalNodeData
    expect(upgraded.claudeSessionId).toBe('4188d6fa-41a0-4618-8e66-ea2af33e42b1')
  })

  it('migrates a persisted orch mirror command away from shell env assignments', () => {
    const legacy = terminal({
      id: '1e68e613-39d7-46b0-bd1f-00c8673540df',
      name: 'COOKREW ORCH ▸ Commander',
      command:
        'NODE_TLS_REJECT_UNAUTHORIZED=0 COOKREW_MOBILE_ORIGIN=https://127.0.0.1:8643 node /Users/drej/workspace/cookrew-dev/resources/orch-mirror.mjs b5c1acb0-fafe-444f-b434-fffa8848ab63 --name "Commander"'
    })

    const upgraded = upgradeNode(legacy) as TerminalNodeData
    expect(upgraded.command).toBe(
      'node /Users/drej/workspace/cookrew-dev/resources/orch-mirror.mjs b5c1acb0-fafe-444f-b434-fffa8848ab63 --origin https://127.0.0.1:8643 --name "Commander"'
    )
  })

  it('does not rewrite unrelated commands that happen to set the old env vars', () => {
    const custom = terminal({
      command:
        'NODE_TLS_REJECT_UNAUTHORIZED=0 COOKREW_MOBILE_ORIGIN=https://127.0.0.1:8643 node /tmp/custom-client.mjs b5c1acb0-fafe-444f-b434-fffa8848ab63 --name "Commander"'
    })
    expect(upgradeNode(custom)).toEqual(custom)
  })

  it('adds a durable served transcript target and strips stale launch payment state', () => {
    const legacy = terminal({
      command:
        'node "/app/crew-line.mjs" "--origin" "http://crew.example:8639" "--slug" "research" "--pay" "stale"'
    })
    const upgraded = upgradeNode(legacy) as TerminalNodeData
    expect(upgraded.servedTranscript).toEqual({
      origin: 'http://crew.example:8639',
      slug: 'research'
    })
    expect(upgraded.command).not.toMatch(/"--pay"/)
    expect(upgraded.command).not.toContain('stale')
  })

  it('repairs terminal geometry omitted by an unvalidated API write', () => {
    const malformed = terminal() as TerminalNodeData
    delete (malformed as unknown as Record<string, unknown>).position
    delete (malformed as unknown as Record<string, unknown>).size
    delete (malformed as unknown as Record<string, unknown>).orch

    const upgraded = upgradeNode(malformed) as TerminalNodeData
    expect(upgraded.position).toEqual(DEFAULT_CANVAS_POSITION)
    expect(upgraded.size).toEqual(DEFAULT_TERMINAL_SIZE)
    expect(upgraded.orch).toBe(false)
  })

  it('uses the node-kind size when repairing invalid geometry', () => {
    const malformed = {
      kind: 'browser',
      id: 'b2',
      name: 'Browser',
      url: 'https://example.com',
      position: null,
      size: { width: 0, height: -1 }
    } as unknown as BrowserNodeData

    const upgraded = upgradeNode(malformed) as BrowserNodeData
    expect(upgraded.position).toEqual(DEFAULT_CANVAS_POSITION)
    expect(upgraded.size).toEqual(DEFAULT_BROWSER_SIZE)
  })
})
