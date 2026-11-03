// THE FIGURE KIT: colorfigures-style art for every level, as pure, memoized
// SVG strings with the anchors the stage flies to. Drop-in for the stand-in:
//   import { colorFigures } from './figures'
//
// Theme hook: every figure's root is <svg class="cf" color="#231e16">, and
// only outer silhouettes use currentColor. On a dark page set
// `.cf { color: <light ink>; --cf-shadow: DARK_SHADOW }`: silhouettes lift,
// shadows fall darker than the paper, fills keep their own paint. Offline and
// last-known states recede by opacity, so they read on either paper.
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
/** Cast shadows read var(--cf-shadow); on a dark page set it to this (a shadow darker than its paper). */
export { DARK_SHADOW } from './iso/tone'

export { AVATAR_VIEW, HARNESS_INK, type AvatarInput } from './avatar'
export { CARD_VIEW } from './card'
export { BALL, CAPACITY, CONTAINER_SCALE, containerArt, MODULE_SEATS, paletteOf, THEMES, themesOf, type ContainerInput, type Theme } from './container'
export { desktopFormOf, MACHINE_VIEW, machineArt, portalSkew, stateOf, type DesktopForm, type MachineInput, type MachineState } from './machine'
export { avatarArt, cardArt }
