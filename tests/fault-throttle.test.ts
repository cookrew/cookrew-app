// A FAULT STORM MUST NOT EAT THE LOG (owner, 2026-11-16; plan
// docs/hitl-cross-workspace-2026-11-15 · 日志限流). On 10-30 one exception in a
// loop wrote ~64k `app.exception` rows in seconds and rotated every other
// event out of ~/.cookrew/events*.jsonl. The HITL bar and the notifications
// read that log, so a storm would silently take them away. The guard now
// records the first few of each fault in a window and counts the rest.
import { describe, expect, it } from 'vitest'
import type { CookrewEvent } from '../src/main/event-log'
import {
  createFaultThrottle,
  FAULT_ROWS_PER_WINDOW,
  FAULT_WINDOW_MS,
  FAULTS_PER_WINDOW,
  installProcessGuards,
  summarizeFault
} from '../src/main/process-guards'

const at = (ms: number): Date => new Date(Date.UTC(2026, 10, 16, 12, 0, 0) + ms)
const boom = (message: string, line = 10): Error => {
  const error = new Error(message)
  error.stack = `Error: ${message}\n    at loop (/app/main.js:${line}:5)`
  return error
}

describe('the fault throttle', () => {
  it('records the first few of one fault in a window and counts the rest', () => {
    const throttle = createFaultThrottle()
    const fault = summarizeFault('unhandledRejection', boom('x'), at(0))
    const verdicts = Array.from({ length: 100 }, (_, i) => throttle.take(fault, at(0).getTime() + i).record)
    expect(verdicts.filter(Boolean)).toHaveLength(FAULTS_PER_WINDOW)
    expect(throttle.pending()).toEqual([{ fault, dropped: 100 - FAULTS_PER_WINDOW }])
  })

  it('counts two different faults apart', () => {
    const throttle = createFaultThrottle()
    const a = summarizeFault('unhandledRejection', boom('a', 10), at(0))
    const b = summarizeFault('unhandledRejection', boom('b', 20), at(0))
    for (let i = 0; i < 10; i += 1) {
      throttle.take(a, at(i).getTime())
      throttle.take(b, at(i).getTime())
    }
    expect(throttle.pending().map((p) => [p.fault.reason, p.dropped])).toEqual([
      ['a', 10 - FAULTS_PER_WINDOW],
      ['b', 10 - FAULTS_PER_WINDOW]
    ])
  })

  it('lets the fault through again once its window has passed, handing back what it held', () => {
    const throttle = createFaultThrottle()
    const fault = summarizeFault('unhandledRejection', boom('x'), at(0))
    for (let i = 0; i < FAULTS_PER_WINDOW + 3; i += 1) throttle.take(fault, at(i).getTime())
    const later = throttle.take(fault, at(FAULT_WINDOW_MS + 1).getTime())
    expect(later.record).toBe(true)
    expect(later.suppressed).toEqual({ fault, dropped: 3 })
    expect(throttle.pending()).toEqual([])
  })

  it('one place throwing a message that changes every time is still one fault', () => {
    const throttle = createFaultThrottle()
    const recorded = Array.from({ length: 100 }, (_, i) =>
      throttle.take(summarizeFault('unhandledRejection', boom(`port ${4000 + i} refused`), at(i)), at(i).getTime()).record
    )
    expect(recorded.filter(Boolean)).toHaveLength(FAULTS_PER_WINDOW)
  })

  it('a storm of faults from ever-different places is capped as a whole', () => {
    const throttle = createFaultThrottle()
    const recorded = Array.from({ length: 500 }, (_, i) =>
      throttle.take(summarizeFault('unhandledRejection', boom('x', i + 1), at(i)), at(i).getTime()).record
    )
    expect(recorded.filter(Boolean)).toHaveLength(FAULT_ROWS_PER_WINDOW)
    expect(throttle.pending().reduce((sum, p) => sum + p.dropped, 0)).toBe(500 - FAULT_ROWS_PER_WINDOW)
  })

  it('hands back nothing when nothing was held', () => {
    const throttle = createFaultThrottle()
    const fault = summarizeFault('unhandledRejection', boom('x'), at(0))
    throttle.take(fault, at(0).getTime())
    expect(throttle.take(fault, at(FAULT_WINDOW_MS + 1).getTime()).suppressed).toBeNull()
    expect(throttle.pending()).toEqual([])
  })
})

describe('the guards under a storm', () => {
  function storm(count: number): { events: CookrewEvent[]; timers: (() => void)[]; flushes: number } {
    const handlers = new Map<string, (value: unknown) => void>()
    const target = { on: (event: string, fn: (value: unknown) => void) => void handlers.set(event, fn) } as unknown as Pick<NodeJS.Process, 'on'>
    const events: CookrewEvent[] = []
    const timers: (() => void)[] = []
    const result = { events, timers, flushes: 0 }
    installProcessGuards({
      target,
      append: (event) => void events.push(event),
      workspace: () => ({ id: 'ws-1', name: 'Cookrew Dev' }),
      flush: () => void (result.flushes += 1),
      exit: () => undefined,
      now: () => at(0),
      log: () => undefined,
      schedule: (fn) => void timers.push(fn)
    })
    for (let i = 0; i < count; i += 1) handlers.get('unhandledRejection')?.(boom('loop'))
    return result
  }

  it('10 000 rejections write a handful of rows, not 10 000', () => {
    const { events } = storm(10_000)
    expect(events).toHaveLength(FAULTS_PER_WINDOW)
    expect(events.every((e) => e.type === 'app.rejection')).toBe(true)
  })

  it('when the window closes, one row says how many were held back', () => {
    const { events, timers } = storm(10_000)
    expect(timers).toHaveLength(1)
    timers[0]()
    const summary = events.at(-1)
    expect(summary?.type).toBe('app.rejection.suppressed')
    expect(summary?.details).toMatch(new RegExp(`^${10_000 - FAULTS_PER_WINDOW} more `))
    expect(summary?.details).toContain('loop')
  })

  it('the window timer never throws, even when the workspace cannot be read', () => {
    const handlers = new Map<string, (value: unknown) => void>()
    const target = { on: (event: string, fn: (value: unknown) => void) => void handlers.set(event, fn) } as unknown as Pick<NodeJS.Process, 'on'>
    const timers: (() => void)[] = []
    let calls = 0
    installProcessGuards({
      target,
      append: () => undefined,
      workspace: () => {
        calls += 1
        if (calls > FAULTS_PER_WINDOW) throw new Error('no store')
        return { id: 'ws-1', name: 'Cookrew Dev' }
      },
      flush: () => undefined,
      exit: () => undefined,
      now: () => at(0),
      // stderr closes after the faults were seen: saying "recording failed" throws.
      log: (message) => {
        if (message.includes('recording the fault failed')) throw new Error('EPIPE')
      },
      schedule: (fn) => void timers.push(fn)
    })
    for (let i = 0; i < 20; i += 1) handlers.get('unhandledRejection')?.(boom('loop'))
    expect(timers).toHaveLength(1)
    expect(() => timers[0]()).not.toThrow()
  })

  it('a normal quit hands back what is held', () => {
    const handlers = new Map<string, (value: unknown) => void>()
    const target = { on: (event: string, fn: (value: unknown) => void) => void handlers.set(event, fn) } as unknown as Pick<NodeJS.Process, 'on'>
    const events: CookrewEvent[] = []
    const guards = installProcessGuards({
      target,
      append: (event) => void events.push(event),
      workspace: () => ({ id: 'ws-1', name: 'Cookrew Dev' }),
      flush: () => undefined,
      exit: () => undefined,
      now: () => at(0),
      log: () => undefined,
      schedule: () => undefined
    })
    for (let i = 0; i < 9; i += 1) handlers.get('unhandledRejection')?.(boom('loop'))
    guards.releaseHeld()
    expect(events.at(-1)?.details).toMatch(/^4 more /)
  })

  it('a quiet guard schedules nothing', () => {
    expect(storm(FAULTS_PER_WINDOW).timers).toHaveLength(0)
  })
})
