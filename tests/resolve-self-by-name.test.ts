import { describe, expect, it } from 'vitest'
import { resolveSelfByName } from '../src/main/socket-server'
import type { TerminalNodeData } from '../src/shared/nodes'

/**
 * Identity for a caller that is NOT a pane.
 *
 * `cookrew` on the system PATH has no COOKREW_TERMINAL_ID, so `--as "Name"`
 * says who to speak as. Names are what the user knows — the canvas and
 * `cookrew list` show names, never terminal ids.
 */

const term = (id: string, name: string): TerminalNodeData =>
  ({
    kind: 'terminal',
    id,
    name,
    preset: 'Claude Code',
    command: 'claude',
    cwd: '/w',
    orch: false
  }) as TerminalNodeData

const store = (terminals: TerminalNodeData[]): never =>
  ({
    terminals: () => terminals,
    terminalsAcross: () => terminals
  }) as never

describe('resolveSelfByName', () => {
  it('resolves a unique name', () => {
    const found = resolveSelfByName('Tinker', store([term('a', 'Velvet'), term('b', 'Tinker')]))
    expect(found.id).toBe('b')
  })

  it('is case- and whitespace-insensitive, because humans type it', () => {
    expect(resolveSelfByName('  tinker ', store([term('b', 'Tinker')])).id).toBe('b')
  })

  it('THROWS on an ambiguous name instead of picking one', () => {
    // The load-bearing assertion. Two agents can share a name across
    // workspaces, and silently choosing one would send a prompt to the wrong
    // agent — a mistake the user would attribute to the agent, not the CLI.
    expect(() =>
      resolveSelfByName('Conductor', store([term('a', 'Conductor'), term('b', 'Conductor')]))
    ).toThrow(/More than one terminal is named/)
  })

  it('points at a discovery command when the name is unknown', () => {
    expect(() => resolveSelfByName('Nobody', store([term('a', 'Velvet')]))).toThrow(
      /cookrew list --all/
    )
  })

  it('falls back to the durable registry, which outlives workspace files', () => {
    // Same reboot-safety resolveSelf has: after a cold start the registry may
    // know an agent that no workspace file does yet.
    const agents = {
      list: () => [
        {
          id: 'r1',
          name: 'Beacon',
          preset: 'Claude Code',
          command: 'claude',
          cwd: '/w',
          orch: false,
          workspaceId: 'w',
          workspaceName: 'W',
          active: true
        }
      ]
    } as never
    expect(resolveSelfByName('Beacon', store([]), agents).id).toBe('r1')
  })
})
