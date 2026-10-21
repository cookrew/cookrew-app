// THE FIGURE KIT: colorfigures-style art for every level, as pure, memoized
// SVG strings with the anchors the stage flies to. Drop-in for the stand-in:
//   import { colorFigures } from './figures'
//
// Theme hook: every figure's root is <svg class="cf" color="#231e16">, and
// only outer silhouettes use currentColor. On a dark page set
// `.cf { color: <light ink> }` to lift them; fills keep their own paint.
import type { FigureKit } from '../seams'
import { avatarArt } from './avatar'
import { cardArt } from './card'
import { containerArt } from './container'
import { machineArt } from './machine'

export const colorFigures: FigureKit = {
  machine: (input) => machineArt(input),
  container: (input) => containerArt(input),
  avatar: (input) => avatarArt(input),
  attachment: (input) => cardArt(input)
}

/** Silhouette ink for a dark page (see the theme hook above). */
export const DARK_SILHOUETTE = '#e9e2cf'

export { AVATAR_VIEW, HARNESS_INK, type AvatarInput } from './avatar'
export { CARD_VIEW } from './card'
export { ARCHETYPES, archetypeOf, BALL, CAPACITY, CONTAINER_SCALE, containerArt, paletteOf, type Archetype, type ContainerInput } from './container'
export { MACHINE_VIEW, machineArt, portalSkew, stateOf, type MachineInput, type MachineState } from './machine'
export { avatarArt, cardArt }
