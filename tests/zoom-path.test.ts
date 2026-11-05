// THE ZOOM PATH (renderer zoom/): one value per direction; the two meet at the
// device; the group is only a passage; clicks open a card, a full view, or
// jump across. Pure rules, pinned here.
import { describe, expect, it } from 'vitest'
import { agentClick, BAR_NAMES, BAR_SIDES, BAR_STOPS, barSide, barStop, clampTo, derive, itemClick, nearestStop, settle, stepOut } from '../src/renderer/src/zoom/zoom-path'
import { brushPath, harnessMark, strokeOf } from '../src/renderer/src/zoom/ink-marks'

describe('the path', () => {
  it('agents: v is the zoom itself; browsers: a dive, then the unfold, then the item zoom', () => {
    expect(derive('agents', 2.4)).toEqual({ z: 2.4, P: 0, I: 0 })
    expect(derive('items', -1.5)).toEqual({ z: -1.5, P: 0, I: 0 })
    expect(derive('items', 0)).toEqual({ z: 0, P: 1, I: 0 })
    expect(derive('items', 0.5)).toEqual({ z: 0, P: 1, I: 0.5 })
    const mid = derive('items', -0.6)
    expect(mid.z).toBeGreaterThan(-1)
    expect(mid.z).toBeLessThanOrEqual(0)
    expect(mid.P).toBe(0)
    expect(derive('items', -0.2).P).toBeGreaterThan(0)
  })

  it('both sides meet at the device and above', () => {
    for (const v of [-2, -1.5, -1]) expect(derive('items', v)).toEqual(derive('agents', v))
  })

  it('the group is a passage: letting go inside it settles on its nearer end', () => {
    expect(settle('agents', -0.7)).toBe(-1)
    expect(settle('agents', 0.4)).toBe(1)
    expect(settle('items', -0.3)).toBe(0)
    expect(settle('agents', 1.6)).toBe(1.6)
    expect(nearestStop('agents', 0.2)).toBe(1)
    expect(nearestStop('agents', -0.2)).toBe(-1)
    expect(clampTo('items', 2)).toBe(1)
    expect(BAR_STOPS.agents.length).toBe(BAR_NAMES.agents.length)
    expect(BAR_STOPS.items.length).toBe(BAR_NAMES.items.length)
  })

  // Owner, 2026-11-01: the card is a small thing inside the crew, and the full
  // view has its own way back, so neither gets a stop on the bar; the names
  // are what each stop shows.
  it('the bar names three stops per side; the card and the full view light the last one', () => {
    expect(BAR_NAMES.agents).toEqual(['devices', 'workspaces', 'agents'])
    expect(BAR_NAMES.items).toEqual(['devices', 'workspaces', 'artifacts'])
    expect(barStop('agents', -2)).toBe(-2)
    expect(barStop('agents', -1)).toBe(-1)
    expect(barStop('agents', -0.7)).toBe(-1)
    expect(barStop('agents', 0.2)).toBe(1)
    expect(barStop('agents', 1)).toBe(1)
    expect(barStop('agents', 2)).toBe(1)
    expect(barStop('agents', 3)).toBe(1)
    expect(barStop('items', 0)).toBe(0)
    expect(barStop('items', 1)).toBe(0)
    // Out a step still walks every stop: full → card → crew.
    expect(stepOut('agents', 3)).toBe(2)
    expect(stepOut('agents', 2)).toBe(1)
  })

  // Owner, 2026-11-01: no slider; the agents view switches to the artifacts and back.
  // Owner, 2026-11-04: the pair became the groups (BarGroups.tsx), artifacts first, agents next to the face.
  it('the last stop is a switch: artifacts | agents, each opening the workspace by its side', () => {
    expect(BAR_SIDES.map((s) => s.name)).toEqual(['artifacts', 'agents'])
    expect(BAR_SIDES.map((s) => [s.dir, s.v])).toEqual([['items', 0], ['agents', 1]])
    // Each side's v is that side's deepest bar stop.
    for (const s of BAR_SIDES) expect(s.v).toBe(BAR_STOPS[s.dir][BAR_STOPS[s.dir].length - 1])
    // Lit only once the view is in the workspace, and then it is the side it is on.
    expect(barSide('agents', -2)).toBeNull()
    expect(barSide('agents', -1)).toBeNull()
    expect(barSide('items', -1)).toBeNull()
    expect(barSide('agents', 1)).toBe('agents')
    expect(barSide('agents', 2)).toBe('agents')
    expect(barSide('agents', 3)).toBe('agents')
    expect(barSide('items', 0)).toBe('items')
    expect(barSide('items', 1)).toBe('items')
  })
})

describe('clicks', () => {
  it('an agent: devices → device → crew → its card → its full view; another agent switches the card; across from the item side', () => {
    expect(agentClick('agents', -2, false)).toEqual({ kind: 'set', v: -1 })
    expect(agentClick('agents', -1, false)).toEqual({ kind: 'set', v: 1 })
    expect(agentClick('agents', 1, true)).toEqual({ kind: 'set', v: 2 })
    expect(agentClick('agents', 2, true)).toEqual({ kind: 'set', v: 3 })
    expect(agentClick('agents', 2, false)).toEqual({ kind: 'switch', v: 2 })
    expect(agentClick('agents', 3, false)).toEqual({ kind: 'refocus-full' })
    // From the artifacts an agent opens its card first (owner, 2026-11-03).
    expect(agentClick('items', 0, false)).toEqual({ kind: 'jump-card' })
    expect(agentClick('items', 1, true)).toEqual({ kind: 'jump-card' })
  })

  it('a browser or note: the thumbs from the device, its full view deeper in, across from the agent side', () => {
    expect(itemClick('agents', -1)).toEqual({ kind: 'set', dir: 'items', v: 0 })
    expect(itemClick('agents', -2)).toEqual({ kind: 'set', dir: 'agents', v: -1 })
    expect(itemClick('agents', 1)).toEqual({ kind: 'jump-full' })
    expect(itemClick('agents', 3)).toEqual({ kind: 'jump-full' })
    expect(itemClick('items', 0)).toEqual({ kind: 'item-full' })
  })
})

describe('the ink marks', () => {
  it('maps presets to marks and draws a closed brush body', () => {
    expect(harnessMark('Claude Code')).toBe('claude')
    expect(harnessMark('codex')).toBe('codex')
    expect(harnessMark('OpenCode')).toBe('opencode')
    expect(harnessMark('zsh')).toBe('shell')
    expect(strokeOf('enso').length).toBeGreaterThan(100)
    const p = brushPath('claude')
    expect(p.body.startsWith('M')).toBe(true)
    expect(p.body.endsWith('Z')).toBe(true)
  })
})

describe('zooming out by click (owner, 2026-10-31)', () => {
  it('steps to the next stop in, one at a time, and never into the passage', () => {
    expect(stepOut('agents', 3)).toBe(2)
    expect(stepOut('agents', 2)).toBe(1)
    expect(stepOut('agents', 1)).toBe(-1)
    expect(stepOut('agents', -1)).toBe(-2)
    // From between stops (a click mid-flight), the next one below.
    expect(stepOut('agents', 2.4)).toBe(2)
    expect(stepOut('agents', 0.3)).toBe(-1)
  })

  it('stops at the outermost stop, and follows the browser side’s own stops', () => {
    expect(stepOut('agents', -2)).toBe(-2)
    expect(stepOut('items', 1)).toBe(0)
    expect(stepOut('items', 0)).toBe(-1)
    expect(stepOut('items', -1)).toBe(-2)
    expect(stepOut('items', -2)).toBe(-2)
  })
})
