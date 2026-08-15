import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DETACHED_EMIT_GRACE_MS,
  TurnTracker,
  type CompletedTurn
} from '../src/main/turn-tracker'
import type { PtySession } from '../src/main/pty'
import type { TurnRecord } from '../src/shared/turn'

function record(index: number, uuid = `turn-${index}`): TurnRecord {
  return {
    index,
    uuid,
    prompt: `prompt ${index}`,
    reply: `reply ${index}`,
    startedAt: index * 100,
    endedAt: index * 100 + 25
  }
}

function completed(tracker: TurnTracker): CompletedTurn[] {
  const events: CompletedTurn[] = []
  tracker.on('turn', (event: CompletedTurn) => events.push(event))
  return events
}

function detachedTracker(
  statusOf: () => 'idle' | 'working' | 'blocked' | 'done' | null = () => 'idle',
  now?: () => number
): TurnTracker {
  return new TurnTracker(async () => null, null, { statusOf, ...(now ? { now } : {}) })
}

class AttachedSession extends EventEmitter {
  terminalId = 'agent-1'
  sessionName = 'cookrew_agent-1'
  full = ''
  idle = 0
  fullText(): string { return this.full }
  viewportText(): string { return this.full }
  idleFor(): number { return this.idle }
}

describe('tracked-detached turn completion', () => {
  afterEach(() => vi.useRealTimers())
  it('baselines initial history, then emits one completion for a strict append', () => {
    const tracker = detachedTracker()
    const events = completed(tracker)
    tracker.register('agent-1', true)

    tracker.replaceHistory('agent-1', [record(1)])
    expect(events).toEqual([])

    tracker.replaceHistory('agent-1', [record(1), record(2)])
    expect(events).toEqual([{ terminalId: 'agent-1', durationMs: 25, turnIndex: 2 }])
    expect(tracker.history('agent-1')).toHaveLength(2)

    tracker.replaceHistory('agent-1', [record(1), record(2)])
    expect(events).toHaveLength(1)
  })

  it('does not report a rewind/rewrite as a completion', () => {
    const tracker = detachedTracker()
    const events = completed(tracker)
    tracker.register('agent-1', true)
    tracker.replaceHistory('agent-1', [record(1), record(2)])

    tracker.replaceHistory('agent-1', [record(1)])
    tracker.replaceHistory('agent-1', [record(1, 'replacement')])
    expect(events).toEqual([])

    tracker.replaceHistory('agent-1', [record(1, 'replacement'), record(2, 'after-rewind')])
    expect(events).toEqual([{ terminalId: 'agent-1', durationMs: 25, turnIndex: 2 }])
  })

  it('correlates a first detached dispatch even before the initial file reconcile', () => {
    const tracker = detachedTracker(() => 'idle', () => 0)
    const events = completed(tracker)
    tracker.register('agent-1', true)
    tracker.noteDispatch('agent-1', 'dispatch-1')

    tracker.replaceHistory('agent-1', [record(1)])

    expect(events).toEqual([
      { terminalId: 'agent-1', durationMs: 25, turnIndex: 1, dispatchId: 'dispatch-1' }
    ])
  })

  it('stops emitting after a dormant/parked full unregister', () => {
    const tracker = detachedTracker()
    const listener = vi.fn()
    tracker.on('turn', listener)
    tracker.register('agent-1', true)
    tracker.replaceHistory('agent-1', [record(1)])
    tracker.untrack('agent-1')

    tracker.replaceHistory('agent-1', [record(1), record(2)])

    expect(listener).not.toHaveBeenCalled()
  })

  it('uses detached herdr status for rotation detection and live activity rows', () => {
    let status: 'idle' | 'working' | 'blocked' | 'done' | null = 'working'
    const tracker = new TurnTracker(async () => null, null, {
      statusOf: () => status,
      now: () => 1234
    })
    tracker.register('agent-1', true)

    expect(tracker.inTurn('agent-1')).toBe(true)
    expect(tracker.list()).toEqual([
      expect.objectContaining({
        terminalId: 'agent-1',
        agent: true,
        phase: 'thinking',
        lines: [],
        turnStartedAt: null,
        updatedAt: 1234
      })
    ])

    status = 'blocked'
    expect(tracker.inTurn('agent-1')).toBe(true)
    expect(tracker.list()[0].phase).toBe('waiting')
    status = 'idle'
    expect(tracker.inTurn('agent-1')).toBe(false)
    expect(tracker.list()[0].phase).toBe('idle')
  })

  it('keeps detach baselines in raw parser space so a phantom echo cannot shift appends', () => {
    const tracker = detachedTracker()
    const events = completed(tracker)
    const original = record(1, 'uuid-1')
    original.prompt = 'same prompt'
    const echo = { ...record(2, ''), prompt: 'same prompt', uuid: undefined }
    tracker.register('agent-1', true)
    tracker.replaceHistory('agent-1', [original, echo])
    expect(tracker.history('agent-1')).toHaveLength(1)

    tracker.detach('agent-1')
    tracker.replaceHistory('agent-1', [original, echo, record(3, 'uuid-3')])

    expect(events).toEqual([{ terminalId: 'agent-1', durationMs: 25, turnIndex: 3 }])
  })

  it('reports a proven detached duration and omits equal or reversed timestamp fabrications', () => {
    const tracker = detachedTracker()
    const events = completed(tracker)
    tracker.register('agent-1', true)
    tracker.replaceHistory('agent-1', [record(1)])

    const valid = { ...record(2), startedAt: 10_000, endedAt: 18_000 }
    const equal = { ...record(3), startedAt: 20_000, endedAt: 20_000 }
    const reversed = { ...record(4), startedAt: 30_000, endedAt: 29_000 }
    tracker.replaceHistory('agent-1', [record(1), valid])
    tracker.replaceHistory('agent-1', [record(1), valid, equal])
    tracker.replaceHistory('agent-1', [record(1), valid, equal, reversed])

    expect(events).toEqual([
      { terminalId: 'agent-1', durationMs: 8_000, turnIndex: 2 },
      { terminalId: 'agent-1', turnIndex: 3 },
      { terminalId: 'agent-1', turnIndex: 4 }
    ])
    expect(events.some((event) => event.durationMs === 0)).toBe(false)
  })

  it('holds a prompt-only append until the same record has a final reply and idle status', () => {
    let status: 'idle' | 'working' | 'blocked' | 'done' | null = 'working'
    const tracker = detachedTracker(() => status, () => 9_000)
    const events = completed(tracker)
    tracker.register('agent-1', true)
    tracker.noteDispatch('agent-1', 'dispatch-1')

    const promptOnly = { ...record(1), reply: '', endedAt: 10_000, startedAt: 10_000 }
    tracker.replaceHistory('agent-1', [promptOnly])

    expect(events).toEqual([])
    // The premature path consumed this stamp and let a second dispatch in.
    expect(tracker.noteDispatch('agent-1', 'dispatch-2')).toBe(false)

    const final = { ...promptOnly, reply: 'finished', endedAt: 18_000 }
    tracker.replaceHistory('agent-1', [final])
    expect(events).toEqual([])

    status = 'idle'
    tracker.refreshDetachedCompletions()
    tracker.refreshDetachedCompletions()
    expect(events).toEqual([
      { terminalId: 'agent-1', durationMs: 8_000, turnIndex: 1, dispatchId: 'dispatch-1' }
    ])
  })

  it('completes when idle status arrives before the final file reconcile', () => {
    let status: 'idle' | 'working' | 'blocked' | 'done' | null = 'working'
    const tracker = detachedTracker(() => status, () => 10_000)
    const events = completed(tracker)
    tracker.register('agent-1', true)
    tracker.replaceHistory('agent-1', [record(1)])
    tracker.noteDispatch('agent-1', 'dispatch-2')

    const promptOnly = { ...record(2), reply: '', endedAt: 20_000, startedAt: 20_000 }
    tracker.replaceHistory('agent-1', [record(1), promptOnly])
    status = 'idle'
    tracker.refreshDetachedCompletions()
    expect(events).toEqual([])

    tracker.replaceHistory('agent-1', [
      record(1),
      { ...promptOnly, reply: 'final answer', endedAt: 28_000 }
    ])
    expect(events).toEqual([
      { terminalId: 'agent-1', durationMs: 8_000, turnIndex: 2, dispatchId: 'dispatch-2' }
    ])
  })

  it('re-arms after service re-registration and completes a second detached turn', () => {
    let status: 'idle' | 'working' | 'blocked' | 'done' | null = 'working'
    const tracker = detachedTracker(() => status)
    const events = completed(tracker)
    tracker.register('agent-1', true)
    const baseline = record(40, 'historical')
    tracker.replaceHistory('agent-1', [baseline])

    const prompt1 = { ...record(41), reply: '', startedAt: 10_000, endedAt: 10_000 }
    const final1 = { ...prompt1, reply: 'first final', endedAt: 18_200 }
    tracker.replaceHistory('agent-1', [baseline, prompt1])
    tracker.replaceHistory('agent-1', [baseline, final1])
    status = 'idle'
    tracker.refreshDetachedCompletions()

    // The live gate restores dormant after every run, then marks the same
    // workspace hot before the next run. The in-process raw baseline survives
    // that service unregister/register cycle and must remain emission-armed.
    tracker.untrack('agent-1')
    tracker.register('agent-1', true)

    status = 'working'
    const prompt2 = { ...record(42), reply: '', startedAt: 20_000, endedAt: 20_000 }
    const final2 = { ...prompt2, reply: 'second final', endedAt: 28_400 }
    tracker.replaceHistory('agent-1', [baseline, final1, prompt2])
    tracker.replaceHistory('agent-1', [baseline, final1, final2])
    status = 'idle'
    tracker.refreshDetachedCompletions()

    expect(events).toEqual([
      { terminalId: 'agent-1', durationMs: 8_200, turnIndex: 41 },
      { terminalId: 'agent-1', durationMs: 8_400, turnIndex: 42 }
    ])
  })

  it('self-witnesses a complete detached record after status stays unknown for the grace', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    const tracker = detachedTracker(() => null)
    const events = completed(tracker)
    const baseline = record(1)
    tracker.register('agent-1', true)
    tracker.replaceHistory('agent-1', [baseline])

    const prompt = { ...record(2), reply: '', startedAt: 101_000, endedAt: 101_000 }
    tracker.replaceHistory('agent-1', [baseline, prompt])
    tracker.replaceHistory('agent-1', [
      baseline,
      { ...prompt, reply: 'finished without a status feed', endedAt: 109_000 }
    ])

    await vi.advanceTimersByTimeAsync(DETACHED_EMIT_GRACE_MS - 1)
    expect(events).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(events).toEqual([
      { terminalId: 'agent-1', durationMs: 8_000, turnIndex: 2 }
    ])
    tracker.disposeAll()
  })

  it('drops a staged copy when an attached view takes ownership of emission', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(200_000)
    const tracker = detachedTracker(() => 'working')
    const events = completed(tracker)
    const baseline = record(1)
    tracker.register('agent-1', true)
    tracker.replaceHistory('agent-1', [baseline])

    const prompt = { ...record(2), reply: '', startedAt: 201_000, endedAt: 201_000 }
    tracker.replaceHistory('agent-1', [baseline, prompt])

    const session = new AttachedSession()
    tracker.track(session as unknown as PtySession, true)
    session.emit('input', 'prompt 2\r')
    tracker.replaceHistory('agent-1', [
      baseline,
      { ...prompt, reply: 'the reconciled final', endedAt: 209_000 }
    ])
    session.full = 'done'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(DETACHED_EMIT_GRACE_MS)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ terminalId: 'agent-1' })
    expect(events[0].turnIndex).toBeUndefined()
    tracker.disposeAll()
  })

  it('does not attribute pre-arm cold history to a boot-window dispatch', () => {
    vi.useFakeTimers()
    vi.setSystemTime(300_000)
    const tracker = detachedTracker(() => 'idle')
    const events = completed(tracker)
    tracker.register('agent-1', true)
    tracker.noteDispatch('agent-1', 'dispatch-new')

    const stale = {
      ...record(40),
      reply: 'yesterday answer',
      startedAt: 200_000,
      endedAt: 208_000
    }
    tracker.replaceHistory('agent-1', [stale])
    expect(events).toEqual([
      { terminalId: 'agent-1', durationMs: 8_000, turnIndex: 40 }
    ])
    expect(tracker.noteDispatch('agent-1', 'dispatch-other')).toBe(false)

    const fresh = {
      ...record(41),
      reply: 'new dispatch answer',
      startedAt: 301_000,
      endedAt: 309_000
    }
    tracker.replaceHistory('agent-1', [stale, fresh])
    expect(events[1]).toEqual({
      terminalId: 'agent-1',
      durationMs: 8_000,
      turnIndex: 41,
      dispatchId: 'dispatch-new'
    })
    tracker.disposeAll()
  })
})
