// A TURN THE FILE HAS NOT CLOSED IS NOT A REPLY (owner, 2026-11-05). After a
// restart a running agent read DONE: the tracker rested it on its last record,
// unread, and that record was the turn still running. A file-backed
// record proves its own end (`final`), so an open one rests quietly, and the DONE
// it owes lands with the finality. A scrape record carries no `final` at all, so
// nothing changes for it.
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { TurnTracker } from '../src/main/turn-tracker'
import type { PtySession } from '../src/main/pty'
import type { TerminalActivity, TurnRecord } from '../src/shared/turn'

class FakeSession extends EventEmitter {
  terminalId = 'a'
  sessionName = 'cookrew_a'
  fullText(): string {
    return ''
  }
  viewportText(): string {
    return ''
  }
}

const record = (over: Partial<TurnRecord> = {}): TurnRecord => ({ index: 1, prompt: 'ask', reply: 'said', startedAt: 1, endedAt: 2, uuid: 'u1', ...over })

function fileBacked(records: TurnRecord[]): { tracker: TurnTracker; heard: TerminalActivity[] } {
  const tracker = new TurnTracker(async () => null)
  tracker.setHistorySource('a', 'file')
  tracker.replaceHistory('a', records)
  const heard: TerminalActivity[] = []
  tracker.on('activity', (activity: TerminalActivity) => heard.push(activity))
  return { tracker, heard }
}

const retracted = (tracker: TurnTracker): void => {
  tracker.observeBackendPhase('a', 'thinking', true)
  tracker.observeBackendPhase('a', null, true)
}

describe('turnOpen', () => {
  it('is a file-backed turn with no end in its file', () => {
    expect(fileBacked([record()]).tracker.turnOpen('a')).toBe(true)
    expect(fileBacked([record({ final: true })]).tracker.turnOpen('a')).toBe(false)
  })

  it('knows nothing of a scrape record, which never carries `final`', () => {
    const tracker = new TurnTracker(async () => null)
    tracker.replaceHistory('a', [record()])
    tracker.setHistorySource('a', 'scrape')
    expect(tracker.turnOpen('a')).toBe(false)
  })

  it('is false with no history, and loads none: the sweep asks of every terminal', () => {
    const loads: string[] = []
    const store = { load: (id: string) => (loads.push(id), []) }
    const tracker = new TurnTracker(async () => null, store as never)
    tracker.setHistorySource('a', 'file')
    expect(tracker.turnOpen('a')).toBe(false)
    expect(loads).toEqual([])
  })
})

describe('herdr falling silent on a mirrorless card', () => {
  it('an open turn rests: no unread reply, so no DONE', () => {
    const { tracker, heard } = fileBacked([record()])
    retracted(tracker)
    expect(heard.at(-1)).toMatchObject({ mirrorless: true, phase: 'idle' })
  })

  it('a closed unread turn is the reply it always was', () => {
    const { tracker, heard } = fileBacked([record({ final: true })])
    retracted(tracker)
    expect(heard.at(-1)).toMatchObject({ mirrorless: true, phase: 'replied' })
  })

  it('a scrape record keeps its reply', () => {
    const tracker = new TurnTracker(async () => null)
    tracker.replaceHistory('a', [record()])
    tracker.setHistorySource('a', 'scrape')
    const heard: TerminalActivity[] = []
    tracker.on('activity', (activity: TerminalActivity) => heard.push(activity))
    retracted(tracker)
    expect(heard.at(-1)?.phase).toBe('replied')
  })

  it('the DONE lands with the finality: herdr can speak before the file is read', () => {
    const { tracker, heard } = fileBacked([record()])
    retracted(tracker)
    tracker.replaceHistory('a', [record({ final: true })])
    expect(heard.at(-1)).toMatchObject({ terminalId: 'a', agent: true, mirrorless: true, phase: 'replied' })
  })

  it('owes it once: a later commit of the same turn says nothing', () => {
    const { tracker, heard } = fileBacked([record()])
    retracted(tracker)
    tracker.replaceHistory('a', [record({ final: true })])
    const said = heard.length
    tracker.replaceHistory('a', [record({ final: true })])
    expect(heard).toHaveLength(said)
  })

  it('a reply already looked at rests when its turn closes', () => {
    const { tracker, heard } = fileBacked([record({ seenAt: 5 })])
    retracted(tracker)
    tracker.replaceHistory('a', [record({ final: true, seenAt: 5 })])
    expect(heard.filter((a) => a.phase === 'replied')).toEqual([])
  })

  it('stays quiet while herdr says it works again: its own retraction will read the end', () => {
    const { tracker, heard } = fileBacked([record()])
    retracted(tracker)
    tracker.observeBackendPhase('a', 'thinking', true)
    tracker.replaceHistory('a', [record({ final: true })])
    expect(heard.at(-1)?.phase).toBe('thinking')
    tracker.observeBackendPhase('a', null, true)
    expect(heard.at(-1)?.phase).toBe('replied')
  })

  it('announces nothing when a closed turn lands with no rest owed: a boot reconcile is silent', () => {
    const { tracker, heard } = fileBacked([record()])
    tracker.replaceHistory('a', [record({ final: true })])
    expect(heard).toEqual([])
  })
})

describe('a mirror attaching to an open turn', () => {
  const attach = (tracker: TurnTracker): FakeSession => {
    const session = new FakeSession()
    tracker.track(session as unknown as PtySession, true)
    return session
  }

  it('comes back resting, not replied: the words stay, the tick does not', () => {
    const { tracker } = fileBacked([record()])
    attach(tracker)
    expect(tracker.phaseOf('a')).toBe('idle')
    expect(tracker.list()[0]).toMatchObject({ prompt: 'ask', reply: 'said' })
  })

  it('a closed unread turn still comes back replied: a restart is no acknowledgement', () => {
    const { tracker } = fileBacked([record({ final: true })])
    attach(tracker)
    expect(tracker.phaseOf('a')).toBe('replied')
  })

  it('turns replied when the file closes the turn, with the words it closed on', () => {
    const { tracker } = fileBacked([record()])
    attach(tracker)
    tracker.replaceHistory('a', [record({ final: true, reply: 'the end' })])
    expect(tracker.phaseOf('a')).toBe('replied')
    expect(tracker.list()[0].reply).toBe('the end')
  })
})
