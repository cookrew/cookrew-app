// How a machine's link shows on its figure. Three looks, a few accents:
//   online     full colour; LED green (connecting: amber; unpaired: a padlock on the portal)
//   offline    desaturated, LED grey (error: red) — its cached miniature still shows in the portal
//   never      outline only: registered, never reached
// `outdated` stays in colour with an amber sticker: it answers, it just has no levels API.
import type { MachineKind, MachineLink } from '../../../shared/strata'
import type { V3 } from '../iso/geom'
import type { Pen } from '../iso/pen'
import { AMBER, desaturate, desaturateMat, GREEN, RED, SCREEN, type Mat } from '../iso/tone'

export interface MachineInput {
  kind: MachineKind
  link: MachineLink
  /**
   * False = registered but never reached (no snapshot, live or cached): drawn
   * as an outline. Defaults to true.
   */
  reached?: boolean
  /**
   * The hardware's label or model id ('Mac mini', 'iMac (24-inch)', 'Mac14,3'),
   * for the desktop form. Not in the FigureKit seam (proposed); absent = a mini.
   */
  model?: string | null
}

export type MachineState = 'online' | 'connecting' | 'unpaired' | 'outdated' | 'offline' | 'error' | 'never'

export const stateOf = ({ link, reached = true }: MachineInput): MachineState => {
  if (!reached && link !== 'live') return 'never'
  if (link === 'live') return 'online'
  return link
}

export interface Look {
  state: MachineState
  ghost: boolean
  /** A body material as this state shows it. */
  mat: (m: Mat) => Mat
  hex: (c: string) => string
  screen: string
  led: string
  lock: boolean
  sticker: boolean
}

const LED_OFF = '#a49e90'

export const lookOf = (state: MachineState): Look => {
  const grey = state === 'offline' || state === 'error' || state === 'never'
  return {
    state,
    ghost: state === 'never',
    mat: grey ? (m) => desaturateMat(m) : (m) => m,
    hex: grey ? (c) => desaturate(c) : (c) => c,
    screen: grey ? '#4a524e' : SCREEN,
    led: state === 'error' ? RED : grey ? LED_OFF : state === 'connecting' || state === 'outdated' ? AMBER : GREEN,
    lock: state === 'unpaired',
    sticker: state === 'outdated'
  }
}

/** One machine kind: what to frame, and how to draw it. */
export interface MachineModel {
  fit: V3[]
  /** The surface its own cast shadow falls on (for framing). */
  shadowZ: number
  draw(p: Pen, look: Look): { svg: string; portal: V3[]; body: V3[] }
}
