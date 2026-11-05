import { describe, expect, it } from 'vitest'
import { TurnTracker } from '../src/main/turn-tracker'
import type { TerminalActivity } from '../src/shared/turn'
import { mergeActivity } from '../src/renderer/src/turn-view-model'

const quiet = (): TurnTracker => new TurnTracker(async () => null)

function heard(tracker: TurnTracker): TerminalActivity[] {
  const out: TerminalActivity[] = []
  tracker.on('activity', (activity: TerminalActivity) => out.push(activity))
  return out
}

describe('TurnTracker.observePane', () => {
  it('a mirrorless pane read carries its lines, marked as read off the pane', () => {
    const tracker = quiet()
    const out = heard(tracker)
    tracker.observePane('a', '511\n512\n513\n', false)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ terminalId: 'a', agent: false, mirrorless: true, paneRead: true, phase: 'idle' })
    expect(out[0].lines.filter(Boolean).at(-1)).toBe('513')
  })

  it('says nothing when the lines did not change', () => {
    const tracker = quiet()
    const out = heard(tracker)
    tracker.observePane('a', '513', false)
    tracker.observePane('a', '513', false)
    expect(out).toHaveLength(1)
  })

  it('a page that arrives later gets it from list()', () => {
    const tracker = quiet()
    tracker.observePane('a', '513', false)
    expect(tracker.list().find((a) => a.terminalId === 'a')?.lines.filter(Boolean).at(-1)).toBe('513')
  })

  it('is never mistaken for a verified screen', () => {
    const tracker = quiet()
    tracker.observePane('a', '513', false)
    expect(tracker.listVerified()).toEqual([])
  })

  it('keeps the phase the backend reported', () => {
    const tracker = quiet()
    tracker.observeBackendPhase('a', 'thinking', true)
    const out = heard(tracker)
    tracker.observePane('a', 'working on it', true)
    expect(out[0].phase).toBe('thinking')
  })

  it('forgetPane drops it', () => {
    const tracker = quiet()
    tracker.observePane('a', '513', false)
    tracker.forgetPane('a')
    expect(tracker.list()).toEqual([])
  })
})

describe('mergeActivity and a pane read', () => {
  const stale: TerminalActivity = {
    terminalId: 'a',
    agent: false,
    phase: 'idle',
    prompt: 'echo hi',
    pendingInput: null,
    lines: ['494'],
    reply: 'hi',
    glance: null,
    title: null,
    turnCount: 0,
    turnStartedAt: null,
    turnStartLine: null,
    scrollRow: null,
    scrollBase: null,
    tailLines: null,
    dispatchId: null,
    updatedAt: 1
  }
  const read: TerminalActivity = { ...stale, mirrorless: true, paneRead: true, prompt: null, reply: null, lines: ['513'], updatedAt: 2 }

  it('a Shell card takes the pane whole: what the mirror left is the stale part', () => {
    expect(mergeActivity(stale, read)).toBe(read)
  })

  it('an agent card keeps its words and takes the screen', () => {
    const merged = mergeActivity({ ...stale, agent: true }, { ...read, agent: true })
    expect(merged).toMatchObject({ prompt: 'echo hi', reply: 'hi', lines: ['513'], mirrorless: true })
  })

  it('a bare phase still keeps the words and the lines', () => {
    const merged = mergeActivity(stale, { ...read, paneRead: undefined, lines: [] })
    expect(merged.lines).toEqual(['494'])
  })
})
