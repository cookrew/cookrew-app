/**
 * A PET'S CARD GROWS OUT OF ITS FACE (owner, 2026-10-31: "no more pop-out —
 * the summary turns smoothly into being, from the selected avatar").
 *
 * The card is measured where it will sit, then drawn at first as exactly the
 * avatar's circle: moved onto the face and scaled down to its size. It
 * travels to its place and size, and its contents fade in only in the last
 * part, so no text is ever seen squashed. Closing plays the same frames
 * backwards, into the face. Pure geometry, so it is tested as numbers.
 */

export const MORPH_MS = 280
export const MORPH_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
/** Where in the morph the contents start to show (0..1). */
export const MORPH_CONTENT_FROM = 0.55

export interface Box {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** The transform that lays the card, at its final box, exactly over the face. */
export function faceTransform(face: Box, card: Box): string {
  if (card.width <= 0 || card.height <= 0) return 'none'
  const dx = face.left + face.width / 2 - (card.left + card.width / 2)
  const dy = face.top + face.height / 2 - (card.top + card.height / 2)
  const sx = face.width / card.width
  const sy = face.height / card.height
  return `translate(${round(dx)}px, ${round(dy)}px) scale(${round(sx, 4)}, ${round(sy, 4)})`
}

/** The card's own frames: from the face's circle to the card. */
export function morphFrames(face: Box, card: Box, radius: string): Keyframe[] {
  return [
    { transform: faceTransform(face, card), borderRadius: '50%', boxShadow: '0 0 0 rgba(0, 0, 0, 0)' },
    { transform: 'none', borderRadius: radius, boxShadow: '0 10px 30px rgba(0, 0, 0, 0.22)' }
  ]
}

/** The contents' frames: hidden while the card is still a face, then in. */
export const CONTENT_FRAMES: Keyframe[] = [
  { opacity: 0, offset: 0 },
  { opacity: 0, offset: MORPH_CONTENT_FROM },
  { opacity: 1, offset: 1 }
]

const round = (n: number, places = 2): number => {
  const k = 10 ** places
  return Math.round(n * k) / k
}
