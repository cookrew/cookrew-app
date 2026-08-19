import { describe, expect, it, vi } from 'vitest'
import type { CookrewEvent } from '../src/main/event-log'
import {
  faultEvent,
  installProcessGuards,
  summarizeFault,
  type ProcessGuardDeps
} from '../src/main/process-guards'

/** A stand-in for `process` whose handlers the test fires by hand. */
function fakeProcess(): {
  target: Pick<NodeJS.Process, 'on'>
  fire: (event: string, value: unknown) => void
  handlers: Map<string, ((value: unknown) => void)[]>
} {
  const handlers = new Map<string, ((value: unknown) => void)[]>()
  const target = {
    on(event: string, handler: (value: unknown) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return target as unknown as NodeJS.Process
    }
  } as unknown as Pick<NodeJS.Process, 'on'>
  return {
    target,
    handlers,
    fire: (event, value) => {
      for (const handler of handlers.get(event) ?? []) handler(value)
    }
  }
}

function harness(overrides: Partial<ProcessGuardDeps> = {}): {
  fire: (event: string, value: unknown) => void
  handlers: Map<string, unknown[]>
  events: CookrewEvent[]
  exits: number[]
  flushes: number
  logs: string[]
} {
  const proc = fakeProcess()
  const events: CookrewEvent[] = []
  const exits: number[] = []
  const logs: string[] = []
  let flushes = 0
  installProcessGuards({
    target: proc.target,
    append: (event) => void events.push(event),
    workspace: () => ({ id: 'ws-1', name: 'Cookrew Dev' }),
    flush: () => void (flushes += 1),
    exit: (code) => void exits.push(code),
    now: () => new Date('2026-08-15T14:50:23.000Z'),
    log: (message) => void logs.push(message),
    ...overrides
  })
  return {
    fire: proc.fire,
    handlers: proc.handlers as unknown as Map<string, unknown[]>,
    events,
    exits,
    get flushes() {
      return flushes
    },
    logs
  }
}

describe('installProcessGuards', () => {
  it('installs BOTH handlers — the guard against the guard going missing', () => {
    const h = harness()
    expect(h.handlers.get('unhandledRejection')).toHaveLength(1)
    expect(h.handlers.get('uncaughtException')).toHaveLength(1)
  })

  it('SURVIVES a rejecting background boot — the fleet-killer', () => {
    const h = harness()
    // Exactly the shape that took the app down mid-instantiate: a promise
    // started by a background boot, awaited by nobody.
    h.fire('unhandledRejection', new Error('Instance entry agent did not boot'))
    expect(h.exits).toEqual([])
    expect(h.flushes).toBe(0)
    expect(h.events).toHaveLength(1)
    expect(h.events[0].type).toBe('app.rejection')
  })

  it('keeps surviving — a burst of rejections never adds up to an exit', () => {
    const h = harness()
    for (let i = 0; i < 5; i += 1) h.fire('unhandledRejection', new Error(`boom ${i}`))
    expect(h.exits).toEqual([])
    expect(h.events).toHaveLength(5)
  })

  it('flushes BEFORE exiting on an uncaught exception, and exits through app.exit', () => {
    const order: string[] = []
    const h = harness({
      flush: () => void order.push('flush'),
      exit: (code) => void order.push(`exit(${code})`)
    })
    h.fire('uncaughtException', new Error('main thread is not itself'))
    expect(order).toEqual(['flush', 'exit(1)'])
  })

  it('exits once when a second exception arrives during teardown', () => {
    const h = harness()
    h.fire('uncaughtException', new Error('first'))
    h.fire('uncaughtException', new Error('second, mid-teardown'))
    expect(h.exits).toEqual([1])
    expect(h.flushes).toBe(1)
    // Still REPORTED, both times — surviving evidence is the point.
    expect(h.events).toHaveLength(2)
  })

  it('still exits when the flush itself throws', () => {
    const h = harness({
      flush: () => {
        throw new Error('disk is gone')
      }
    })
    h.fire('uncaughtException', new Error('fatal'))
    expect(h.exits).toEqual([1])
  })

  it('survives an observability log that is itself broken', () => {
    const h = harness({
      append: () => {
        throw new Error('event log unwritable')
      }
    })
    expect(() => h.fire('unhandledRejection', new Error('boom'))).not.toThrow()
    expect(h.exits).toEqual([])
  })

  it('logs the ISO timestamp that correlates with the herdr server log', () => {
    const h = harness()
    h.fire('unhandledRejection', new Error('boom'))
    expect(h.logs[0]).toContain('2026-08-15T14:50:23.000Z')
    expect(h.logs[0]).toContain('unhandledRejection')
  })
})

describe('summarizeFault', () => {
  const at = new Date('2026-08-15T14:50:23.000Z')

  it('carries name, one-line reason and the top frame', () => {
    const error = new Error('Instance creation failed: boot never observed')
    const fault = summarizeFault('unhandledRejection', error, at)
    expect(fault.name).toBe('Error')
    expect(fault.reason).toBe('Instance creation failed: boot never observed')
    expect(fault.origin).toMatch(/process-guards\.test\.ts|Object\.<anonymous>/)
  })

  it('keeps only the FIRST line — a stack in the reason would be payload', () => {
    const fault = summarizeFault('uncaughtException', new Error('top\nsecond line'), at)
    expect(fault.reason).toBe('top')
  })

  it('truncates a long message rather than logging a prompt', () => {
    const fault = summarizeFault('unhandledRejection', new Error('x'.repeat(500)), at)
    expect(fault.reason.length).toBeLessThanOrEqual(200)
    expect(fault.reason.endsWith('…')).toBe(true)
  })

  it('describes a non-Error rejection by type, never by value', () => {
    const secret = { token: 'sk-do-not-log-me' }
    const fault = summarizeFault('unhandledRejection', secret, at)
    expect(fault.name).toBe('non-error:object')
    expect(fault.reason).toBe('')
    expect(JSON.stringify(fault)).not.toContain('sk-do-not-log-me')
  })

  it('keeps a string rejection, still one truncated line', () => {
    const fault = summarizeFault('unhandledRejection', 'plain failure', at)
    expect(fault.name).toBe('non-error:string')
    expect(fault.reason).toBe('plain failure')
  })
})

describe('faultEvent', () => {
  it('is metadata only, attributed to the workspace on screen', () => {
    const fault = summarizeFault(
      'uncaughtException',
      new Error('main thread is not itself'),
      new Date('2026-08-15T14:50:23.000Z')
    )
    const event = faultEvent(fault, { id: 'ws-1', name: 'Cookrew Dev' })
    expect(event.type).toBe('app.exception')
    expect(event.workspaceId).toBe('ws-1')
    expect(event.timestamp).toBe(Date.parse('2026-08-15T14:50:23.000Z'))
    expect(event.details).toContain('main thread is not itself')
    expect(event.durationMs).toBeUndefined()
  })
})
