// THE MACHINE'S LABEL COUNTS THE AGENTS ITS MARKS DRAW (Gauge, 2026-11-01,
// shots/r1/desktop-devices.png: "7 workspaces · 837 agents" over marks that
// add up to 170). It printed every row in the roster, gone agents and gone
// workspaces included; it now says the model's own sum of the marks.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildZoomModel } from '../src/renderer/src/zoom/zoom-model'
import { attachmentIndex } from '../src/renderer/src/terminal-attachments'
import { crewOf, type AgentRow } from '../src/renderer/src/agent-rows'
import type { CanvasNode, TerminalNodeData, WorkspaceMeta } from '../src/shared/model'

const term = (id: string): TerminalNodeData =>
  ({ kind: 'terminal', id, name: id, preset: 'Claude Code', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, cwd: '/x' }) as TerminalNodeData
const row = (id: string, workspaceId: string): AgentRow =>
  ({ id, name: id, preset: 'Claude Code', role: null, orch: false, active: true, workspaceId, workspaceName: workspaceId, cwd: '/x', spawnedAt: 0, phase: 'quiet', turn: null, turnCount: 0, lastActivityAt: 0 }) as AgentRow
const ws = (id: string): WorkspaceMeta => ({ id, name: id, dir: `/w/${id}`, dirs: [], icon: '🗂' }) as WorkspaceMeta

describe('the machine label', () => {
  it('adds up the marks: this crew and each other workspace, not every row the roster ever held', () => {
    const nodes: CanvasNode[] = [term('t1'), term('t2')]
    const rows = [row('t1', 'w1'), row('t2', 'w1'), row('old', 'w1'), row('h1', 'w2'), row('h2', 'w2'), row('h3', 'w3'), row('g1', 'gone'), row('g2', 'gone')]
    const m = buildZoomModel({ nodes, connections: [], rows, crew: crewOf(nodes, rows, { id: 'w1', name: 'w1' }), attachIndex: attachmentIndex(nodes, []), workspaces: [ws('w1'), ws('w2'), ws('w3')], activeId: 'w1', name: 'w1' })
    const drawn = m.agents.length + m.marks.reduce((n, mk) => n + mk.presets.length, 0)
    expect(m.deviceAgents).toBe(drawn)
    expect(m.deviceAgents).toBe(5)
    expect(m.deviceAgents).toBeLessThan(rows.length)
  })

  it('is what the devices stop prints', () => {
    const view = readFileSync('src/renderer/src/zoom/ZoomView.tsx', 'utf8')
    expect(view).toContain('{model.frame.workspaces.length} workspaces · {model.deviceAgents} agents')
    expect(view).not.toContain('{rows.length} agents')
  })
})
