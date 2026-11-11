import { describe, expect, it } from 'vitest'
import { entryFrom } from '../src/renderer/src/zoom/remote-entry'

/**
 * ANOTHER MACHINE IS ENTERED IN PLACE (0.6.0): its view grows out of its own
 * frame on the devices stop, from where that frame stands and at its size, to
 * the whole view. Nothing pops over the page from nowhere.
 */

const stage = { x: 0, y: 48, w: 1200, h: 700 }

describe('where another machine’s view starts from', () => {
  it('is its own frame: the view is first seen through a window the size and place of that frame, and nothing is squeezed', () => {
    const from = { x: 300, y: 398, w: 300, h: 175 }
    // Clipped, not scaled: what is inside keeps its shape and its type its size, on a wide desk and a tall phone alike.
    expect(entryFrom(from, stage)).toEqual({ from: 'inset(350px 600px 175px 300px round 14px)', to: 'inset(0px 0px 0px 0px round 0px)' })
  })

  it('never reaches outside the view, whatever the frame’s box says', () => {
    expect(entryFrom({ x: -50, y: 20, w: 2000, h: 2000 }, stage)).toEqual({ from: 'inset(0px 0px 0px 0px round 14px)', to: 'inset(0px 0px 0px 0px round 0px)' })
  })

  it('is nothing when either is not on screen: the view is simply there', () => {
    expect(entryFrom({ x: 0, y: 0, w: 0, h: 0 }, stage)).toBeNull()
    expect(entryFrom({ x: 1, y: 1, w: 10, h: 10 }, { x: 0, y: 0, w: 0, h: 0 })).toBeNull()
    expect(entryFrom({ x: Number.NaN, y: 0, w: 10, h: 10 }, stage)).toBeNull()
  })
})
