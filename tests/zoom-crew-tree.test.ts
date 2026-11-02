// THE CREW AS A TREE (owner 2026-11-02: "like the draft",
// group-motion-pivot.html). The draft's crew stands under its lead: the lead
// on top, the agents tied to it in the row below, each of theirs under them,
// and one tied to nobody at the row's end. The app laid the crew out in
// creation order, so a cable from the lead to the last agent crossed the whole
// crew. The tree comes from the cables between agents; the per-row choice
// still caps a row.

import { describe, expect, it } from 'vitest'
import { crewOf, crewRows, type CrewAgent } from '../src/renderer/src/zoom/zoom-layout'

const agent = (id: string, orch = false): CrewAgent => ({ id, orch })
const tie = (a: string, b: string): { a: string; b: string } => ({ a, b })
const ids = (rows: ReturnType<typeof crewRows>): (string | null)[][] => rows.map((r) => r.slots.map((a) => a?.id ?? null))

describe('the crew rows', () => {
  const crew = [agent('lead', true), agent('x1'), agent('m1'), agent('m2'), agent('c2'), agent('c1'), agent('alone')]
  const ties = [tie('lead', 'm1'), tie('m2', 'lead'), tie('m1', 'c1'), tie('c2', 'm2')]

  it('without cables, keep creation order: the leads, then everyone else', () => {
    expect(ids(crewRows(crew, [], 5))).toEqual([['lead'], ['x1', 'm1', 'm2', 'c2', 'c1'], ['alone']])
  })

  it('stand the lead on top, its own below it, and each of theirs under them', () => {
    const rows = ids(crewRows(crew, ties, 2))
    expect(rows[0]).toEqual(['lead'])
    expect(rows[1]).toEqual(['m1', 'm2'])
    // Each child in its parent's column.
    expect(rows[2]).toEqual(['c1', 'c2'])
    // The ones tied to nobody close the crew.
    expect(rows.flat()).toContain('alone')
    expect(rows.flat()).toContain('x1')
    expect(rows.flat().filter(Boolean)).toHaveLength(crew.length)
  })

  it('keep a child under its parent even when a sibling column has none', () => {
    const rows = ids(crewRows([agent('lead', true), agent('a'), agent('b'), agent('c'), agent('k')], [tie('lead', 'a'), tie('lead', 'b'), tie('lead', 'c'), tie('c', 'k')], 3))
    expect(rows[1]).toEqual(['a', 'b', 'c'])
    expect(rows[2]).toEqual([null, null, 'k'])
  })

  // The draft's own crew: Conductor; Forge, Tinker, Velvet, Magpie; each one's
  // under it, and Scout, tied to nobody, at the end of that row.
  it('draw the draft’s crew as the draft does, in as many rows as before', () => {
    const draft = ['Conductor', 'Forge', 'Tinker', 'Velvet', 'Magpie', 'Codex2', 'Harden', 'Fresco', 'Scout'].map((n, i) => agent(n, i === 0))
    const rows = ids(crewRows(draft, [tie('Conductor', 'Forge'), tie('Conductor', 'Tinker'), tie('Conductor', 'Velvet'), tie('Conductor', 'Magpie'), tie('Forge', 'Codex2'), tie('Tinker', 'Harden'), tie('Velvet', 'Fresco')], 5))
    expect(rows).toEqual([['Conductor'], ['Forge', 'Tinker', 'Velvet', 'Magpie'], ['Codex2', 'Harden', 'Fresco', 'Scout']])
  })

  // The camera frames the crew: a taller crew would draw every word smaller.
  it('never grow taller than creation order: then keep its shape and take the tree’s order', () => {
    const chain = [agent('lead', true), agent('z'), agent('y'), agent('x'), agent('w')]
    const rows = ids(crewRows(chain, [tie('lead', 'w'), tie('w', 'x'), tie('x', 'y'), tie('y', 'z')], 5))
    expect(rows).toEqual([['lead'], ['w', 'x', 'y', 'z']])
  })

  it('wrap a row at the chosen width', () => {
    const many = [agent('lead', true), ...Array.from({ length: 7 }, (_, i) => agent(`m${i}`))]
    const rows = ids(crewRows(many, many.slice(1).map((a) => tie('lead', a.id)), 3))
    expect(rows.slice(1).every((r) => r.length <= 3)).toBe(true)
    expect(rows.flat().filter(Boolean)).toHaveLength(8)
  })

  it('place every agent once, cycles and ties to the lead from deep down included', () => {
    const rows = crewRows(crew, [...ties, tie('c1', 'lead'), tie('c1', 'c2'), tie('m1', 'm2')], 5)
    const placed = rows.flatMap((r) => r.slots).filter((a): a is CrewAgent => a !== null).map((a) => a.id)
    expect(new Set(placed).size).toBe(crew.length)
  })
})

describe('the crew layout', () => {
  it('draws a child straight under its parent', () => {
    const { at } = crewOf([agent('lead', true), agent('a'), agent('b'), agent('c'), agent('k')], false, 3, [tie('lead', 'a'), tie('lead', 'b'), tie('lead', 'c'), tie('c', 'k')])
    expect(at.k.x).toBe(at.c.x)
    expect(at.k.y).toBeGreaterThan(at.c.y)
    expect(at.lead.x).toBe(at.b.x)
  })

  it('is unchanged without cables', () => {
    const plain = [agent('o', true), agent('a'), agent('b')]
    expect(crewOf(plain, false, 5, [])).toEqual(crewOf(plain, false, 5))
  })
})
