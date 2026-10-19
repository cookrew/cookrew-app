// THE DOCK AND THE FLIGHT — the two pure decisions behind the world's selector.
//
// The first world laid the fleet along an avenue that receded into fog, which
// was a picture of dormancy and a poor selector: the far islands were tiny,
// the view had to be orbited to read them, and nothing stood still. The owner
// asked for the opposite — a FIXED view with every workspace laid out to be
// chosen from, and a zoom INTO the one chosen. That is a dock (Roam's floor
// map, Mission Control's strip of desktops): a grid the camera never leaves
// until you pick, and a flight that takes you into the pick.
//
// Pure, so the grid and the path are tested without a GPU.

import type { WorldPlace } from './fleet'

export interface DockTile {
  id: string
  col: number
  row: number
  at: { x: number; y: number; z: number }
}

export interface DockPlan {
  cols: number
  rows: number
  /** Centre-to-centre spacing; every island fits inside it with a gutter. */
  pitch: number
  tiles: DockTile[]
  /** The grid's footprint on the floor, width (x) and depth (z). */
  span: { w: number; d: number }
}

const GAP = 44
const EMPTY_PLAN: DockPlan = { cols: 0, rows: 0, pitch: 0, tiles: [], span: { w: 0, d: 0 } }

/**
 * Lay the places out as a grid shaped like the screen: columns from the
 * aspect, rows from the count. Places arrive in the order they should read —
 * the active workspace first, then by recency (fleet.ts) — and read the way
 * text does, left to right, top (far) to bottom (near).
 *
 * One pitch for every cell, taken from the BIGGEST island, so the grid is
 * regular and the eye can count it; a crowded workspace is a bigger disc in
 * the same cell, which is the size cue already carried by the island.
 */
export function planDock(places: readonly WorldPlace[], aspect: number): DockPlan {
  const n = places.length
  if (n === 0) return EMPTY_PLAN
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * Math.max(0.5, aspect)))))
  const rows = Math.ceil(n / cols)
  const biggest = places.reduce((m, p) => Math.max(m, p.radius), 0)
  const pitch = biggest * 2 + GAP
  const tiles = places.map((place, i): DockTile => {
    const col = i % cols
    const row = Math.floor(i / cols)
    return {
      id: place.id,
      col,
      row,
      at: {
        x: (col - (cols - 1) / 2) * pitch,
        y: 0,
        // Row 0 is the FAR row: the camera looks toward -z, so far is the top
        // of the screen, and the first place reads first.
        z: (row - (rows - 1) / 2) * pitch
      }
    }
  })
  return { cols, rows, pitch, tiles, span: { w: cols * pitch, d: rows * pitch } }
}

/** How far a camera pitched at `pitch` must stand to frame the whole dock. */
export function dockDistance(
  plan: DockPlan,
  aspect: number,
  fovDeg: number,
  pitch: number,
  margin = 60
): number {
  if (plan.tiles.length === 0) return 400
  const halfV = Math.tan((fovDeg * Math.PI) / 360)
  // Width is seen square-on; depth is foreshortened by the pitch, and the
  // towers add height the frame must also hold.
  const needW = (plan.span.w / 2 + margin) / (halfV * Math.max(0.5, aspect))
  const needD = ((plan.span.d / 2) * Math.sin(pitch) + margin + 40) / halfV
  return Math.max(needW, needD)
}

/**
 * THE FLIGHT: van Wijk & Nuij, "Smooth and efficient zooming and panning"
 * (InfoVis 2003) — the path d3.interpolateZoom and Mapbox's flyTo take.
 *
 * `u` is how far the camera's focus travels across the floor, `w` is how
 * wide its view is (here: its distance). The path pulls out a little while
 * it pans and comes back in on arrival, so entering a tile from the far
 * corner of the dock does not read as a straight-line lunge. `S` is the
 * path's length in the paper's units; the duration is proportional to it,
 * so a short hop is quick and a long one is not rushed.
 */
export interface ZoomPath {
  S: number
  at: (t: number) => { u: number; w: number }
}

export function zoomPath(u1: number, w0: number, w1: number, rho = Math.SQRT2): ZoomPath {
  const rho2 = rho * rho
  const rho4 = rho2 * rho2
  const eps = 1e-6
  if (u1 < eps) {
    // Pure zoom: exponential in w, which is what a constant perceived speed
    // looks like when nothing pans.
    const S = Math.abs(Math.log(w1 / w0)) / rho
    const sign = w1 >= w0 ? 1 : -1
    return { S, at: (t) => ({ u: 0, w: w0 * Math.exp(sign * rho * t * S) }) }
  }
  const b0 = (w1 * w1 - w0 * w0 + rho4 * u1 * u1) / (2 * w0 * rho2 * u1)
  const b1 = (w1 * w1 - w0 * w0 - rho4 * u1 * u1) / (2 * w1 * rho2 * u1)
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0)
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1)
  const S = (r1 - r0) / rho
  const coshr0 = Math.cosh(r0)
  const sinhr0 = Math.sinh(r0)
  return {
    S,
    at: (t) => {
      const s = t * S
      return {
        u: (w0 / rho2) * (coshr0 * Math.tanh(rho * s + r0) - sinhr0),
        w: (w0 * coshr0) / Math.cosh(rho * s + r0)
      }
    }
  }
}

/**
 * Milliseconds for a flight of length S. Cockburn's survey puts zoom
 * animations at 0.3-1.0 s; the floor keeps a one-tile hop from feeling
 * instant and the ceiling keeps the far corner from feeling like travel.
 */
export function flightMs(S: number): number {
  return Math.round(Math.min(900, Math.max(380, S * 260)))
}
