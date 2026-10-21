import { describe, expect, it } from 'vitest'
import type { LevelsAgentDetail } from '../src/shared/strata'
import { syntheticFleet } from '../src/strata/fixture/synthetic'
import { embedModeOf } from '../src/renderer/src/embed/embed-mode'
import { isDetail, nodeOfDetail } from '../src/renderer/src/embed/embed-node'
import { railLayout, RAIL_MIN_WIDTH } from '../src/renderer/src/embed/rail-layout'

const agent = syntheticFleet(1_800_000_000_000)[0].levels!.workspaces[1].agents[0]
const detail: LevelsAgentDetail = { agent, workspaceId: 'w', notes: [], browsers: [] }

describe('embed mode at boot', () => {
  it('is honoured only inside a frame', () => {
    expect(embedModeOf('?embed=agent&agent=abc', true)).toEqual({ agentId: 'abc' })
    expect(embedModeOf('?embed=agent&agent=abc', false)).toBeNull()
    expect(embedModeOf('?embed=board', true)).toBeNull()
  })

  it('boots bare for a prewarm, and refuses an agent id that is not one', () => {
    expect(embedModeOf('?embed=agent', true)).toEqual({ agentId: null })
    expect(embedModeOf('?embed=agent&agent=%3Cscript%3E', true)).toEqual({ agentId: null })
  })
})

describe('the card the overlay renders', () => {
  it('uses the desktop’s own node when the detail carries it', () => {
    const node = { ...nodeOfDetail(detail), preset: 'Custom', cwd: '/x' }
    expect(nodeOfDetail({ ...detail, node })).toBe(node)
  })

  it('draws one up from the agent otherwise, with the desktop’s preset names', () => {
    const node = nodeOfDetail({ ...detail, agent: { ...agent, harness: 'codex' } })
    expect(node).toMatchObject({ kind: 'terminal', id: agent.id, name: agent.name, preset: 'Codex', orch: agent.orch })
    expect(nodeOfDetail({ ...detail, agent: { ...agent, harness: 'shell' } }).preset).toBe('Shell')
  })

  it('reads only a real detail', () => {
    expect(isDetail(detail)).toBe(true)
    expect(isDetail({ agent: {}, notes: [] })).toBe(false)
  })
})

describe('where the rails go', () => {
  it('never on a phone: a sheet', () => {
    expect(railLayout({ width: 390, height: 844 }, { x: 0, y: 0, width: 390, height: 760 })).toEqual({ mode: 'sheet' })
  })

  it('folds to tabs when the terminal takes the whole stage, as the remote full view does', () => {
    expect(railLayout({ width: 1280, height: 800 }, { x: 0, y: 0, width: 1280, height: 720 })).toEqual({ mode: 'tabs' })
  })

  it('opens rails only in space the terminal leaves, never over it', () => {
    const terminal = { x: 300, y: 0, width: 680, height: 720 }
    const layout = railLayout({ width: 1280, height: 800 }, terminal)
    expect(layout.mode).toBe('rails')
    if (layout.mode !== 'rails') return
    expect(layout.left!.x + layout.left!.width).toBeLessThanOrEqual(terminal.x)
    expect(layout.right!.x).toBeGreaterThanOrEqual(terminal.x + terminal.width)
    const narrow = railLayout({ width: 1280, height: 800 }, { x: RAIL_MIN_WIDTH - 1, y: 0, width: 1280 - 2 * (RAIL_MIN_WIDTH - 1), height: 720 })
    expect(narrow.mode).toBe('tabs')
  })
})
