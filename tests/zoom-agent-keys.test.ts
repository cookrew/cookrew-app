// AGENTS ARE WHAT THE KEYS MOVE BY (owner, 2026-11-17): at the devices and the
// workspaces, Tab and the arrows walk agent by agent, across workspaces and
// machines, and the agent stood on pops its card for a quick reply.
import { describe, expect, it } from 'vitest'
import { groupIndexOf, keyMove, nearestToward, ownsKey, ringOf, spotAt, stepRing, type PickGroup } from '../src/renderer/src/zoom/agent-keys'

const groups: PickGroup[] = [
  { machine: 'local', workspace: 'a', agents: ['a1', 'a2'] },
  { machine: 'local', workspace: 'empty', agents: [] },
  { machine: 'local', workspace: 'b', agents: ['b1'] },
  { machine: 'solis', workspace: 'c', agents: ['c1', 'c2', 'c3'] }
]
const ring = ringOf(groups)
const names = (spots: readonly { agent: string }[]): string[] => spots.map((s) => s.agent)
const key = (over: Partial<Parameters<typeof keyMove>[0]>): Parameters<typeof keyMove>[0] => ({ key: 'Tab', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...over })

describe('the ring of agents', () => {
  it('is every agent in drawn order, machine by machine, workspace by workspace, an empty one skipped', () => {
    expect(names(ring)).toEqual(['a1', 'a2', 'b1', 'c1', 'c2', 'c3'])
    expect(ring[3]).toEqual({ machine: 'solis', workspace: 'c', agent: 'c1' })
  })

  it('steps on from where it stands, across workspaces and machines, and round from the end', () => {
    expect(stepRing(ring, ring[1], 1)?.agent).toBe('b1')
    expect(stepRing(ring, ring[2], 1)?.agent).toBe('c1')
    expect(stepRing(ring, ring[5], 1)?.agent).toBe('a1')
    expect(stepRing(ring, ring[0], -1)?.agent).toBe('c3')
  })

  it('starts at the first going on and the last going back, when nothing (or a gone agent) is stood on', () => {
    expect(stepRing(ring, null, 1)?.agent).toBe('a1')
    expect(stepRing(ring, null, -1)?.agent).toBe('c3')
    expect(stepRing(ring, { machine: 'local', workspace: 'a', agent: 'gone' }, 1)?.agent).toBe('a1')
    expect(stepRing([], null, 1)).toBeNull()
  })

  it('tells one machine’s agent from another’s with the same id', () => {
    const twins = ringOf([{ machine: 'local', workspace: 'a', agents: ['x'] }, { machine: 'solis', workspace: 'a', agents: ['x'] }])
    expect(stepRing(twins, twins[0], 1)).toEqual({ machine: 'solis', workspace: 'a', agent: 'x' })
  })

  it('finds a workspace’s agent at a place in its row, held inside the row', () => {
    expect(groupIndexOf(groups, ring[4])).toBe(1)
    expect(spotAt(groups, 'solis', 'c', 1)?.agent).toBe('c2')
    expect(spotAt(groups, 'local', 'b', 5)?.agent).toBe('b1')
    expect(spotAt(groups, 'local', 'empty', 0)).toBeNull()
  })
})

describe('the keys', () => {
  it('Tab and the side arrows go on and back; up and down go a row', () => {
    expect(keyMove(key({}))).toBe('next')
    expect(keyMove(key({ shiftKey: true }))).toBe('prev')
    expect(keyMove(key({ key: 'ArrowRight' }))).toBe('next')
    expect(keyMove(key({ key: 'ArrowLeft' }))).toBe('prev')
    expect(keyMove(key({ key: 'ArrowDown' }))).toBe('down')
    expect(keyMove(key({ key: 'ArrowUp' }))).toBe('up')
  })

  it('leaves a chord, an IME mid-word and any other key alone', () => {
    expect(keyMove(key({ metaKey: true }))).toBeNull()
    expect(keyMove(key({ ctrlKey: true, key: 'ArrowRight' }))).toBeNull()
    expect(keyMove(key({ altKey: true }))).toBeNull()
    expect(keyMove(key({ isComposing: true }))).toBeNull()
    expect(keyMove(key({ key: 'a' }))).toBeNull()
    expect(keyMove(key({ key: 'Enter' }))).toBeNull()
  })

  it('on the page every move is the keys’; in the card’s box Tab always, the arrows only while it is empty', () => {
    for (const move of ['next', 'prev', 'up', 'down'] as const) expect(ownsKey('page', move, { empty: false, tab: false })).toBe(true)
    expect(ownsKey('box', 'next', { empty: false, tab: true })).toBe(true)
    expect(ownsKey('box', 'prev', { empty: false, tab: true })).toBe(true)
    expect(ownsKey('box', 'next', { empty: true, tab: false })).toBe(true)
    expect(ownsKey('box', 'down', { empty: true, tab: false })).toBe(true)
    expect(ownsKey('box', 'next', { empty: false, tab: false })).toBe(false)
    expect(ownsKey('box', 'down', { empty: false, tab: false })).toBe(false)
  })

  it('never takes a key from another field, a terminal or another dialog', () => {
    for (const move of ['next', 'prev', 'up', 'down'] as const) expect(ownsKey('elsewhere', move, { empty: true, tab: true })).toBe(false)
  })
})

describe('up and down go to the nearest row that way', () => {
  const spots = [
    { key: 'top-left', x: 0, y: 0 },
    { key: 'top-right', x: 100, y: 2 },
    { key: 'mid-left', x: 10, y: 50 },
    { key: 'mid-right', x: 90, y: 52 },
    { key: 'low', x: 50, y: 120 }
  ]

  it('the nearest row first, then the one most nearly in line', () => {
    expect(nearestToward({ x: 95, y: 0 }, spots, 'down')).toBe('mid-right')
    expect(nearestToward({ x: 5, y: 0 }, spots, 'down')).toBe('mid-left')
    expect(nearestToward({ x: 90, y: 52 }, spots, 'up')).toBe('top-right')
    expect(nearestToward({ x: 10, y: 50 }, spots, 'down')).toBe('low')
  })

  it('none past the last row', () => {
    expect(nearestToward({ x: 50, y: 120 }, spots, 'down')).toBeNull()
    expect(nearestToward({ x: 0, y: 0 }, spots, 'up')).toBeNull()
  })
})
