import { describe, expect, it } from 'vitest'
import {
  planImportSession,
  orchAskUrl,
  orchTerminalNode,
  type ServeTarget
} from '../src/main/import-session'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

const term = (name: string, orch = false): CanvasNode =>
  ({
    kind: 'terminal', id: `t-${name}`, name, preset: 'Claude Code',
    command: 'claude', cwd: '/work', orch, role: null,
    position: { x: 0, y: 0 }, size: { width: 400, height: 300 }
  }) as CanvasNode

// The fixture: a two-agent crew with a designated orchestrator, served at drej's.
const FIXTURE: TeamSnapshot = {
  name: 'Research Crew', savedAt: 1, dir: '/work',
  nodes: [term('Scout'), term('Conductor', true)],
  connections: [], turns: {}, entryAgent: 'Conductor'
}
const TARGET: ServeTarget = { origin: 'https://drej.cookrew.dev', slug: 'research' }

describe('import a template as a session — the caller enters through one door', () => {
  it('reaches the entry orch at /<slug>/agents/<orch>/ask', () => {
    expect(orchAskUrl(TARGET, 'Conductor')).toBe(
      'https://drej.cookrew.dev/research/agents/Conductor/ask'
    )
  })

  it('plans ONE session workspace, not a copy of the team', () => {
    const plan = planImportSession(FIXTURE, TARGET)
    expect(plan.workspaceName).toBe('Research Crew · session')
    expect(plan.orch.name).toBe('Conductor')
    expect(plan.orch.askUrl).toContain('/research/agents/Conductor/ask')
    expect(plan.orch.command).toBe('cookrew call https://drej.cookrew.dev/research/agents/Conductor/ask')
  })

  it('places exactly ONE terminal — the orch, marked orch, over HTTP', () => {
    const plan = planImportSession(FIXTURE, TARGET)
    const node = orchTerminalNode(plan, 'term_x', '/work', { x: 10, y: 10 })
    expect(node.kind).toBe('terminal')
    expect(node.name).toBe('Conductor')
    expect(node.orch).toBe(true)
    expect(node.command).toContain('/research/agents/Conductor/ask')
  })

  it('enters an older template through its first terminal (no orch flag)', () => {
    const legacy: TeamSnapshot = { ...FIXTURE, entryAgent: undefined, nodes: [term('Scout'), term('Editor')] }
    expect(planImportSession(legacy, TARGET).orch.name).toBe('Scout')
  })

  it('refuses a template with no agent to enter', () => {
    const empty: TeamSnapshot = { ...FIXTURE, nodes: [], entryAgent: undefined }
    expect(() => planImportSession(empty, TARGET)).toThrow(/no agent to enter/)
  })

  it('a slug with special chars is encoded in the ask path', () => {
    expect(orchAskUrl(TARGET, 'Code Reviewer')).toContain('agents/Code%20Reviewer/ask')
  })
})
