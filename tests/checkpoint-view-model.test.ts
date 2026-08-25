import { describe, it, expect } from 'vitest'
import {
  checkpointViewModel,
  isEmptyTurnView,
  turnViewOf,
} from '../src/renderer/src/turn-view-model'
import type { TerminalActivity } from '../src/shared/turn'

/**
 * Trace-perf T1 render model: the card's checkpoint fallback binds to the SAME
 * <TurnView> a live turn does, so these lock the conversion and the exact
 * condition under which the fallback takes over from the live view.
 */
describe('checkpointViewModel', () => {
  it('renders a checkpoint as a finished turn — ask + reply, no live chrome', () => {
    const m = checkpointViewModel({
      prompt: 'Fix the lazy-load bug\nsecond line ignored',
      reply: 'Done — the mirror now attaches on zoom.\nmore detail',
      title: 'Lazy-load fix',
    })
    expect(m).not.toBeNull()
    expect(m!.title).toBe('Lazy-load fix')
    expect(m!.ask).toBe('Fix the lazy-load bug') // first line only
    expect(m!.latest).toEqual({ text: 'Done — the mirror now attaches on zoom.', tone: 'done' })
    expect(m!.tools).toEqual([]) // no live tool trail at T1
    expect(m!.pendingInput).toBeNull()
    expect(m!.tail).toBeNull()
  })

  it('is null when the checkpoint is null (nothing to show → stays "Ready")', () => {
    expect(checkpointViewModel(null)).toBeNull()
  })

  it('is null when prompt and reply and title are all empty', () => {
    expect(checkpointViewModel({ prompt: '  ', reply: '', title: '' })).toBeNull()
  })

  it('shows a reply even when the prompt is unknown (self-healed turn)', () => {
    const m = checkpointViewModel({ prompt: '', reply: 'All four built.' })
    expect(m).not.toBeNull()
    expect(m!.ask).toBeNull()
    expect(m!.latest).toEqual({ text: 'All four built.', tone: 'done' })
  })

  it('the produced model is NOT empty — so <TurnView> renders it, not "Ready"', () => {
    const m = checkpointViewModel({ prompt: 'do x', reply: 'did x' })
    expect(isEmptyTurnView(m!)).toBe(false)
  })
})

describe('isEmptyTurnView — the exact fallback trigger', () => {
  it('is true for an untracked agent (no activity) — the card would show "Ready"', () => {
    expect(isEmptyTurnView(turnViewOf(undefined))).toBe(true)
  })

  it('is false once a live turn has a reply', () => {
    const activity = {
      phase: 'idle',
      prompt: 'hello',
      reply: 'hi there',
      turnCount: 1,
      updatedAt: 0,
    } as unknown as TerminalActivity
    expect(isEmptyTurnView(turnViewOf(activity))).toBe(false)
  })
})
