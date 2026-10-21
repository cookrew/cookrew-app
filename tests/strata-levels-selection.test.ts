import { describe, expect, it } from 'vitest'
import type { StrataPath } from '../src/shared/strata'
import { childToward, defaultHighlight, itemOf, nextAgentWithin, nextItem, pathKey, samePath, type LevelItem } from '../src/strata/levels/selection'
import { keyIntent } from '../src/strata/input/keys'

// A 3 × 2 grid of agents in creation order (row-major), like an L2 container.
const grid: LevelItem[] = Array.from({ length: 6 }, (_, i) => ({
  target: { machine: 'm', workspace: 'w', agent: `a${i}` },
  rect: { x: (i % 3) * 50, y: Math.floor(i / 3) * 50, w: 40, h: 40 }
}))
const a = (i: number): StrataPath => ({ machine: 'm', workspace: 'w', agent: `a${i}` })

describe('arrow keys move the one highlight', () => {
  it('left and right walk creation order, clamped at the ends', () => {
    expect(nextItem(grid, a(0), 'right')).toEqual(a(1))
    expect(nextItem(grid, a(2), 'right')).toEqual(a(3))
    expect(nextItem(grid, a(0), 'left')).toEqual(a(0))
    expect(nextItem(grid, a(5), 'right')).toEqual(a(5))
  })

  it('up and down go to the nearest item that way', () => {
    expect(nextItem(grid, a(1), 'down')).toEqual(a(4))
    expect(nextItem(grid, a(4), 'up')).toEqual(a(1))
    expect(nextItem(grid, a(4), 'down')).toEqual(a(4))
  })

  it('with no highlight yet, any arrow lands on the first item', () => {
    expect(nextItem(grid, null, 'down')).toEqual(a(0))
    expect(nextItem([], null, 'down')).toBeNull()
  })
})

describe('agents inside an item (Shift+arrows on L0/L1)', () => {
  const agents = [a(0), a(1), a(2)]
  it('enters at the first agent going forward and the last going back', () => {
    expect(nextAgentWithin(agents, { machine: 'm' }, 'right')).toEqual(a(0))
    expect(nextAgentWithin(agents, { machine: 'm' }, 'left')).toEqual(a(2))
  })
  it('walks and clamps', () => {
    expect(nextAgentWithin(agents, a(1), 'right')).toEqual(a(2))
    expect(nextAgentWithin(agents, a(2), 'right')).toEqual(a(2))
  })
  it('maps an agent highlight back to its item', () => {
    const items: LevelItem[] = [
      { target: { machine: 'm' }, rect: { x: 0, y: 0, w: 1, h: 1 } },
      { target: { machine: 'n' }, rect: { x: 2, y: 0, w: 1, h: 1 } }
    ]
    expect(itemOf(items, { machine: 'n', workspace: 'v', agent: 'b' })).toEqual({ machine: 'n' })
  })
})

describe('where the highlight starts', () => {
  it('lands on the item you came out of', () => {
    expect(defaultHighlight(grid, a(4), () => false)).toEqual(a(4))
  })
  it('else on the first waiting item, else the first', () => {
    expect(defaultHighlight(grid, null, (t) => t.agent === 'a3')).toEqual(a(3))
    expect(defaultHighlight(grid, null, () => false)).toEqual(a(0))
  })
  it('knows the child you came from when going out', () => {
    expect(childToward({}, { machine: 'm', workspace: 'w' })).toEqual({ machine: 'm' })
    expect(childToward({ machine: 'm' }, { machine: 'm', workspace: 'w', agent: 'a' })).toEqual({ machine: 'm', workspace: 'w' })
    expect(childToward({ machine: 'm', workspace: 'w' }, { machine: 'm', workspace: 'w', agent: 'a' })).toEqual(a(0) && { machine: 'm', workspace: 'w', agent: 'a' })
    expect(childToward({ machine: 'm' }, { machine: 'n', workspace: 'v' })).toBeNull()
  })
  it('compares and keys paths by ids', () => {
    expect(samePath(a(1), { ...a(1) })).toBe(true)
    expect(samePath(a(1), a(2))).toBe(false)
    expect(pathKey({ machine: 'm' })).toBe('m//')
  })
})

describe('the key map', () => {
  const at = (level: 'machines' | 'workspaces' | 'agents' | 'terminal', extra = {}) => ({ level, typing: false, overlayOpen: false, ...extra })
  it('arrows move, Shift+arrows walk agents inside items except at L2', () => {
    expect(keyIntent({ key: 'ArrowRight' }, at('machines'))).toEqual({ type: 'move', dir: 'right', within: false })
    expect(keyIntent({ key: 'ArrowRight', shiftKey: true }, at('workspaces'))).toEqual({ type: 'move', dir: 'right', within: true })
    expect(keyIntent({ key: 'ArrowRight', shiftKey: true }, at('agents'))).toEqual({ type: 'move', dir: 'right', within: false })
  })
  it('Enter and Space go in or dive', () => {
    expect(keyIntent({ key: 'Enter' }, at('agents'))).toEqual({ type: 'in' })
    expect(keyIntent({ key: ' ' }, at('machines'))).toEqual({ type: 'in' })
  })
  it('Esc and Backspace go out, close an overlay first, and do nothing on L0', () => {
    expect(keyIntent({ key: 'Escape' }, at('agents'))).toEqual({ type: 'out' })
    expect(keyIntent({ key: 'Backspace' }, at('workspaces'))).toEqual({ type: 'out' })
    expect(keyIntent({ key: 'Escape' }, at('agents', { overlayOpen: true }))).toEqual({ type: 'close' })
    expect(keyIntent({ key: 'Escape' }, at('machines'))).toBeNull()
  })
  it('Cmd+K, Ctrl+K and slash open the finder', () => {
    expect(keyIntent({ key: 'k', metaKey: true }, at('machines'))).toEqual({ type: 'finder' })
    expect(keyIntent({ key: 'K', ctrlKey: true }, at('agents'))).toEqual({ type: 'finder' })
    expect(keyIntent({ key: '/' }, at('terminal'))).toEqual({ type: 'finder' })
  })
  it('leaves typing, browser shortcuts and the terminal level alone', () => {
    expect(keyIntent({ key: 'Escape' }, at('agents', { typing: true }))).toBeNull()
    expect(keyIntent({ key: 'ArrowLeft', altKey: true }, at('agents'))).toBeNull()
    expect(keyIntent({ key: 'ArrowLeft' }, at('terminal'))).toBeNull()
    expect(keyIntent({ key: 'Enter' }, at('terminal'))).toBeNull()
    expect(keyIntent({ key: 'Escape' }, at('terminal'))).toEqual({ type: 'out' })
  })
})
