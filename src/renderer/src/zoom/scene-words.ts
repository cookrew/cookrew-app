/**
 * THE PHONE'S WORDS IN THE SCENE (owner, 2026-11-02: "the phone's font sizes are all over the place").
 *
 * The zoom draws its words in scene units, and each stop draws the scene at
 * its own camera scale. A phone's census measured the same 11px word at 4px
 * at five agents per row and at 15px on the open card: one size in CSS, a
 * dozen on screen. Here every word the scene shows at a resting stop is
 * pinned to the phone's type scale ON SCREEN (phone-type.css · PHONE_TYPE):
 *
 *   the crew    a name reads at body (16) where a column is wide, at control
 *               (13) where it is not; the status and counts at caption (11).
 *               The counts' line is left out where it would reach the next
 *               row's face (five to a row on a small phone).
 *   the card    the same name, status and counts in the card's head at title
 *               (18) and caption; the card's own words through CSS custom
 *               properties (each stop's scale at rest, phone-type.css).
 *   the shelf   over the artifacts, the agents' names at caption as they
 *               fade: the shelf is the troop's faces, no names.
 *   the label   the workspace's label at caption, at the crew, the card and the artifacts.
 *
 * The painter (zoom-frame.ts · paint) draws the words that move between
 * stops at these factors; the words seen at one stop only are sized in CSS
 * by the properties in `vars`. A desk keeps every factor at 1 and no
 * properties: its words are as zoom.css sets them.
 */
import { COL, ROW } from './zoom-layout'

/** The phone's type scale, on screen, in CSS px (phone-type.css mirrors it). */
export const PHONE_TYPE = { caption: 11, control: 13, body: 16, title: 18, display: 22 } as const

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
/** A name on the artifacts' shelf is drawn at this of its size (zoom-frame.ts · paint). */
export const SHELF_NAME_S = 0.78
/** A column narrower than this on screen takes the smaller name. */
const WIDE_COLUMN = 150
/** Room kept between a name and its neighbour's, on screen. */
const NAME_GAP = 8

export interface WordFactors {
  name: number
  status: number
}
export interface SceneWords {
  crew: WordFactors & { counts: boolean }
  card: WordFactors
  shelf: { name: number }
  /** The workspace's label at the crew, at the card and over the artifacts' shelf. */
  label: { crew: number; card: number; thumbs: number }
  /** CSS custom properties for the words seen at one stop only, and the names' width. */
  vars: Record<string, string>
}

const ONE: SceneWords = { crew: { name: 1, status: 1, counts: true }, card: { name: 1, status: 1 }, shelf: { name: 1 }, label: { crew: 1, card: 1, thumbs: 1 }, vars: {} }

/** How each stop's words are drawn on this screen: 1 everywhere on a desk. */
export function sceneWords(s: RestScales, narrow: boolean): SceneWords {
  if (!narrow) return ONE
  const pitch = COL * s.crew
  const namePx = pitch >= WIDE_COLUMN ? PHONE_TYPE.body : PHONE_TYPE.control
  const name = namePx / (NAME.px * s.crew)
  const status = PHONE_TYPE.caption / (STATUS.px * s.crew)
  // The counts' line ends above the next row's face, a couple of px clear.
  const countsBottom = UNDER_FACE.nameTop + UNDER_FACE.toStatus * name + UNDER_FACE.toCounts * status + COUNTS.line * status
  const counts = countsBottom <= ROW - FACE_R - 2 / s.crew
  // A name must fit the crew's column (the shelf shows faces only).
  const shelf = PHONE_TYPE.caption / (NAME.px * SHELF_NAME_S * s.thumbs)
  const crewMax = (pitch - NAME_GAP) / (s.crew * name)
  const nameMax = Math.max(40, Math.min(180, crewMax))
  return {
    crew: { name, status, counts },
    card: { name: PHONE_TYPE.title / (NAME.px * s.card), status: PHONE_TYPE.caption / (STATUS.px * s.card) },
    shelf: { name: shelf },
    label: { crew: 1 / s.crew, card: 1 / s.card, thumbs: 1 / s.thumbs },
    vars: {
      '--zv-k-card': s.card.toFixed(4),
      '--zv-k-thumbs': s.thumbs.toFixed(4),
      '--zv-k-devices': s.devices.toFixed(4),
      '--zv-k-marks': s.marks.toFixed(4),
      '--zv-nm-max': `${Math.round(nameMax)}px`
    }
  }
}

/** The words' own lines, for a test or a probe: what each reads at on screen at the crew. */
export function crewWordsOnScreen(s: RestScales, narrow: boolean): { name: number; status: number } {
  const w = sceneWords(s, narrow)
  return { name: NAME.px * w.crew.name * s.crew, status: STATUS.px * w.crew.status * s.crew }
}
