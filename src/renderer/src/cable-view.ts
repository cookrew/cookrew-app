import type { CableLink, CableRect, Harness, Stub, Trunk } from './cable-route'

/**
 * WHAT OF THE HARNESS IS DRAWN AT THIS VIEWPORT.
 *
 * The router (cable-route.ts) never looks at the viewport — that is what
 * keeps it off the per-frame path. This layer does, and applies the rule the
 * first cable note measured on the live board: at a phone-readable zoom, 34
 * cables were drawn and exactly one had both ends on the stage; the other 33
 * were ink with no reader. So:
 *
 *  - a cable is a run only when BOTH its ends are on the stage — that is the
 *    only case where the line can be followed. The rule is zoom-aware without
 *    a threshold: at overview the whole board is on stage and every cable is
 *    a run; at working distance almost none are, and those become tabs;
 *  - a cable with ONE end on stage is a tab on that end: the name of what it
 *    reaches, in place of a line that leaves the screen;
 *  - a cable with no end on stage is not drawn at all;
 *  - hovering a card draws its cables whatever their reach, and lights them,
 *    because a touch is a question and the answer is the line.
 *
 * Everything here is a filter over an already-routed harness. It re-runs when
 * the viewport crosses a quarter-stage tile or a half-octave of zoom
 * (viewportKey) — a handful of times per screen of panning, never per frame —
 * and it recomputes no routes.
 */

/** The stage in flow coordinates: what the viewport can see. */
export interface Stage {
  x: number
  y: number
  width: number
  height: number
}

/** ReactFlow's viewport transform: [x, y, zoom]. */
export type Transform = readonly [number, number, number]

export interface ViewTrunk extends Trunk {
  /** Touches the hovered card. */
  hot: boolean
}

export interface ViewTab {
  card: string
  partner: string
  hot: boolean
}

export interface HarnessView {
  trunks: readonly ViewTrunk[]
  stubs: readonly Stub[]
  tabs: readonly ViewTab[]
  /** Links that touch the hovered card. */
  hot: ReadonlySet<string>
}

/** The flow-space rectangle the viewport shows. */
export function stageOf(transform: Transform, width: number, height: number): Stage {
  const [tx, ty, zoom] = transform
  const z = zoom > 0 ? zoom : 1
  return { x: -tx / z, y: -ty / z, width: width / z, height: height / z }
}

/**
 * A key that changes when the viewport moves a quarter of the stage or the
 * zoom crosses a half-octave, and not otherwise. The layer that draws the
 * harness subscribes to this string, so a pan re-renders it a few times per
 * screen instead of sixty times a second.
 */
export function viewportKey(transform: Transform, width: number, height: number): string {
  const [tx, ty, zoom] = transform
  const tileW = Math.max(1, width / 4)
  const tileH = Math.max(1, height / 4)
  const zb = Math.floor(Math.log2(zoom > 0 ? zoom : 1) * 2)
  return `${zb}:${Math.floor(-tx / tileW)}:${Math.floor(-ty / tileH)}`
}

/** Does the card touch the stage, padded by one tile on each axis — the same tiles viewportKey counts in. */
const intersects = (r: CableRect, s: Stage, padX: number, padY: number): boolean =>
  r.x < s.x + s.width + padX && r.x + r.width > s.x - padX && r.y < s.y + s.height + padY && r.y + r.height > s.y - padY

export function harnessView(
  harness: Harness,
  rects: readonly CableRect[],
  links: readonly CableLink[],
  stage: Stage,
  hovered: string | null
): HarnessView {
  // One tile of padding per axis, so culling errs toward drawing at the
  // stage's edge — and a wide, short stage does not reach into the next row.
  const padX = stage.width / 4
  const padY = stage.height / 4
  const byId = new Map(rects.map((r) => [r.id, r]))

  const drawn = new Set<string>()
  const hot = new Set<string>()
  const tabs: ViewTab[] = []
  for (const link of links) {
    const A = byId.get(link.a)
    const B = byId.get(link.b)
    if (!A || !B) continue
    const touchesHover = hovered !== null && (link.a === hovered || link.b === hovered)
    if (touchesHover) hot.add(link.id)
    const aOn = intersects(A, stage, padX, padY)
    const bOn = intersects(B, stage, padX, padY)
    if (!aOn && !bOn) continue
    if ((aOn && bOn) || touchesHover) {
      drawn.add(link.id)
      continue
    }
    // One end on stage: the name of what the cable reaches, where it leaves.
    if (aOn) tabs.push({ card: link.a, partner: link.b, hot: link.a === hovered })
    if (bOn) tabs.push({ card: link.b, partner: link.a, hot: link.b === hovered })
  }

  const trunks: ViewTrunk[] = []
  for (const t of harness.trunks) {
    const visible = t.links.filter((l) => drawn.has(l))
    if (visible.length === 0) continue
    trunks.push({ ...t, count: visible.length, links: visible, hot: visible.some((l) => hot.has(l)) })
  }
  const stubs = harness.stubs.filter((s) => drawn.has(s.link))
  return { trunks, stubs, tabs, hot }
}
