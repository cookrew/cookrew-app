// THE CONTAINERS — the part that is meant to be swapped.
//
// A container owns the room and nothing in it: the floor the slots sit on, the
// rim around them, and props in the margin OUTSIDE the grid. It is handed the
// grid and the projection and returns furniture, which is drawn behind every
// card. It cannot reach a card, size one or move one, so adding a container is
// additive by construction and the three card kinds keep reading the same way
// in all of them.
//
// Adding one: write the furniture, push it onto CONTAINERS. Nothing else in
// the canvas needs to know.

import { Dots, FaceText, Line, Solid } from './draw'
import { GUTTER, PITCH, type AnatomyGrid } from './layout'
import {
  boxCorners,
  corners,
  cylinder,
  dotGrid,
  haloOf,
  insetPlan,
  iso,
  lineOnTop,
  planOutline,
  ring,
  sideMatrix,
  slabOf,
  topTicks,
  type Plan,
  type Point3,
  type Projection
} from './iso-kit'

export interface AnatomyContainerCtx {
  grid: AnatomyGrid
  P: Projection
  /** The floor the slots stand on, already padded past the outer gutter. */
  floor: Plan
  /** Workspace name, for whatever plate the container engraves it on. */
  title: string
}

export interface AnatomyContainer {
  id: string
  /** Shown in the picker. English, like the rest of the app's chrome. */
  label: string
  furniture: (ctx: AnatomyContainerCtx) => React.ReactNode
  /**
   * Every extreme point this container's furniture reaches, floor included.
   * The camera is fitted to it, which is the whole of "the scene fits the
   * screen": a room's walls stand 54 units above a floor the cards sit on,
   * and fitting the floor alone pushed them off the stage.
   */
  extent: (floor: Plan, grid: AnatomyGrid) => Point3[]
}

/** The margin between the outermost slot and the floor's edge. */
export const FLOOR_PAD = GUTTER

export function floorOf(grid: AnatomyGrid): Plan {
  return {
    x: -FLOOR_PAD,
    y: -FLOOR_PAD,
    w: grid.cols * PITCH + FLOOR_PAD * 2,
    d: grid.rows * PITCH + FLOOR_PAD * 2,
    r: 6
  }
}

/* ---------- 1. the bench: a plate on feet, the neutral default ---------- */
function benchFurniture({ floor, P, title }: AnatomyContainerCtx): React.ReactNode {
  const feet = corners(floor, 16)
  const strip: Plan = { x: floor.x + 14, y: floor.y + floor.d - 8, w: floor.w - 28, d: 5, r: 1 }
  const ticks = topTicks(strip.x + 3, strip.x + strip.w - 3, 10, 5, strip.y + 0.8, 0.6, [1.8, 3.4], P)
  return (
    <>
      <path className="iso-halo" d={haloOf(floor, -13, 13, P)} />
      {feet.map(([x, y], i) => (
        <Solid key={i} paths={cylinder(x, y, 5.5, -13, 6, P, 20)} tone="lo" crease="none" />
      ))}
      <Solid paths={slabOf(floor, -7, 7, P, 6, 1.2)} tone="mid" crease="lo" className="an-floor" />
      <Line d={planOutline(insetPlan(floor, 6), 0, P, 6)} tone="faint" />
      <Solid paths={slabOf(strip, 0, 0.6, P, 2)} tone="lo" crease="none" />
      <Line d={ticks.minor} tone="lo" />
      <Line d={ticks.major} tone="mid" />
      <Line d={corners(floor, 8).map(([x, y]) => ring(x, y, 2, 0, P, 14)).join('')} tone="lo" />
      <Dots points={corners(floor, 8).map(([x, y]) => iso([x, y, 0], P))} size={0.6} tone="mid" />
      <FaceText transform={sideMatrix([floor.x + 16, floor.y], -2.6, P, 'left')} size={4} tone="mid">
        {title.toUpperCase()}
      </FaceText>
    </>
  )
}

/* ---------- 2. the control room: a floor between two walls ---------- */
const WALL_H = 54
function roomFurniture({ floor, P, title }: AnatomyContainerCtx): React.ReactNode {
  const back: Plan = { x: floor.x - 7, y: floor.y - 7, w: floor.w + 7, d: 7, r: 0.5 }
  const side: Plan = { x: floor.x - 7, y: floor.y, w: 7, d: floor.d, r: 0.5 }
  const panel = { x0: floor.x + 24, x1: floor.x + floor.w - 24, z0: 16, z1: WALL_H - 12 }
  const jacks: Array<[number, number]> = []
  for (let z = panel.z0 + 6; z < panel.z1 - 2; z += 9) {
    for (let x = panel.x0 + 8; x < panel.x1 - 6; x += 11) jacks.push([x, z])
  }
  const tiles: string[] = []
  for (let x = floor.x + 40; x < floor.x + floor.w - 8; x += 40) {
    tiles.push(lineOnTop([x, floor.y + 4], [x, floor.y + floor.d - 4], 0, P))
  }
  for (let y = floor.y + 40; y < floor.y + floor.d - 8; y += 40) {
    tiles.push(lineOnTop([floor.x + 4, y], [floor.x + floor.w - 4, y], 0, P))
  }
  return (
    <>
      <path className="iso-halo" d={haloOf(floor, -6, 6, P)} />
      <Solid paths={slabOf(floor, -4, 4, P, 4, 0.8)} tone="mid" crease="lo" className="an-floor" />
      <Line d={tiles.join('')} tone="faint" />
      {/* Painted back to front: the side wall is nearer the viewer at every
          azimuth this canvas uses, so it is drawn second. */}
      <Solid paths={slabOf(back, -4, WALL_H + 4, P, 1, 0.8)} tone="mid" className="an-wall" />
      <Solid paths={slabOf(side, -4, WALL_H + 4, P, 1, 0.8)} tone="mid" className="an-wall" />
      <Solid
        paths={slabOf({ x: panel.x0, y: floor.y - 7, w: panel.x1 - panel.x0, d: 2.4, r: 0.6 }, panel.z0, panel.z1 - panel.z0, P, 2, 0.4)}
        tone="mid"
        className="an-panel"
      />
      <Line
        d={jacks.map(([x, z]) => ring(x, floor.y - 4.55, 1.9, z, P, 10)).join('')}
        tone="lo"
      />
      <Dots points={jacks.map(([x, z]) => iso([x, floor.y - 4.55, z], P))} size={0.5} tone="mid" />
      <FaceText
        transform={sideMatrix([panel.x0, floor.y - 4.5], panel.z1 + 4, P, 'left')}
        size={4.4}
        tone="hi"
      >
        {title.toUpperCase()}
      </FaceText>
    </>
  )
}

/* ---------- 3. the board: a PCB with an edge connector ---------- */
function boardFurniture({ floor, P, title, grid }: AnatomyContainerCtx): React.ReactNode {
  const pads: React.ReactNode[] = []
  const n = Math.max(8, Math.round(floor.w / 26))
  const step = (floor.w - 80) / n
  for (let i = 0; i < n; i++) {
    pads.push(
      <Solid
        key={i}
        paths={slabOf({ x: floor.x + 40 + i * step, y: floor.y + floor.d - 9, w: step * 0.55, d: 7, r: 0.3 }, 0, 0.4, P, 2)}
        tone="lo"
        crease="none"
        className="an-pad"
      />
    )
  }
  const silk: Array<[number, number]> = []
  for (let c = 0; c <= grid.cols; c++) {
    for (let r = 0; r <= grid.rows; r++) silk.push(iso([c * PITCH, r * PITCH, 0], P))
  }
  return (
    <>
      <path className="iso-halo" d={haloOf(floor, -12, 12, P)} />
      {corners(floor, 13).map(([x, y], i) => (
        <Solid key={i} paths={cylinder(x, y, 4.5, -12, 6, P, 18)} tone="lo" crease="none" />
      ))}
      <Solid paths={slabOf(floor, -6, 6, P, 6, 0.8)} tone="mid" crease="lo" className="an-floor an-pcb" />
      <Line d={planOutline(insetPlan(floor, 4), 0, P, 6)} tone="faint" />
      {corners(floor, 13).map(([x, y], i) => (
        <Line key={i} d={`${ring(x, y, 4, 0, P, 18)}${ring(x, y, 2.3, 0, P, 14)}`} tone="lo" />
      ))}
      <Dots points={silk} size={0.55} tone="lo" />
      {pads}
      <Dots points={dotGrid(floor.x + 12, floor.y + 10, 3, 3, 5, 0, P)} size={0.5} tone="lo" />
      <FaceText transform={sideMatrix([floor.x + 14, floor.y], -1.8, P, 'left')} size={3.6} tone="mid">
        {`${title.toUpperCase()} · REV ${grid.cols}x${grid.rows}`}
      </FaceText>
    </>
  )
}

export const CONTAINERS: readonly AnatomyContainer[] = [
  {
    id: 'bench',
    label: 'Bench',
    furniture: benchFurniture,
    extent: (floor) => boxCorners(floor, -13, 0)
  },
  {
    id: 'room',
    label: 'Room',
    furniture: roomFurniture,
    extent: (floor) =>
      boxCorners(
        { ...floor, x: floor.x - 7, y: floor.y - 7, w: floor.w + 7, d: floor.d + 7 },
        -4,
        WALL_H + 4
      )
  },
  {
    id: 'board',
    label: 'Board',
    furniture: boardFurniture,
    extent: (floor) => boxCorners(floor, -12, 0)
  }
]

export function containerOf(id: string | null): AnatomyContainer {
  return CONTAINERS.find((c) => c.id === id) ?? CONTAINERS[0]
}
