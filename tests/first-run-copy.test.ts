import { describe, expect, it } from 'vitest'
import { EXAMPLE_TASKS, FIRST_SCREEN_COPY, FIX_LABELS, HINT_COPY, PREFLIGHT_COPY, TOOL_COPY, TOOL_NOTES } from '../src/shared/first-run-copy'
import { ACCOUNT_COPY, accountAskView } from '../src/renderer/src/account/account-store'
import { promptPlaceholder } from '../src/renderer/src/prompt/prompt-words'

/**
 * A NEW PERSON READS NONE OF OUR WORDS. The dials are RTE, MDL and EFF, a
 * served session is a door, a place on a team is a seat, a worktree is a lane,
 * the local model is Sous: all true inside Cookrew, and all noise on day one.
 */

const INTERNAL = /\b(RTE|MDL|EFF|doors?|seats?|seated|lanes?|Sous|harness(es)?|crew)\b/i

const strings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

describe('the first run’s words', () => {
  const all = strings([PREFLIGHT_COPY, TOOL_COPY, TOOL_NOTES, FIX_LABELS, FIRST_SCREEN_COPY, EXAMPLE_TASKS, HINT_COPY])

  it('has words to check', () => {
    expect(all.length).toBeGreaterThan(30)
  })

  it('uses none of ours', () => {
    expect(all.filter((line) => INTERNAL.test(line))).toEqual([])
  })

  it('never names herdr without saying what it does', () => {
    const named = all.filter((line) => /herdr/i.test(line))
    expect(named).toEqual([TOOL_COPY.multiplexer.name])
    expect(TOOL_COPY.multiplexer.does).toMatch(/keeps your agents alive/i)
  })

  it('says what choosing a folder allows: that sentence is what stands in for Claude’s trust dialog', () => {
    expect(FIRST_SCREEN_COPY.LEDE).toMatch(/read, change and run files in the folder you choose/)
  })

  it('offers exactly three example tasks, none of them destructive', () => {
    expect(EXAMPLE_TASKS).toHaveLength(3)
    expect(EXAMPLE_TASKS.filter((task) => /delete|remove|clean|reset|push/i.test(task))).toEqual([])
  })
})

describe('the words on the way to an account', () => {
  it('asks in plain words, for each thing that needs one', () => {
    for (const reason of ['phone', 'join'] as const) {
      const view = accountAskView(reason)
      expect(strings([view.title, view.lede, view.join?.ask, view.join?.how]).filter((line) => INTERNAL.test(line))).toEqual([])
    }
  })

  it('keeps the sign-in sheet’s reserved-name sentence free of them too', () => {
    expect(INTERNAL.test(ACCOUNT_COPY.USERNAME_RESERVED)).toBe(false)
  })
})

describe('the box’s words on the first screen', () => {
  it('is the question, whatever stop the zoom is on', () => {
    for (const stop of ['devices', 'workspaces', 'crew', 'artifacts'] as const) {
      expect(promptPlaceholder({ agent: null, stop, workspace: 'My Workspace', item: null, first: true })).toBe(FIRST_SCREEN_COPY.ASK)
    }
  })

  it('leaves every other box alone', () => {
    expect(promptPlaceholder({ agent: null, stop: 'crew', workspace: null, item: null })).toBe('Describe a task for a new agent…')
  })
})
