/**
 * THE PHONE'S WORDS IN THE SCENE: ONE SIZE EACH, WHEREVER THE CAMERA IS
 * (owner, 2026-11-02: "the phone's font sizes are all over the place";
 * 2026-11-03: "as the canvas zooms the type still changes size: whatever view
 * the main screen zooms to, keep the type the same everywhere").
 *
 * The zoom draws its words in scene units, and the camera scales the scene
 * from about 0.1 (the devices) to 1.4 (the card), and every value between
 * while it moves. On a phone a word is never scaled with it: it is drawn at
 * its size ON SCREEN on every frame, as a map draws its labels, and a word
 * that has no room at that size fades instead of shrinking.
 *
 *   a name        13 (body): under a face at every per-row pick, in the open
 *                 card's head, in the full view's head
 *   a small word  10 (caption): a state, counts, a workspace's label, the
 *                 newest's caption, a machine's counts
 *   a machine     14 (title): its name at the devices stop and over its marks
 * (2026-11-03, a 360px Samsung: too big twice; now the desktop's own sizes.)
 *
 * The painter (zoom-frame.ts · paint) draws the moving words at `pinned()`:
 * their size over the camera's scale on this frame. Words inside a picture (a
 * thumbnail's title, "no agents" in a ring) cannot be pulled out of it: they
 * are set for their stop's scale at rest (--zv-k-*: phone-type.css) and seen
 * only while the camera is `near()` it. A desk keeps every factor at 1 and no
 * properties: its words are as zoom.css sets them.
 */
import { COL, ROW } from './zoom-layout'
import { ramp } from './zoom-path'

/** The phone's type scale, on screen, in CSS px (phone-type.css mirrors it). */
export const PHONE_TYPE = { caption: 10, control: 11, body: 13, title: 14, display: 18, input: 13 } as const

/** Each stop's camera scale at rest (zoom-frame.ts · restScales). */
export interface RestScales {
  crew: number
  card: number
  thumbs: number
  devices: number
  marks: number
}

/** The words under a face as zoom.css sets them on a phone, in scene px: size and line height. */
const NAME = { px: 15, line: 18 }
const STATUS = { px: 11, line: 13.2 }
const COUNTS = { px: 11, line: 11 }
/** Under a face (zoom-frame.ts · paint): the name's top below the anchor, the steps to the status and the counts. */
export const UNDER_FACE = { nameTop: 42, toStatus: 20, toCounts: 18, toDraft: 16 }
/** A face's radius (zoom.css · .zv-av: 64px). */
const FACE_R = 32
/** A name on the artifacts' shelf is drawn at this of its size on a desk (zoom-frame.ts · paint). */
export const SHELF_NAME_S = 0.78
/** Room kept between a name and its neighbour's, on screen. */
const NAME_GAP = 8

/** Each kind of word in the scene, on screen, on a phone. */
export const SCENE_TYPE = { name: PHONE_TYPE.body, small: PHONE_TYPE.caption, machine: PHONE_TYPE.title } as const
/** As zoom.css sets them, in a word's own px. */
export const SCENE_CSS = { name: NAME.px, small: STATUS.px, newCap: 9.5 } as const

/** The factor a word set at `css` px is drawn at to read at `px` on screen under a camera at `S`. */
export const pinned = (px: number, css: number, S: number): number => px / (css * Math.max(1e-4, S))

/**
 * How near a camera is to the scale a picture's words were set for: 1 within
 * 1%, 0 from 4% on. A word inside a picture shows only there, so it is always
 * seen at its size or not at all.
 */
export const near = (S: number, rest: number): number => 1 - ramp(Math.abs(Math.log(Math.max(1e-4, S) / Math.max(1e-4, rest))), 0.01, 0.04)

export interface SceneWords {
  /** A phone: the moving words are pinned on screen every frame. */
  live: boolean
  /** The counts' line under a face has room at the crew (it would reach the next row's face). */
  counts: boolean
  /** Each stop's scale at rest; all 1 on a desk. */
  rest: RestScales
  /** The workspace's label's factor at the crew and at the card, for their layout; 1 on a desk. */
  label: { crew: number; card: number }
  /** CSS custom properties for the words inside pictures, and the names' width. */
  vars: Record<string, string>
}

const DESK: SceneWords = { live: false, counts: true, rest: { crew: 1, card: 1, thumbs: 1, devices: 1, marks: 1 }, label: { crew: 1, card: 1 }, vars: {} }

/** How this screen's words are drawn: pinned on a phone, as zoom.css sets them on a desk. */
export function sceneWords(s: RestScales, narrow: boolean): SceneWords {
  if (!narrow) return DESK
  const name = pinned(SCENE_TYPE.name, NAME.px, s.crew)
  const status = pinned(SCENE_TYPE.small, STATUS.px, s.crew)
  // The counts' line ends above the next row's face, a couple of px clear.
  // Under a face: the name, then the counts on the line a state word would take (the crew shows none).
  const countsBottom = UNDER_FACE.nameTop + UNDER_FACE.toStatus * name + COUNTS.line * status
  // A name is cut short before its neighbour's, in its own px (it is drawn at body / 15 of them on screen).
  const pitch = COL * s.crew
  const nameMax = Math.max(40, Math.min(180, ((pitch - NAME_GAP) * NAME.px) / SCENE_TYPE.name))
  return {
    live: true,
    counts: countsBottom <= ROW - FACE_R - 2 / s.crew,
    rest: s,
    label: { crew: 1 / s.crew, card: 1 / s.card },
    vars: {
      '--zv-k-card': s.card.toFixed(4),
      '--zv-k-thumbs': s.thumbs.toFixed(4),
      '--zv-k-devices': s.devices.toFixed(4),
      '--zv-k-marks': s.marks.toFixed(4),
      '--zv-nm-max': `${Math.round(nameMax)}px`
    }
  }
}
