// A DRAFT FOLLOWS ITS LINE WITH NO BOX ON SCREEN (prompt/draft-follow.ts):
// the crew shows an agent's unsent words, so words sent elsewhere (LIVE, the
// phone, the CLI) must leave its draft, though no box watches the agent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalActivity } from '../src/shared/turn'

vi.mock('../src/renderer/src/api', () => ({ cookrew: () => ({ ptyInput: () => undefined }) }))

const { activityStore } = await import('../src/renderer/src/activity-thumb-store')
const { followDrafts } = await import('../src/renderer/src/prompt/draft-follow')
const { draftKey, draftedAgents, getDraft, setDraft } = await import('../src/renderer/src/prompt/prompt-draft')
const { resetLinesForTests, QUIET_MS } = await import('../src/renderer/src/prompt/live-line')

const reading = (pendingInput: string | null): TerminalActivity => ({ phase: 'idle', pendingInput } as unknown as TerminalActivity)

let stop: () => void = () => undefined
beforeEach(() => {
  vi.useFakeTimers()
  resetLinesForTests()
})
afterEach(() => {
  stop()
  for (const id of draftedAgents()) setDraft(draftKey(id), '')
  vi.useRealTimers()
})

describe('a draft with no box on screen', () => {
  it('goes when its line is sent elsewhere', () => {
    activityStore.set('f1', reading('ship it'))
    stop = followDrafts()
    setDraft(draftKey('f1'), 'ship it')
    vi.advanceTimersByTime(QUIET_MS + 1)
    activityStore.set('f1', reading('ship it'))
    activityStore.set('f1', reading(null))
    expect(getDraft(draftKey('f1'))).toBe('')
  })

  it('takes words typed into the line elsewhere', () => {
    activityStore.set('f2', reading('fix'))
    stop = followDrafts()
    setDraft(draftKey('f2'), 'fix')
    vi.advanceTimersByTime(QUIET_MS + 1)
    activityStore.set('f2', reading('fix '))
    activityStore.set('f2', reading('fix the bar'))
    expect(getDraft(draftKey('f2'))).toBe('fix the bar')
  })

  it('stops watching an agent once it holds no draft, and everyone once stopped', () => {
    const before = activityStore.get('f3')
    stop = followDrafts()
    setDraft(draftKey('f3'), 'later')
    setDraft(draftKey('f3'), '')
    activityStore.set('f3', reading('typed in LIVE'))
    expect(getDraft(draftKey('f3'))).toBe('')
    stop()
    setDraft(draftKey('f4'), 'x')
    activityStore.set('f4', reading('y'))
    expect(getDraft(draftKey('f4'))).toBe('x')
    expect(before).toBeUndefined()
  })
})
