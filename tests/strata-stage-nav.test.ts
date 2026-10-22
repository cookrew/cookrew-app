import { describe, expect, it } from 'vitest'
import { judgePop, type PopFacts } from '../src/strata/stage/nav-signal'

const pop = (f: Partial<PopFacts>): boolean => judgePop({ ua: undefined, coarse: false, sinceEdgeTouch: Infinity, sinceIntent: Infinity, ...f })

describe('did the browser already animate this Back?', () => {
  it("the browser's own flag wins, both ways", () => {
    expect(pop({ ua: true })).toBe(true)
    expect(pop({ ua: false, coarse: true, sinceEdgeTouch: 10 })).toBe(false)
  })

  it('desktop toolbar Back, Alt+Left, mouse button 4: no flag, fine pointer: the stage flies', () => {
    expect(pop({ coarse: false })).toBe(false)
  })

  it('an edge touch the shell saw ended just before: the platform slid it', () => {
    expect(pop({ sinceEdgeTouch: 200 })).toBe(true)
    expect(pop({ sinceEdgeTouch: 2000 })).toBe(false)
  })

  it('a phone at the terminal: the edge swipe over the embed reaches no shell listener, and must not be played twice', () => {
    expect(pop({ coarse: true })).toBe(true)
  })

  it("a phone where the page itself asked (the shell's Back control, the embed's strata:out): the stage flies", () => {
    expect(pop({ coarse: true, sinceIntent: 120 })).toBe(false)
    expect(pop({ coarse: true, sinceIntent: 5000 })).toBe(true)
  })
})
