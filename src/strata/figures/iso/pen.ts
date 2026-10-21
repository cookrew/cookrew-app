// The pen: colorfigures' projection and drawing primitives, bound to ONE frame
// (scale, offset, ink weight, wobble) instead of core.js's globals, so every
// figure is a pure function of its input. Every primitive returns an SVG
// string in the frame's viewBox units.
//
// The root <svg> (see frame.ts) sets fill="none", round caps/joins, the font
// and color=INK, so paths only carry what differs. Inner ink is INK; the outer
// silhouette is currentColor, so a dark theme can lift it by setting `color`
// on the figure without touching anything else.
import {
  avg,
  clipConvex,
  cross,
  dot,
  ellUV,
  hull,
  neg,
  norm,
  on,
  PX,
  PZ,
  rrUV,
  sub,
  type UV,
  type V2,
  type V3
} from './geom'
import { BOARD, INK, SH, SHADOW, tone, toneI, type Mat, type Shade } from './tone'

/** The iso basis: unit steps along x, y, z land here on screen (before the frame's scale). */
export const C = Math.cos(Math.PI / 6)
export const S = Math.sin(Math.PI / 6)
export const isoRaw = (p: V3): V2 => [(p[0] - p[1]) * C, (p[0] + p[1]) * S - p[2]]

/** Distance toward the viewer: draw smaller first. */
export const depthOf = (p: V3): number => p[0] + p[1] + p[2]
export const byDepth = (parts: ReadonlyArray<{ at: V3; svg: string } | null | false | undefined>): string =>
  parts
    .filter((p): p is { at: V3; svg: string } => Boolean(p))
    .map((p, i) => ({ ...p, i }))
    .sort((a, b) => depthOf(a.at) - depthOf(b.at) || a.i - b.i)
    .map((p) => p.svg)
    .join('')

/** One decimal, no "-0", no trailing ".0": numbers are most of a figure's bytes. */
export const num = (v: number): string => {
  const r = Math.round(v * 10) / 10
  return Object.is(r, -0) ? '0' : String(r)
}

export const escapeText = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export interface PenSpec {
  /** Model units → viewBox units. */
  s: number
  ox: number
  oy: number
  /** Ink weight multiplier: weights are authored as in colorfigures (2.8 silhouette … 0.9 detail). */
  k: number
  /** The viewBox width: silhouette weight follows a part's thickness as a share of it. */
  vw: number
  /** Hand wobble amplitude in viewBox units; 0 = none (always 0 at dot size). */
  wob: number
  seed: number
  /** Wobble sample spacing in viewBox units (default 9): bigger figures can afford coarser. */
  wobStep?: number
  /** Outline only (a machine never reached): no fills, only silhouettes and `keep` ink, all in currentColor. */
  ghost?: boolean
}

export interface InkOpts {
  close?: boolean
  /** currentColor instead of INK: the outer silhouette. */
  edge?: boolean
  color?: string
  extra?: string
  /** Kept in ghost mode, where only silhouettes (and these) are drawn. */
  keep?: boolean
}

export interface SphereOpts {
  /** Ink outline weight (authored units); 0 = none. */
  w?: number
  /** Dashed outline: a last-known state, not a live one. */
  dashed?: boolean
  /** Opacity of the whole ball. */
  opacity?: number
}

/** Below this authored weight, ink never wobbles: details stay crisp. */
const WOBBLE_MIN_W = 1.4
const WOBBLE_STEP = 9

export const makePen = (spec: PenSpec) => {
  const { s, ox, oy, k, vw, wob, seed } = spec
  const ghost = spec.ghost ?? false
  const wobStep = spec.wobStep ?? WOBBLE_STEP

  const P = (p: V3): V2 => {
    const [u, v] = isoRaw(p)
    return [ox + u * s, oy + v * s]
  }
  /** A model direction on screen, in viewBox units per model unit. */
  const Dv = (d: V3): V2 => {
    const [u, v] = isoRaw(d)
    return [u * s, v * s]
  }
  const d2 = (pts: readonly V2[], close = true): string =>
    pts.length === 0 ? '' : 'M' + pts.map((p) => num(p[0]) + ' ' + num(p[1])).join(' ') + (close ? 'Z' : '')
  const d3 = (pts: readonly V3[], close = true): string => d2(pts.map(P), close)

  // ── hand wobble: deterministic, spatially smooth, baked into the ink ──────
  const noise = (p: V2, axis: number): number =>
    Math.sin(p[0] * 0.13 + p[1] * 0.05 + seed + axis * 1.7) * 0.6 +
    Math.sin(p[1] * 0.17 - p[0] * 0.07 + seed * 2.3 + axis * 3.1) * 0.4
  const wobble = (pts: readonly V2[], close: boolean): V2[] => {
    const n = pts.length
    const segs = close ? n : n - 1
    const dense: V2[] = []
    for (let i = 0; i < segs; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % n]
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / wobStep))
      for (let j = 0; j < steps; j++) dense.push([a[0] + ((b[0] - a[0]) * j) / steps, a[1] + ((b[1] - a[1]) * j) / steps])
    }
    if (!close) dense.push(pts[n - 1])
    return dense.map((p) => [p[0] + wob * noise(p, 0), p[1] + wob * noise(p, 1)] as V2)
  }

  const stroke = (o: InkOpts) => (o.edge || ghost ? 'currentColor' : (o.color ?? INK))
  const inkD = (d: string, w: number, o: InkOpts = {}): string =>
    ghost && !o.edge && !o.keep
      ? ''
      : `<path d="${d}" stroke="${stroke(o)}" stroke-width="${num(Math.max(0.1, w * k))}"${o.extra ? ' ' + o.extra : ''}/>`
  /** Ink along screen points; heavy enough lines get the wobble. */
  const ink2 = (pts: readonly V2[], w = 1, o: InkOpts = {}): string => {
    const close = o.close ?? true
    const wobbly = wob > 0 && w >= WOBBLE_MIN_W && pts.length > 1
    return inkD(d2(wobbly ? wobble(pts, close) : pts, close), w, o)
  }
  const ink = (pts: readonly V3[], w = 1, o: InkOpts = {}): string => ink2(pts.map(P), w, o)
  const line = (pts: readonly V3[], w = 0.9, o: InkOpts = {}): string => ink(pts, w, { ...o, close: false })

  const fill2 = (pts: readonly V2[], c: string, extra = ''): string =>
    ghost ? '' : `<path d="${d2(pts)}" fill="${c}"${extra ? ' ' + extra : ''}/>`
  const fill = (pts: readonly V3[], c: string, extra = ''): string => fill2(pts.map(P), c, extra)
  /** A fill with a same-colour hairline, so lofted strips meet without seams. */
  const face = (pts: readonly V3[], c: string): string =>
    ghost ? '' : `<path d="${d3(pts)}" fill="${c}" stroke="${c}" stroke-width="${num(0.7 * k)}"/>`
  const shape = (pts: readonly V3[], c: string, w = 0.9): string => fill(pts, c) + (w ? ink(pts, w) : '')

  /** Loft between two equal closed rings; colour(n) shades each strip by its outward normal. */
  const loft = (A: readonly V3[], B: readonly V3[], colour: (n: V3) => string, flip = false): string => {
    const n = A.length
    const cen = avg([...A, ...B])
    let out = ''
    for (let i = 0; i < n; i++) {
      const a0 = A[i]
      const a1 = A[(i + 1) % n]
      const b1 = B[(i + 1) % n]
      const b0 = B[i]
      let nr = norm(cross(sub(a1, a0), sub(b0, a0)))
      if (!Number.isFinite(nr[0]) || (nr[0] === 0 && nr[1] === 0 && nr[2] === 0)) continue
      if (dot(nr, sub(avg([a0, a1, b1, b0]), cen)) < 0) nr = neg(nr)
      if (flip) nr = neg(nr)
      if (nr[0] + nr[1] + nr[2] > 1e-6) out += face([a0, a1, b1, b0], colour(nr))
    }
    return out
  }

  /**
   * Silhouette ink weighted by how thick the part is on screen (colorfigures'
   * hand-inker rule): thin rods and knobs stay light, bodies get the full w.
   */
  const hullInk = (pts: readonly V3[], w = 1.4, o: InkOpts = {}): string => {
    const h = hull(pts.map(P))
    let a = 0
    let per = 0
    for (let i = 0; i < h.length; i++) {
      const p = h[i]
      const q = h[(i + 1) % h.length]
      a += p[0] * q[1] - q[0] * p[1]
      per += Math.hypot(q[0] - p[0], q[1] - p[1])
    }
    const thick = per ? Math.abs(a) / per / vw : 0
    return ink2(h, Math.min(w, 0.9 + 20 * thick), { edge: true, ...o })
  }

  /** Axis-aligned box: its three visible faces, shaded and outlined. */
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: Mat, shade: Shade = toneI, w = 0.9): string =>
    shape([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], shade([0, 1, 0], m), w) +
    shape([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], shade([1, 0, 0], m), w) +
    shape([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], shade([0, 0, 1], m), w)
  const boxPts = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): V3[] =>
    [x0, x1].flatMap((x) => [y0, y1].flatMap((y) => [[x, y, z0] as V3, [x, y, z1] as V3]))

  /** A profile in (y, z) swept along x: the rounded bodies. Draws the sides only; cap and ink are the caller's. */
  const extrude = (profile: readonly UV[], x0: number, x1: number, m: Mat, shade: Shade = tone): string =>
    loft(on(PX(x0), profile), on(PX(x1), profile), (n) => shade(n, m))

  /** Upright cylinder with its top cap. */
  const cyl = (x: number, y: number, z0: number, z1: number, r: number, m: Mat, shade: Shade = toneI, w = 1.2, n = 16): string => {
    const A = on(PZ(z0), ellUV(x, y, r, r, n))
    const B = on(PZ(z1), ellUV(x, y, r, r, n))
    return loft(A, B, (nr) => shade(nr, m)) + fill(B, shade([0, 0, 1], m)) + hullInk([...A, ...B], w) + ink(B, w * 0.8)
  }

  /** Cylinder between two points (a rod, a pipe, a cable run); r1 tapers it. */
  const rod = (a: V3, b: V3, r: number, m: Mat, shade: Shade = toneI, w = 1, r1 = r, n = 12): string => {
    const d = norm(sub(b, a))
    const u = norm(cross(d, Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]))
    const v = cross(d, u)
    const ring = (p: V3, rr: number): V3[] =>
      Array.from({ length: n }, (_, i) => {
        const t = (i / n) * 2 * Math.PI
        const c = Math.cos(t) * rr
        const s2 = Math.sin(t) * rr
        return [p[0] + u[0] * c + v[0] * s2, p[1] + u[1] * c + v[1] * s2, p[2] + u[2] * c + v[2] * s2] as V3
      })
    const A = ring(a, r)
    const B = ring(b, r1)
    const capB = d[0] + d[1] + d[2] > 0
    const cap = capB ? B : A
    const cn = capB ? d : neg(d)
    return loft(A, B, (nr) => shade(nr, m)) + fill(cap, shade(cn, m)) + hullInk([...A, ...B], w)
  }

  /**
   * A ball, flat-banded like colorfigures: dark body, a mid disc and a light
   * disc offset toward the light, a small highlight, then the ink. Projected
   * radius is r·√1.5 (an iso sphere).
   */
  const sphere = (c: V3, r: number, m: Mat, o: SphereOpts = {}): string => {
    const [cx, cy] = P(c)
    const R = r * 1.2247 * s
    const disc = (dx: number, dy: number, rr: number, col: string) =>
      `<circle cx="${num(cx + dx * R)}" cy="${num(cy + dy * R)}" r="${num(rr * R)}" fill="${col}"/>`
    const w = o.w ?? 1.6
    const outline = w
      ? `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(R)}" stroke="currentColor" stroke-width="${num(w * k)}"${o.dashed ? ` stroke-dasharray="${num(R * 0.42)} ${num(R * 0.3)}"` : ''}/>`
      : ''
    if (ghost) return outline
    const body = disc(0, 0, 1, m.d) + disc(0.09, -0.1, 0.86, m.m) + disc(0.2, -0.24, 0.55, m.l) + disc(0.34, -0.42, 0.13, '#fffdf6')
    return (o.opacity !== undefined && o.opacity < 1 ? `<g opacity="${o.opacity.toFixed(2)}">${body}</g>` : body) + outline
  }
  /** A small round mark (a knob, a bolt, a peg) as a plain circle: cheap where an ellipse would not read. */
  const stud = (at: V3, r: number, c: string, w = 0.6): string => {
    const [cx, cy] = P(at)
    return ghost
      ? ''
      : `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r * s)}" fill="${c}"${w ? ` stroke="${INK}" stroke-width="${num(w * k)}"` : ''}/>`
  }
  /** The screen disc a sphere covers: its anchor rect. */
  const sphereRect = (c: V3, r: number) => {
    const [cx, cy] = P(c)
    const R = r * 1.2247 * s
    return { x: cx - R, y: cy - R, w: 2 * R, h: 2 * R }
  }

  /** Where a point falls as shadow on the plane z = z0. */
  const shadowOf = (p: V3, z0: number): V2 => P([p[0] + (p[2] - z0) * SH[0], p[1] + (p[2] - z0) * SH[1], z0])
  /**
   * Cast shadow of an outline (bottom and top points) onto z = z0, optionally
   * clipped to a convex surface (a board top) by geometry, not a clipPath.
   */
  const castShadow = (pts: readonly V3[], z0 = 0, clip: readonly V3[] | null = null, extra = ''): string => {
    const sh = hull(pts.map((p) => shadowOf(p, z0)))
    const poly = clip ? clipConvex(sh, hull(clip.map(P))) : sh
    return poly.length > 2 ? fill2(poly, SHADOW, extra) : ''
  }

  const boardTop = (x0: number, y0: number, x1: number, y1: number, h = 3, r = 5): V3[] => on(PZ(h), rrUV(x0, y0, x1, y1, r, 3))
  /** A slab for things to stand on; draw it first, then shadows clipped to boardTop(...). */
  const board = (x0: number, y0: number, x1: number, y1: number, h = 3, r = 5, m: Mat = BOARD): string => {
    const A = on(PZ(0), rrUV(x0, y0, x1, y1, r, 3))
    const B = boardTop(x0, y0, x1, y1, h, r)
    return loft(A, B, (n) => toneI(n, m)) + fill(B, m.l) + ink(B, 1) + hullInk([...A, ...B], 1.8)
  }

  /** A slab rounded in plan (a laptop base, a plinth, a tray): sides, top and its ink. */
  const slab = (x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, r: number, m: Mat, shade: Shade = tone, w = 1.6): string => {
    const A = on(PZ(z0), rrUV(x0, y0, x1, y1, r, 3))
    const B = on(PZ(z1), rrUV(x0, y0, x1, y1, r, 3))
    return loft(A, B, (n) => shade(n, m)) + fill(B, shade([0, 0, 1], m)) + ink(B, Math.min(1.1, w)) + hullInk([...A, ...B], w)
  }
  const slabPts = (x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, r: number): V3[] => [
    ...on(PZ(z0), rrUV(x0, y0, x1, y1, r, 3)),
    ...on(PZ(z1), rrUV(x0, y0, x1, y1, r, 3))
  ]

  /**
   * A soft cable from a to b sagging by `sag` model units: an ink stroke, a
   * colour stroke and a highlight along one quadratic curve.
   */
  const tube = (a: V3, b: V3, sag: number, r: number, m: Mat): string => {
    const at = (dx: number) => {
      const [ax, ay] = P(a)
      const [bx, by] = P(b)
      const [cx, cy] = P([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2 - 2 * sag])
      return `M${num(ax + dx)} ${num(ay + dx)}Q${num(cx + dx)} ${num(cy + dx)} ${num(bx + dx)} ${num(by + dx)}`
    }
    const width = 2 * r * s
    if (ghost) return ''
    return (
      `<path d="${at(0)}" stroke="${INK}" stroke-width="${num(width + 2.2 * k)}"/>` +
      `<path d="${at(0)}" stroke="${m.m}" stroke-width="${num(width)}"/>` +
      `<path d="${at(-width * 0.18)}" stroke="${m.l}" stroke-width="${num(width * 0.3)}"/>`
    )
  }

  // ── text on a plane: only on faces that look at the viewer ────────────────
  const matrix = (o: V2, U: V2, V: V2) =>
    `matrix(${U[0].toFixed(3)} ${U[1].toFixed(3)} ${V[0].toFixed(3)} ${V[1].toFixed(3)} ${num(o[0])} ${num(o[1])})`
  const unit = (v: V2): V2 => {
    const l = Math.hypot(v[0], v[1]) || 1
    return [v[0] / l, v[1] / l]
  }
  const textOn = (o: V3, along: V3, str: string, size: number, col = INK, weight = 700, anchor = 'middle'): string =>
    ghost
      ? ''
      : `<text transform="${matrix(P(o), unit(Dv(along)), unit(Dv([0, 0, -1])))}" font-size="${num(size * s)}" fill="${col}"${anchor === 'middle' ? ' text-anchor="middle"' : ''} font-weight="${weight}">${escapeText(str)}</text>`
  /** On a front plane x = const, centred at (y, z) baseline. */
  const tx = (x: number, y: number, z: number, str: string, size: number, col = INK, weight = 700): string =>
    textOn([x, y, z], [0, -1, 0], str, size, col, weight)
  /** On a side plane y = const, centred at (x, z) baseline. */
  const txY = (x: number, y: number, z: number, str: string, size: number, col = INK, weight = 700): string =>
    textOn([x, y, z], [1, 0, 0], str, size, col, weight)

  /** Bounding rect of projected points: anchors. */
  const rectOf = (pts: readonly V3[]) => {
    const q = pts.map(P)
    const xs = q.map((p) => p[0])
    const ys = q.map((p) => p[1])
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
  }

  return {
    spec,
    P,
    Dv,
    d2,
    d3,
    ink,
    ink2,
    inkD,
    line,
    fill,
    fill2,
    face,
    shape,
    loft,
    hullInk,
    box,
    boxPts,
    extrude,
    cyl,
    rod,
    sphere,
    sphereRect,
    stud,
    shadowOf,
    castShadow,
    boardTop,
    board,
    slab,
    slabPts,
    tube,
    textOn,
    tx,
    txY,
    rectOf
  }
}

export type Pen = ReturnType<typeof makePen>
