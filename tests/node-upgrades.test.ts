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

  it('repairs persisted Chromium error pages before a webview can reload them', () => {
    const poisoned: BrowserNodeData = {
      kind: 'browser',
      id: 'b1',
      name: 'Failed page',
      url: 'chrome-error://chromewebdata/',
      tabs: [
        { id: 'bad', url: 'CHROME-ERROR://chromewebdata/', title: 'Not the page title' },
        { id: 'good', url: 'https://example.com/', title: 'Example' }
      ],
      activeTabId: 'bad',
      position: { x: 0, y: 0 },
      size: { width: 720, height: 560 }
    }

    expect(upgradeNode(poisoned)).toMatchObject({
      url: 'about:blank',
      tabs: [
        { id: 'bad', url: 'about:blank', title: '' },
        { id: 'good', url: 'https://example.com/', title: 'Example' }
      ]
    })
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

  it('a retired crew-line card is neutralized, keeping its name', () => {
    const legacy = terminal({
      name: 'Research Crew · research',
      command:
        'node "/app/crew-line.mjs" "--origin" "http://crew.example:8639" "--slug" "research" "--payment-unavailable-copy" "x"'
    })
    const persisted = {
      ...legacy,
      servedTranscript: { origin: 'http://crew.example:8639', slug: 'research' }
    } as TerminalNodeData
    const upgraded = upgradeNode(persisted) as TerminalNodeData
    expect('servedTranscript' in upgraded).toBe(false)
    expect(upgraded.name).toBe('Research Crew · research')
    expect(upgraded.preset).toBe('Shell')
    expect(upgraded.command).toBe('')
  })

  it('NOTHING from a retired crew card is rebuilt into a command at boot', () => {
    // The old lane took the door's face verbatim, so its persisted command and
    // name are remote data. A migration that rebuilt a command from them would
    // execute an attacker's string at app start, with no user action.
    const hostile = {
      ...terminal({
        name: 'Team $(touch /tmp/pwned)',
        command:
          'node "/tmp/evil/crew-line.mjs" "--origin" "http://$(id)" "--slug" "`whoami`"'
      }),
      servedTranscript: { origin: 'http://x', slug: 's' }
    } as TerminalNodeData
    const upgraded = upgradeNode(hostile) as TerminalNodeData
    expect(upgraded.command).toBe('')
    expect(upgraded.command).not.toContain('/tmp/evil')
    expect(upgraded.command).not.toContain('$(')
  })

  it('a stale servedTranscript key is dropped even without a crew-line command', () => {
    const persisted = {
      ...terminal({ command: 'claude' }),
      servedTranscript: { origin: 'http://x:1', slug: 's' }
    } as TerminalNodeData
    const upgraded = upgradeNode(persisted) as TerminalNodeData
    expect('servedTranscript' in upgraded).toBe(false)
    expect(upgraded.command).toBe('claude')
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
