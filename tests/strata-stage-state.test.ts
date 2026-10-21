import { describe, expect, it } from 'vitest'
import type { StrataPath } from '../src/shared/strata'
import { isAncestor, pathKey, planFlight, samePath } from '../src/strata/stage/plan'
import { initialStage, mountedScenes, onLand, onPath, onScrubStart, type StageState } from '../src/strata/stage/stage-state'

const M: StrataPath = { machine: 'm' }
const W: StrataPath = { machine: 'm', workspace: 'w' }
const A: StrataPath = { machine: 'm', workspace: 'w', agent: 'a' }
const B: StrataPath = { machine: 'm', workspace: 'w', agent: 'b' }
const keys = (ps: StrataPath[]) => ps.map(pathKey)

describe('plan', () => {
  it('normalises paths', () => {
    expect(samePath({ machine: 'm', workspace: undefined }, M)).toBe(true)
    expect(pathKey({})).toBe('·')
    expect(isAncestor({}, A)).toBe(true)
    expect(isAncestor(W, A)).toBe(true)
    expect(isAncestor(A, A)).toBe(false)
    expect(isAncestor({ machine: 'x' }, A)).toBe(false)
  })

  it('names every kind of move', () => {
    expect(planFlight(W, W).kind).toBe('none')
    expect(planFlight({}, M).kind).toBe('in')
    expect(planFlight(A, W).kind).toBe('out')
    expect(planFlight({}, A).kind).toBe('dive')
    expect(planFlight(A, {}).kind).toBe('rise')
    expect(planFlight(A, B).kind).toBe('hop')
    expect(planFlight(M, { machine: 'n' }).kind).toBe('hop')
  })

  it('a dive passes through the machine and the workspace, with the right anchors', () => {
    const plan = planFlight({}, A)
    if (plan.kind === 'none') throw new Error('no plan')
    expect(keys(plan.scenes)).toEqual(keys([{}, M, W, A]))
    expect(plan.steps.map((s) => s.anchor[0])).toEqual(['portal:m', 'workspace:w', 'agent:a'])
    expect(plan.steps[0].anchor[1]).toBe('machine:m')
    expect(plan.steps[2].content).toEqual(['terminal'])
  })

  it('out flights describe their steps shallow → deep, travelling -1', () => {
    const plan = planFlight(A, M)
    if (plan.kind === 'none') throw new Error('no plan')
    expect(plan.dir).toBe(-1)
    expect(keys(plan.scenes)).toEqual(keys([M, W, A]))
  })
})

describe('stage state', () => {
  const at = (path: StrataPath) => initialStage(path)

  it('in: take-off mounts both levels, landing keeps one (two commits)', () => {
    const s1 = onPath(at({}), M, false)
    expect(s1.flight?.plan.kind).toBe('in')
    expect(keys(mountedScenes(s1))).toEqual(keys([{}, M]))
    const s2 = onLand(s1, s1.flight!.id, 'to')
    expect(s2.flight).toBeNull()
    expect(keys(mountedScenes(s2))).toEqual(keys([M]))
  })

  it('the same path twice is a no-op', () => {
    const s = at(W)
    expect(onPath(s, { ...W }, false)).toBe(s)
  })

  it('a browser-animated Back lands without a flight', () => {
    const s = onPath(at(A), W, true)
    expect(s.flight).toBeNull()
    expect(samePath(s.rest, W)).toBe(true)
  })

  it('Back during an in-flight reverses it in place', () => {
    const s1 = onPath(at(W), A, false)
    const s2 = onPath(s1, W, false)
    expect(s2.flight?.replaces).toEqual({ id: s1.flight!.id, how: 'reverse' })
    expect(s2.flight?.plan.kind).toBe('out')
    expect(keys(mountedScenes(s2))).toEqual(keys([W, A]))
    const s3 = onLand(s2, s2.flight!.id, 'to')
    expect(samePath(s3.rest, W)).toBe(true)
  })

  it('a new target mid-flight finishes the old one and flies on, keeping its scenes until landing', () => {
    const s1 = onPath(at({}), M, false)
    const s2 = onPath(s1, W, false)
    expect(s2.flight?.replaces?.how).toBe('finish')
    expect(samePath(s2.flight!.plan.from, M)).toBe(true)
    expect(keys(mountedScenes(s2))).toEqual(keys([{}, M, W]))
    expect(onLand(s2, s1.flight!.id, 'to')).toBe(s2)
  })

  it('scrub commit: the gesture mounts, the history owner follows, landing keeps the target (three commits)', () => {
    const s1 = onScrubStart(at(W), A)
    expect(s1.flight?.mode).toBe('scrub')
    const s2 = onPath(s1, A, false)
    expect(s2.flight?.id).toBe(s1.flight!.id)
    expect(s2.flight?.committed).toBe(true)
    const s3 = onLand(s2, s1.flight!.id, 'to')
    expect(samePath(s3.rest, A)).toBe(true)
    expect(s3.flight).toBeNull()
  })

  it('scrub spring-back lands where it started', () => {
    const s1 = onScrubStart(at(W), M)
    const s2 = onLand(s1, s1.flight!.id, 'from')
    expect(samePath(s2.rest, W)).toBe(true)
    expect(keys(mountedScenes(s2))).toEqual(keys([W]))
  })

  it('a committed scrub the history owner did not follow flies on to the real path', () => {
    const s1 = onScrubStart(at(W), A)
    const s2 = onLand(s1, s1.flight!.id, 'to')
    expect(s2.flight?.plan.kind).toBe('out')
    expect(samePath(s2.flight!.plan.to, W)).toBe(true)
  })

  it('no scrub while flying', () => {
    const s1: StageState = onPath(at({}), M, false)
    expect(onScrubStart(s1, W)).toBe(s1)
  })

  it('a hop keeps its target on top', () => {
    const s = onPath(at(A), B, false)
    expect(keys(mountedScenes(s))).toEqual(keys([A, B]))
  })
})
