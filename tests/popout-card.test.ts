// Owner 2026-11-17: the popout was not the agent card's size, and the agents
// view should keep its zoom and pop a card of the same size instead.
import { describe, expect, it } from 'vitest'
import { popsCard } from '../src/renderer/src/zoom/zoom-path'
import { cardScaleStyle } from '../src/renderer/src/zoom/AgentCard'

describe('where an agent tap pops its card in place', () => {
  it('at the agents stop and at the artifacts stop', () => {
    expect(popsCard('agents', 1, false)).toBe(true)
    expect(popsCard('items', 0, false)).toBe(true)
  })
  it('never in a full view, at the card stop, or above the workspace', () => {
    expect(popsCard('agents', 1, true)).toBe(false)
    expect(popsCard('agents', 2, false)).toBe(false)
    expect(popsCard('agents', 3, false)).toBe(false)
    expect(popsCard('agents', -1, false)).toBe(false)
    expect(popsCard('items', -1, false)).toBe(false)
  })
})

describe('a floating card is the card stop size', () => {
  it('scales from its corner; a phone pins its words the way the card stop does', () => {
    expect(cardScaleStyle({ scale: 1.4, narrow: false })).toEqual({ transform: 'scale(1.4000)', transformOrigin: '0 0' })
    expect(cardScaleStyle({ scale: 1.25, narrow: true })).toEqual({ transform: 'scale(1.2500)', transformOrigin: '0 0', '--zv-k-card': '1.2500' })
    expect(cardScaleStyle({ scale: 1, narrow: true })).toEqual({})
  })
})
