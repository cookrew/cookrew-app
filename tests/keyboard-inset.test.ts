import { describe, expect, it } from 'vitest'
import { keyboardInset, shouldResetPan } from '../src/renderer/src/keyboard-inset'

describe('keyboardInset (Defect 2: dock rides above the keyboard)', () => {
  it('is 0 when the visual viewport fills the layout viewport (no keyboard)', () => {
    expect(keyboardInset(844, 844, 0)).toBe(0)
  })
  it('equals the covered height when the keyboard shrinks the visual viewport', () => {
    // iPhone-ish: 844 layout, keyboard leaves 508 visible → 336px inset
    expect(keyboardInset(844, 508, 0)).toBe(336)
  })
  it('subtracts a pushed-down viewport offset too', () => {
    // visual viewport panned down 40px (offsetTop) → less bottom overlap
    expect(keyboardInset(844, 508, 40)).toBe(296)
  })
  it('never goes negative (viewport taller than layout, rubber-band)', () => {
    expect(keyboardInset(508, 844, 0)).toBe(0)
    expect(keyboardInset(844, 844, 100)).toBe(0)
  })
  it('is 0 where the engine already shrank the LAYOUT viewport', () => {
    // Chrome/Android honours interactive-widget=resizes-content: innerHeight
    // shrinks with the visual viewport, so there is no overlap left to inset.
    // Without this the shell would shrink twice by the keyboard's height.
    expect(keyboardInset(508, 508, 0)).toBe(0)
  })
})

describe('shouldResetPan (keyboard auto-rise: undo the engine self-scroll)', () => {
  it('does not touch the scroll position while no keyboard is up', () => {
    expect(shouldResetPan(0, 0)).toBe(false)
    expect(shouldResetPan(0, 40)).toBe(false)
  })
  it('leaves an unpanned viewport alone (calling scrollTo would be a no-op)', () => {
    expect(shouldResetPan(336, 0)).toBe(false)
  })
  it('corrects a keyboard-driven pan so the shell top is not scrolled away', () => {
    // Safari/iOS scrolls the page to reveal the focused element instead of
    // resizing the layout viewport. Pinch-zoom is off on the companion
    // (user-scalable=no), so a pan under a raised keyboard is never the user's.
    expect(shouldResetPan(336, 40)).toBe(true)
  })
})
