/**
 * WHERE THE FULL VIEW DRAWS THINGS, so the way in can carry them there (owner
 * 2026-11-02: "like the draft", group-motion-pivot.html · full()). From the
 * card stop to the full view the draft never shows an empty sheet: the open
 * card's face and name go to the head, its thumbnails to the browsers-and-
 * notes column, its last words to the transcript, the reply box down to the
 * prompt, and the other faces to the docked troop. Then the real full view
 * (StageView) takes over from parts already standing where it draws them.
 *
 * Measured on the real full view (stage/StageView.tsx, AgentArtifacts.tsx,
 * pets/PetTroop.tsx), in the zoom root's pixels:
 *
 *   desktop  head face 46 px at (24, 18), name 21 px at (82, 21); transcript
 *            from (21, 81); cells 168x108 at x = w - 263, y = 117 + 124 j;
 *            the troop a column at x = w - 35, centred on the sheet
 *            (SHEET_INSET 78 / 12), faces 34 px every 46 px.
 *   phone    the head is the bar's (out of the root): face and words fade on
 *            the way up; cells 104x68 in a row at y = h - 89, x = 21 + 114 j;
 *            the troop a row at the top, faces 28 px every 16 px.
 *   item     desktop page from (76, 68), w - 152 x h - 82, "used by" at the
 *            head's right; phone page from (14, 106), w - 28 x h - 114.
 *
 * Pure: zoom-frame.ts reads it, tests pin it.
 */
import { stripFaces } from '../pets/pet-dock'

export interface Spot {
  x: number
  y: number
}

export interface FullPoses {
  /** The head's face, by its centre. */
  avatar: Spot & { size: number }
  /** The head's name, by its top-left, and its type size. */
  name: Spot & { px: number }
  /** The head's state line, by its top-left. */
  line: Spot
  /** The transcript's first line, by its top-left. */
  transcript: Spot
  /** Where the card's reply box goes: the prompt at the foot, by its top-left. */
  reply: Spot
  /** A phone draws the head on the bar, outside the view: the face and the words fade as they rise. */
  headFades: boolean
  /** The browsers-and-notes cell j, by its centre; o 0 for one the column has no room for. */
  cell: (j: number) => Spot & { w: number; h: number; o: number }
  /** The docked troop's face k of n, by its centre; o 0 for one behind "more". */
  dock: (k: number, n: number) => Spot & { size: number; o: number }
  /** An item's full view: its page, by its top-left and size (stage · stg-item-pane). */
  page: Spot & { w: number; h: number }
  /** The page's "used by" face j, by its centre (stage · zv-fv-used). */
  usedBy: (j: number) => Spot
  /** Another item, stepping aside to the left as the page opens: by its centre and scale; null where it only fades (a phone). */
  aside: (k: number) => (Spot & { s: number; o: number }) | null
}

const DESK = {
  avatar: { x: 47, y: 41, size: 46 },
  name: { x: 82, y: 21, px: 21 },
  line: { x: 82, y: 49 },
  transcript: { x: 21, y: 81 },
  cell: { right: 179, top: 171, pitch: 124, w: 168, h: 108 },
  dock: { right: 35, pitch: 46, size: 34, shown: 4, sheetTop: 78, sheetBottom: 12, grip: 26, more: 38 }
} as const

const PHONE = {
  avatar: { x: 28, y: -24, size: 28 },
  /** A name is one size on a phone wherever it stands (scene-words.ts · SCENE_TYPE.name): the head is no exception. */
  name: { x: 60, y: -36, px: 11 },
  line: { x: 60, y: -14 },
  transcript: { x: 15, y: 55 },
  cell: { left: 73, bottom: 55, pitch: 114, w: 104, h: 68 },
  /** The troop's strip (pets/pet-dock.ts · stripFaces): the first face's centre, the chip's after the last, 34 px on. */
  dock: { left: 43, y: 28, pitch: 16, size: 28, more: 34 }
} as const

export function fullPoses(w: number, h: number, narrow: boolean): FullPoses {
  if (narrow) {
    const P = PHONE
    return {
      avatar: P.avatar,
      name: P.name,
      line: P.line,
      transcript: P.transcript,
      reply: { x: 8, y: h + 12 },
      headFades: true,
    page: { x: 14, y: 106, w: w - 28, h: h - 114 },
    usedBy: (j) => ({ x: 278 + 22 * j, y: 32 }),
    aside: () => null,
      cell: (j) => {
        const x = P.cell.left + P.cell.pitch * j
        return { x, y: h - P.cell.bottom, w: P.cell.w, h: P.cell.h, o: x + P.cell.w / 2 <= w ? 1 : 0 }
      },
      dock: (k, n) => {
        const shown = Math.min(n, stripFaces('right', w))
        return k < shown
          ? { x: P.dock.left + P.dock.pitch * k, y: P.dock.y, size: P.dock.size, o: 1 }
          : { x: P.dock.left + P.dock.pitch * (shown - 1) + P.dock.more, y: P.dock.y, size: P.dock.size, o: 0 }
      }
    }
  }
  const D = DESK
  return {
    avatar: D.avatar,
    name: D.name,
    line: D.line,
    transcript: D.transcript,
    reply: { x: Math.max(16, w / 2 - 114), y: h + 12 },
    headFades: false,
    page: { x: 76, y: 68, w: w - 152, h: h - 82 },
    usedBy: (j) => ({ x: w - 220 + 22 * j, y: 38 }),
    aside: (k) => {
      const y = 96 + 46 * k
      return { x: 38, y, s: 56 / 168, o: y + 20 <= h ? 1 : 0 }
    },
    cell: (j) => {
      const y = D.cell.top + D.cell.pitch * j
      return { x: w - D.cell.right, y, w: D.cell.w, h: D.cell.h, o: y + D.cell.h / 2 <= h ? 1 : 0 }
    },
    dock: (k, n) => {
      const shown = Math.min(n, D.dock.shown)
      const more = n > shown ? D.dock.more : 0
      const column = D.dock.grip + shown * D.dock.pitch + more
      const top = (D.dock.sheetTop + h - D.dock.sheetBottom) / 2 - column / 2
      const x = w - D.dock.right
      if (k < shown) return { x, y: top + D.dock.grip + D.dock.size / 2 + D.dock.pitch * k, size: D.dock.size, o: 1 }
      return { x, y: top + D.dock.grip + shown * D.dock.pitch + D.dock.more / 2, size: D.dock.size, o: 0 }
    }
  }
}
