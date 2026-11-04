import { describe, expect, it } from 'vitest'
import { advancedStage, isFirstRunStage, openingStage, type FirstRunStage } from '../src/shared/first-run'

/**
 * THE FIRST RUN IS ONE LINE, WALKED ONCE.
 *
 * preflight → task → phone → second → closed. A saved stage only ever moves
 * forward, and the very first read decides whether this person is new at all:
 * anybody with an agent, a card, a second workspace or an account is not.
 */

const fresh = { saved: null, hasContent: false, hasAccount: false, oldCardClosed: false }

describe('who is new, decided on the first read', () => {
  it('opens at the tool check on a Mac with nothing on it', () => {
    expect(openingStage(fresh)).toBe('preflight')
  })

  it('never opens for anyone who already has something here', () => {
    expect(openingStage({ ...fresh, hasContent: true })).toBe('closed')
    expect(openingStage({ ...fresh, hasAccount: true })).toBe('closed')
  })

  it('takes the old card closed as an answer: that person was here before', () => {
    expect(openingStage({ ...fresh, oldCardClosed: true })).toBe('closed')
  })

  it('keeps a saved stage whatever the facts say: content made during the run must not end it', () => {
    expect(openingStage({ ...fresh, saved: 'task', hasContent: true })).toBe('task')
    expect(openingStage({ ...fresh, saved: 'phone', hasAccount: true })).toBe('phone')
  })

  it('stays closed for good, on an empty Mac too', () => {
    expect(openingStage({ ...fresh, saved: 'closed' })).toBe('closed')
  })
})

describe('the stage only moves forward', () => {
  const order: readonly FirstRunStage[] = ['preflight', 'task', 'phone', 'second', 'closed']

  it('takes a later stage, skipping allowed', () => {
    expect(advancedStage('preflight', 'task')).toBe('task')
    expect(advancedStage('preflight', 'phone')).toBe('phone')
    expect(advancedStage('task', 'closed')).toBe('closed')
  })

  it('refuses every way back', () => {
    for (const [i, later] of order.entries()) {
      for (const earlier of order.slice(0, i)) expect(advancedStage(later, earlier)).toBe(later)
    }
  })

  it('reads a stage off the disk or a bridge only when it is one', () => {
    expect(isFirstRunStage('second')).toBe(true)
    expect(isFirstRunStage('door')).toBe(false)
    expect(isFirstRunStage(3)).toBe(false)
    expect(isFirstRunStage(null)).toBe(false)
  })
})
