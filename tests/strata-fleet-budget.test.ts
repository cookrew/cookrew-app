import { describe, expect, it } from 'vitest'
import { embedStreams, fleetStreamLimit, isHttp1 } from '../src/strata/fleet/stream-budget'

describe('the page’s connection budget', () => {
  it('only HTTP/1.x is budgeted', () => {
    expect(isHttp1('http/1.1')).toBe(true)
    expect(isHttp1('h2')).toBe(false)
    expect(isHttp1('h3')).toBe(false)
    expect(fleetStreamLimit('h2', [])).toBe(Number.POSITIVE_INFINITY)
  })

  it('gives the embed its connections first, keeps one spare, streams at most four', () => {
    expect(fleetStreamLimit('http/1.1', [])).toBe(4)
    const bare = { machineId: 'a', state: 'warm' as const, agentId: null }
    const shown = { machineId: 'b', state: 'warm' as const, agentId: 'x' }
    const loading = { machineId: 'c', state: 'loading' as const, agentId: null }
    expect(embedStreams([bare, shown, loading])).toBe(7)
    expect(fleetStreamLimit('http/1.1', [bare])).toBe(4)
    expect(fleetStreamLimit('http/1.1', [shown])).toBe(2)
    expect(fleetStreamLimit('http/1.1', [shown, bare])).toBe(1)
    expect(fleetStreamLimit('http/1.1', [shown, loading])).toBe(0)
  })
})
