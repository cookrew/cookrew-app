// A WIDEN DURING A TURN IS REDRAWN WHEN THE TURN ENDS (renderer/turn-redraw.ts):
// a working Claude Code does not redraw on the widen's closing narrowing, so the
// redraw is owed and paid once, when the turn is at rest.
import { describe, expect, it } from 'vitest'
import { createTurnRedraw } from '../src/renderer/src/turn-redraw'

describe('createTurnRedraw', () => {
  it('a widen mid-turn is redrawn once, when the turn comes to rest', () => {
    const redraw = createTurnRedraw()
    redraw.widened('thinking')
    expect(redraw.settled('thinking')).toBe(false)
    expect(redraw.settled('waiting')).toBe(false)
    expect(redraw.settled('replied')).toBe(true)
    expect(redraw.settled('idle')).toBe(false) // paid
  })

  it('a widen at rest owes nothing: the widen itself already redrew', () => {
    const redraw = createTurnRedraw()
    redraw.widened('idle')
    redraw.widened('replied')
    expect(redraw.settled('idle')).toBe(false)
  })

  it('a widen while a permission prompt waits is owed too', () => {
    const redraw = createTurnRedraw()
    redraw.widened('waiting')
    expect(redraw.settled('idle')).toBe(true)
  })
})
