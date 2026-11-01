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

// THE KICK MUST NOT OWE ITSELF A KICK (owner's recording, 2026-11-01: an idle
// agent's desktop LIVE view repainted every 1–3 s). A kick dips the pane one
// column and settles back; the settle is wider than the dip, and the redraw
// the dip caused reads as a busy turn — so it was owed, paid at rest with
// another kick, and so on for ever.
describe('createTurnRedraw · sized', () => {
  it('a dip and its way back owe nothing, even while the redraw reads as busy', () => {
    const redraw = createTurnRedraw()
    redraw.sized(120, 'replied', 0)
    redraw.sized(119, 'thinking', 10)
    redraw.sized(120, 'thinking', 410)
    expect(redraw.settled('replied')).toBe(false)
  })

  it('kick after kick never feeds itself', () => {
    const redraw = createTurnRedraw()
    redraw.sized(120, 'idle', 0)
    let kicks = 0
    for (let at = 1000; at < 20000; at += 1000) {
      redraw.sized(119, 'thinking', at)
      redraw.sized(120, 'thinking', at + 400)
      if (redraw.settled('replied')) kicks += 1
    }
    expect(kicks).toBe(0)
  })

  it('a real widen mid-turn is still owed, right after a dip too', () => {
    const redraw = createTurnRedraw()
    redraw.sized(120, 'idle', 0)
    redraw.sized(119, 'thinking', 10)
    redraw.sized(160, 'thinking', 500)
    expect(redraw.settled('replied')).toBe(true)
  })

  it('the pane given back by a phone long ago is a widen', () => {
    const redraw = createTurnRedraw()
    redraw.sized(160, 'idle', 0)
    redraw.sized(45, 'idle', 1000)
    redraw.sized(160, 'thinking', 60_000)
    expect(redraw.settled('idle')).toBe(true)
  })

  it('a size merely noted is the width the next one is judged against', () => {
    const redraw = createTurnRedraw()
    redraw.note(45, 0)
    redraw.sized(160, 'thinking', 60_000)
    expect(redraw.settled('idle')).toBe(true)
    redraw.note(160, 61_000)
    redraw.sized(160, 'thinking', 62_000)
    expect(redraw.settled('idle')).toBe(false)
  })

  it('the first size it hears of is no widen', () => {
    const redraw = createTurnRedraw()
    redraw.sized(200, 'thinking', 0)
    expect(redraw.settled('idle')).toBe(false)
  })
})
