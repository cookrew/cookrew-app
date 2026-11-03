// A PET'S CARD GROWS OUT OF ITS FACE (renderer/pets/pet-morph.ts): the first
// frame lays the card exactly over the avatar, the last is the card itself.
import { describe, expect, it } from 'vitest'
import { CONTENT_FRAMES, MORPH_CONTENT_FROM, faceTransform, morphFrames } from '../src/renderer/src/pets/pet-morph'

const face = { left: 1700, top: 600, width: 38, height: 38 }
const card = { left: 1340, top: 420, width: 340, height: 300 }

describe('faceTransform', () => {
  it('moves the card centre onto the face centre and scales it to the face', () => {
    // Face centre (1719, 619); card centre (1510, 570).
    expect(faceTransform(face, card)).toBe('translate(209px, 49px) scale(0.1118, 0.1267)')
  })
  it('a card already over the face at its size is no transform at all', () => {
    expect(faceTransform(card, card)).toBe('translate(0px, 0px) scale(1, 1)')
  })
  it('an unmeasured card is left alone', () => {
    expect(faceTransform(face, { ...card, width: 0 })).toBe('none')
  })
})

describe('morphFrames', () => {
  it('starts as the round face and ends as the card with its own corners', () => {
    const [from, to] = morphFrames(face, card, '14px')
    expect(from).toMatchObject({ borderRadius: '50%', transform: faceTransform(face, card) })
    expect(to).toMatchObject({ borderRadius: '14px', transform: 'none' })
  })
  it('keeps the contents hidden until the card is mostly grown', () => {
    expect(CONTENT_FRAMES[1]).toEqual({ opacity: 0, offset: MORPH_CONTENT_FROM })
    expect(MORPH_CONTENT_FROM).toBeGreaterThan(0.4)
  })
})
