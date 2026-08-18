import { describe, expect, it } from 'vitest'
import { keyboardInset } from '../src/renderer/src/keyboard-inset'

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
})
