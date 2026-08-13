import { describe, expect, it } from 'vitest'
import { latencyStats } from '../src/shared/stats'
import {
  eventMeta,
  formatDuration,
  isTimed,
  latencyRows,
  mockLatencyEvents,
  MOCK_LATENCY_SAMPLES,
  type CookrewEvent
} from '../src/renderer/src/event-log'

function event(over: Partial<CookrewEvent> = {}): CookrewEvent {
  return {
    type: 'turn.completed',
    entityId: 't1',
    entityName: 'Coder',
    workspaceId: 'ws-a',
    workspaceName: 'Alpha',
    actor: 'agent',
    timestamp: 1000,
    ...over
  }
}

const timed = (type: string, durationMs: number, over: Partial<CookrewEvent> = {}): CookrewEvent =>
  event({ type, durationMs, ...over })

describe('isTimed', () => {
  it('accepts a finite non-negative duration, including zero', () => {
    expect(isTimed(event({ durationMs: 1200 }))).toBe(true)
    expect(isTimed(event({ durationMs: 0 }))).toBe(true)
  })

  it('treats an absent duration as untimed', () => {
    expect(isTimed(event())).toBe(false)
  })

  it('rejects the values that would poison a percentile', () => {
    expect(isTimed(event({ durationMs: NaN }))).toBe(false)
    expect(isTimed(event({ durationMs: Infinity }))).toBe(false)
    expect(isTimed(event({ durationMs: -5 }))).toBe(false)
    // A stringy duration off the wire is not a number, whatever it coerces to.
    expect(isTimed(event({ durationMs: '900' as unknown as number }))).toBe(false)
  })
})

describe('latencyRows', () => {
  it('returns no rows when nothing is timed — the section can hide', () => {
    expect(latencyRows([event(), event({ type: 'note.created' })])).toEqual([])
    expect(latencyRows([])).toEqual([])
  })

  it('groups by event type and summarises each group', () => {
    const rows = latencyRows([
      timed('turn.completed', 1000),
      timed('turn.completed', 3000),
      timed('workspace.switched', 200)
    ])
    expect(rows.map((r) => r.type)).toEqual(['turn.completed', 'workspace.switched'])
    expect(rows[0].stats.count).toBe(2)
    expect(rows[0].stats.p50).toBe(2000)
    expect(rows[0].stats.max).toBe(3000)
    expect(rows[1].stats).toEqual({ count: 1, p50: 200, p95: 200, p98: 200, max: 200 })
  })

  it('drops untimed events without dropping their timed siblings', () => {
    const rows = latencyRows([
      event({ type: 'turn.completed' }),
      timed('turn.completed', 500),
      event({ type: 'note.created' })
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].stats.count).toBe(1)
  })

  it('excludes a malformed duration from the sample set', () => {
    const rows = latencyRows([
      timed('turn.completed', 100),
      timed('turn.completed', NaN),
      timed('turn.completed', 300)
    ])
    expect(rows[0].stats).toEqual({ count: 2, p50: 200, p95: 290, p98: 296, max: 300 })
  })

  it('drops a type whose every duration is malformed rather than showing NaN', () => {
    expect(latencyRows([timed('turn.completed', NaN), timed('turn.completed', -1)])).toEqual([])
  })

  it('orders worst tail first, breaking ties by type', () => {
    const rows = latencyRows([
      timed('workspace.switched', 500),
      timed('turn.completed', 9000),
      timed('terminal.booted', 500)
    ])
    expect(rows.map((r) => r.type)).toEqual([
      'turn.completed',
      'terminal.booted',
      'workspace.switched'
    ])
  })

  it('delegates the math to the shared module, never re-deriving it', () => {
    const values = [4, 9, 1, 7, 3, 22, 5, 8, 2, 6]
    const rows = latencyRows(values.map((v) => timed('turn.completed', v)))
    expect(rows[0].stats).toEqual(latencyStats(values))
  })

  it('does not mutate the events it reads', () => {
    const events = [timed('turn.completed', 900), event()]
    const before = JSON.parse(JSON.stringify(events))
    latencyRows(events)
    expect(events).toEqual(before)
  })

  it('carries the display label so the panel stays presentational', () => {
    const rows = latencyRows([timed('turn.completed', 1)])
    expect(rows[0].label).toBe(eventMeta('turn.completed').label)
    expect(rows[0].label).not.toBe('Event') // i.e. not the fallback meta
  })

  it('summarises an unknown timed type instead of skipping it', () => {
    const rows = latencyRows([timed('future.thing', 42)])
    expect(rows[0]).toMatchObject({ type: 'future.thing', label: 'Event' })
  })

  it('is a pure function of the list it is handed — filtering upstream is enough', () => {
    const all = [
      timed('turn.completed', 100, { workspaceId: 'ws-a' }),
      timed('turn.completed', 9000, { workspaceId: 'ws-b' })
    ]
    const justA = latencyRows(all.filter((e) => e.workspaceId === 'ws-a'))
    expect(justA[0].stats).toEqual({ count: 1, p50: 100, p95: 100, p98: 100, max: 100 })
  })

  it('excludes turn.completed from every count bucket', () => {
    // The LATENCY rollup is its home; it is not an agent spawned or a card made.
    expect(eventMeta('turn.completed').metric).toBeNull()
    expect(eventMeta('terminal.booted').metric).toBeNull()
  })
})

describe('formatDuration', () => {
  it('keeps sub-second durations in whole milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(842)).toBe('842ms')
    expect(formatDuration(999.4)).toBe('999ms')
  })

  it('switches to one decimal of seconds at a second', () => {
    expect(formatDuration(1000)).toBe('1.0s')
    expect(formatDuration(12_500)).toBe('12.5s')
    expect(formatDuration(59_940)).toBe('59.9s')
  })

  it('reads as minutes and seconds past a minute', () => {
    expect(formatDuration(60_000)).toBe('1m 0s')
    expect(formatDuration(94_300)).toBe('1m 34s')
  })

  it('never prints 1m 60s when the seconds round up', () => {
    expect(formatDuration(119_600)).toBe('2m 0s')
  })

  it('shows a dash rather than NaNms for a value that should never arrive', () => {
    expect(formatDuration(NaN)).toBe('—')
    expect(formatDuration(-1)).toBe('—')
  })
})

describe('mock latency samples', () => {
  it('are all timed, so the section renders without the backend', () => {
    const events = mockLatencyEvents(1_000_000)
    expect(events).toHaveLength(MOCK_LATENCY_SAMPLES.length)
    expect(events.every(isTimed)).toBe(true)
  })

  it('sit in the recent past so every time range shows them', () => {
    const now = 1_000_000_000
    const events = mockLatencyEvents(now)
    for (const e of events) {
      expect(e.timestamp).toBeLessThanOrEqual(now)
      expect(now - e.timestamp).toBeLessThan(60 * 60_000)
    }
  })

  it('are legible as fabricated next to real events', () => {
    for (const e of mockLatencyEvents(0)) {
      expect(e.entityName).toBe('SAMPLE')
      expect(e.details).toBe('mock latency sample')
    }
  })

  it('cover each timed type with a tail that separates p98 from p50', () => {
    const rows = latencyRows(mockLatencyEvents(1_000_000))
    expect(rows.map((r) => r.type).sort()).toEqual([
      'terminal.booted',
      'turn.completed',
      'workspace.switched'
    ])
    const turns = rows.find((r) => r.type === 'turn.completed')!
    expect(turns.stats.p98).toBeGreaterThan(turns.stats.p50 * 2)
  })
})
