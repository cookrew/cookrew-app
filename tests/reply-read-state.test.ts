// A READ REPLY STAYS READ (owner, 2026-11-06: First Run went back into the
// phone's HITL group on every refresh). Whether a reply is read is the
// tracker's alone: nothing a client stamps can bring it back, a repaint is not
// a reply, and a read made with no mirror attached reaches everyone listening.
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TurnTracker } from '../src/main/turn-tracker'
import { advanceClock } from '../src/renderer/src/activity-clock'
import { agentInbox } from '../src/renderer/src/zoom/bar-inbox'
import type { PtySession } from '../src/main/pty'
import type { TerminalActivity, TurnRecord } from '../src/shared/turn'

class FakeSession extends EventEmitter {
  terminalId = 'a'
  sessionName = 'cookrew_a'
  full = '⏺ said'
  idle = 0
  fullText(): string {
    return this.full
  }
  viewportText(): string {
    return this.full
  }
  idleFor(): number {
    return this.idle
  }
}

const record = (over: Partial<TurnRecord> = {}): TurnRecord => ({ index: 1, prompt: 'ask', reply: 'said', startedAt: 1, endedAt: 2, final: true, ...over })

function tracked(records: TurnRecord[]): { tracker: TurnTracker; session: FakeSession; heard: TerminalActivity[] } {
  const tracker = new TurnTracker(async () => null)
  tracker.setHistorySource('a', 'file')
  tracker.replaceHistory('a', records)
  const session = new FakeSession()
  tracker.track(session as unknown as PtySession, true)
  const heard: TerminalActivity[] = []
  tracker.on('activity', (activity: TerminalActivity) => heard.push(activity))
  return { tracker, session, heard }
}

const phase = (tracker: TurnTracker): string => tracker.list()[0].phase

/** A spinner repaints, nobody typed, and the screen goes quiet again. */
async function healAndSettle(tracker: TurnTracker, session: FakeSession): Promise<void> {
  session.full = '✻ Actioning… (3s · esc to interrupt)'
  session.emit('data', session.full)
  expect(phase(tracker)).toBe('thinking')
  session.full = '⏺ said\n\n✻ Baked for 3s'
  session.idle = 99_999
  await vi.advanceTimersByTimeAsync(3000)
}

describe('a reply read stays read', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a repaint over a read reply does not make it unread', async () => {
    vi.useFakeTimers()
    const { tracker, session } = tracked([record()])
    expect(phase(tracker)).toBe('replied')
    tracker.seen('a')
    expect(phase(tracker)).toBe('idle')
    await healAndSettle(tracker, session)
    expect(phase(tracker)).toBe('idle')
    tracker.disposeAll()
  })

  it('nor does one after a turn this tracker watched, and nothing rings for it', async () => {
    vi.useFakeTimers()
    const { tracker, session, heard } = tracked([record()])
    tracker.seen('a')
    session.emit('input', 'again\r')
    session.full = '⏺ answered'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)
    expect(phase(tracker)).toBe('replied')
    tracker.replaceHistory('a', [...tracker.history('a'), record({ index: 2, prompt: 'again', reply: 'answered' })])
    tracker.seen('a')
    expect(phase(tracker)).toBe('idle')
    session.idle = 0
    heard.length = 0
    await healAndSettle(tracker, session)
    expect(phase(tracker)).toBe('idle')
    expect(heard.filter((a) => a.phase === 'replied')).toEqual([])
    tracker.disposeAll()
  })

  it('an agent that woke by itself still lands unread once its record does', async () => {
    vi.useFakeTimers()
    const { tracker, session } = tracked([record()])
    tracker.seen('a')
    await healAndSettle(tracker, session)
    const read = tracker.history('a')[0]
    tracker.replaceHistory('a', [read])
    expect(phase(tracker)).toBe('idle')
    tracker.replaceHistory('a', [read, record({ index: 2, prompt: 'woke', reply: 'more' })])
    expect(phase(tracker)).toBe('replied')
    tracker.disposeAll()
  })

  it('a repaint over an unread reply leaves it unread', async () => {
    vi.useFakeTimers()
    const { tracker, session } = tracked([record()])
    await healAndSettle(tracker, session)
    expect(phase(tracker)).toBe('replied')
    tracker.disposeAll()
  })

  it('a turn someone asked for ends unread, its record still on the way', async () => {
    vi.useFakeTimers()
    const { tracker, session } = tracked([record()])
    tracker.seen('a')
    session.emit('input', 'again\r')
    expect(phase(tracker)).toBe('thinking')
    session.full = '⏺ answered'
    session.idle = 99_999
    await vi.advanceTimersByTimeAsync(3000)
    expect(phase(tracker)).toBe('replied')
    tracker.disposeAll()
  })
})

describe('a read with no mirror', () => {
  it('tells everyone listening, and the next read of the list agrees', () => {
    const tracker = new TurnTracker(async () => null)
    tracker.setHistorySource('a', 'file')
    tracker.replaceHistory('a', [record()])
    tracker.observeBackendPhase('a', 'thinking', true)
    tracker.observeBackendPhase('a', null, true)
    const heard: TerminalActivity[] = []
    tracker.on('activity', (activity: TerminalActivity) => heard.push(activity))
    tracker.seen('a')
    expect(heard.at(-1)).toMatchObject({ terminalId: 'a', agent: true, phase: 'idle' })
  })
})

describe('a refresh', () => {
  it('reseeds the clock with a new time for the same reply, and the inbox does not care', () => {
    const activity = (updatedAt: number): TerminalActivity => ({ terminalId: 'a', agent: true, phase: 'idle', turnCount: 15, updatedAt }) as TerminalActivity
    const before = advanceClock({}, { a: activity(1000) }, 1000)
    const after = advanceClock({}, { a: activity(2000) }, 2000)
    expect(before.a).not.toBe(after.a)
    const row = (at: number, unread: boolean) => ({ id: 'a', phase: 'done' as const, unread, lastActivityAt: at })
    expect(agentInbox([row(before.a, false)])).toEqual([])
    expect(agentInbox([row(after.a, false)])).toEqual([])
  })
})
