// Geometry for the iso engine: vectors, shapes in a plane's (u, v) coordinates,
// the 2D convex hull and convex clipping. Ported from colorfigures' core.js;
// everything here is pure and allocation-only.
//
// Model axes (as in colorfigures): x = depth (the front face looks toward
// viewer-right), y = width (+y runs viewer-left), z = up, ground at z = 0.

export type V3 = readonly [number, number, number]
export type V2 = readonly [number, number]
export type UV = readonly [number, number]

export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
export const neg = (a: V3): V3 => [-a[0], -a[1], -a[2]]
export const avg = (ps: readonly V3[]): V3 => {
  const n = ps.length || 1
  return ps.reduce<V3>((s, p) => [s[0] + p[0] / n, s[1] + p[1] / n, s[2] + p[2] / n], [0, 0, 0])
}

// ── 2D shapes in a plane's (u, v), v up ────────────────────────────────────

export const arcUV = (cu: number, cv: number, r: number, a0: number, a1: number, n = 7): UV[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180
    return [cu + r * Math.cos(a), cv + r * Math.sin(a)] as UV
  })

export const rectUV = (u0: number, v0: number, u1: number, v1: number): UV[] => [
  [u0, v0],
  [u1, v0],
  [u1, v1],
  [u0, v1]
]

/** Rounded rectangle, counter-clockwise; n = points per corner arc minus one. */
export const rrUV = (u0: number, v0: number, u1: number, v1: number, r: number, n = 4): UV[] =>
  r <= 0
    ? rectUV(u0, v0, u1, v1)
    : [
        ...arcUV(u1 - r, v0 + r, r, -90, 0, n),
        ...arcUV(u1 - r, v1 - r, r, 0, 90, n),
        ...arcUV(u0 + r, v1 - r, r, 90, 180, n),
        ...arcUV(u0 + r, v0 + r, r, 180, 270, n)
      ]

export const ellUV = (cu: number, cv: number, ru: number, rv: number, n = 16): UV[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI
    return [cu + ru * Math.cos(a), cv + rv * Math.sin(a)] as UV
  })

/** Planes: front-facing x = const (u = y, v = z), side y = const (u = x, v = z), horizontal z = const (u = x, v = y). */
export type Plane = (uv: UV) => V3
export const PX = (x: number): Plane => ([u, v]) => [x, u, v]
export const PY = (y: number): Plane => ([u, v]) => [u, y, v]
export const PZ = (z: number): Plane => ([u, v]) => [u, v, z]
export const on = (plane: Plane, uv: readonly UV[]): V3[] => uv.map(plane)

// ── 2D hull and clipping (screen space) ─────────────────────────────────────

const turn = (o: V2, a: V2, b: V2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

/** Monotone-chain convex hull. */
export const hull = (input: readonly V2[]): V2[] => {
  const pts = [...input].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (pts.length < 3) return pts
  const lo: V2[] = []
  for (const p of pts) {
    while (lo.length >= 2 && turn(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop()
    lo.push(p)
  }
  const up: V2[] = []
  for (const p of [...pts].reverse()) {
    while (up.length >= 2 && turn(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop()
    up.push(p)
  }
  return [...lo.slice(0, -1), ...up.slice(0, -1)]
}

export const signedArea = (poly: readonly V2[]): number =>
  poly.reduce((a, p, i) => {
    const q = poly[(i + 1) % poly.length]
    return a + p[0] * q[1] - q[0] * p[1]
  }, 0) / 2

/**
 * Sutherland–Hodgman: a convex or concave subject clipped by a CONVEX clip
 * polygon. Replaces SVG clipPath, so figures carry no ids that could collide
 * when the same memoized string is inlined many times on one page.
 */
export const clipConvex = (subject: readonly V2[], clip: readonly V2[]): V2[] => {
  const ccw = signedArea(clip) > 0
  const inside = (a: V2, b: V2, p: V2) => (ccw ? turn(a, b, p) >= 0 : turn(a, b, p) <= 0)
  const meet = (a: V2, b: V2, p: V2, q: V2): V2 => {
    const d = (a[0] - b[0]) * (p[1] - q[1]) - (a[1] - b[1]) * (p[0] - q[0])
    if (Math.abs(d) < 1e-9) return q
    const t = ((a[0] - p[0]) * (p[1] - q[1]) - (a[1] - p[1]) * (p[0] - q[0])) / d
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
  }
  return clip.reduce<V2[]>((out, a, i) => {
    const b = clip[(i + 1) % clip.length]
    if (out.length === 0) return out
    return out.flatMap((q, j) => {
      const p = out[(j + out.length - 1) % out.length]
      const qIn = inside(a, b, q)
      const pIn = inside(a, b, p)
      if (qIn) return pIn ? [q] : [meet(a, b, p, q), q]
      return pIn ? [meet(a, b, p, q)] : []
    })
  }, [...subject])
}
