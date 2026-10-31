/**
 * INK MARKS — the harness avatars drawn as one brush stroke each (Fresco's
 * ink-brand draft, docs/brand-ink-2026-10-31/ink-marks.js, ported as pure
 * geometry). A mark is a list of control points [x, y, pressure] in a
 * 100×100 box; `brushPath` turns it into a filled brush outline whose width
 * follows the brush angle, the pressure and a taper, with a dry-brush tail.
 * No DOM here: InkAvatar.tsx draws the paths.
 */

type Pt = [number, number, number?]
type Line = [number, number, number][]
interface Mark {
  kind: 'spline' | 'linear'
  pts: Pt[]
}

const TAU = Math.PI * 2

const arc = (cx: number, cy: number, r0: number, a0: number, a1: number, p0 = 1, p1 = 1, r1 = r0): Pt[] => {
  const n = Math.max(8, Math.ceil(Math.abs(a1 - a0) / 0.12))
  const out: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const u = i / n
    const a = a0 + (a1 - a0) * u
    const r = r0 + (r1 - r0) * u
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a), p0 + (p1 - p0) * u])
  }
  return out
}

const pressureOf = (p: Pt): number => (p.length > 2 && p[2] !== undefined ? p[2] : 1)

/** Catmull-Rom through the control points, sampled by segment length. */
function spline(pts: Pt[]): Line {
  const out: Line = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
    const steps = Math.max(2, Math.ceil(len / 0.8))
    for (let s = 0; s < steps; s++) {
      const t = s / steps
      const t2 = t * t
      const t3 = t2 * t
      const c = (k: 0 | 1): number =>
        0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)
      out.push([c(0), c(1), pressureOf(p1) + (pressureOf(p2) - pressureOf(p1)) * t])
    }
  }
  const last = pts[pts.length - 1]
  out.push([last[0], last[1], pressureOf(last)])
  return out
}

/** Straight segments with corners rounded by two passes of Chaikin. */
function linear(pts: Pt[]): Line {
  let line: Line = pts.map((p) => [p[0], p[1], pressureOf(p)])
  for (let pass = 0; pass < 2; pass++) {
    const next: Line = [line[0]]
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i]
      const b = line[i + 1]
      next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1], 0.75 * a[2] + 0.25 * b[2]])
      next.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1], 0.25 * a[2] + 0.75 * b[2]])
    }
    next.push(line[line.length - 1])
    line = next
  }
  const out: Line = []
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]
    const b = line[i + 1]
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.8))
    for (let s = 0; s < steps; s++) {
      const t = s / steps
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t])
    }
  }
  out.push(line[line.length - 1])
  return out
}

/** Even arc-length spacing, so the brush moves at one speed. */
function resample(line: Line, step = 0.55): Line {
  const out: Line = [line[0]]
  let carry = 0
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]
    const b = line[i]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (len === 0) continue
    let d = step - carry
    while (d <= len) {
      const t = d / len
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t])
      d += step
    }
    carry = len - (d - step)
  }
  out.push(line[line.length - 1])
  return out
}

/** Claude Code: the spark — eleven uneven rays in one zigzag through the centre. */
const claude = (): Mark => {
  const rays = [40, 31, 37, 29, 41, 34, 30, 38, 33, 36, 30]
  const pts: Pt[] = []
  for (let k = 0; k < rays.length; k++) {
    const a = -Math.PI / 2 + (k * TAU) / rays.length + (k % 2 ? 0.05 : -0.04)
    const b = a + TAU / rays.length / 2
    pts.push([50 + 4.5 * Math.cos(a - 0.2), 50 + 4.5 * Math.sin(a - 0.2), 1.05])
    pts.push([50 + rays[k] * Math.cos(a), 50 + rays[k] * Math.sin(a), 0.3])
    pts.push([50 + 4.5 * Math.cos(b), 50 + 4.5 * Math.sin(b), 1.05])
  }
  return { kind: 'linear', pts }
}

/** Codex: the knot — six interlaced loops traced as one spirograph turn. */
const codex = (): Mark => {
  const pts: Pt[] = []
  const R = 6
  const r = 1
  const d = 2.3
  const s = 4.4
  const n = 220
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * TAU + 0.35
    const x = (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t)
    const y = (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t)
    const p = 0.55 + 0.45 * Math.abs(Math.sin(3 * t))
    pts.push([50 + s * x, 50 + s * y, i < 6 ? 0.6 + i * 0.08 : p])
  }
  return { kind: 'linear', pts }
}

/** OpenCode: the block — a box drawn inside a box, then the cursor under it. */
const opencode = (): Mark => ({
  kind: 'linear',
  pts: [
    [41, 41, 0.6], [59, 41, 0.95], [59, 59, 0.95], [41, 59, 0.95], [41, 44, 0.8], [33, 33, 0.22], [27, 27, 0.6],
    [73, 27, 1], [73, 73, 1], [27, 73, 1], [27, 36, 0.8], [30, 82, 0.2], [50, 82, 0.9], [62, 82, 0.6]
  ]
})

/** Pi: π in running hand. */
const pi = (): Mark => ({
  kind: 'spline',
  pts: [
    [31, 84, 0.9], [32.5, 66, 1.05], [34.5, 46, 0.95], [35.5, 35, 0.6], [27, 37, 0.25], [17, 39.5, 0.45],
    [21, 32, 0.75], [40, 30.5, 1.05], [62, 29.5, 1.05], [84, 27, 0.8], [86, 30.5, 0.35], [74, 33.5, 0.22],
    [67, 37, 0.5], [65.5, 52, 0.95], [66.5, 70, 1.05], [70, 81, 0.9], [78.5, 84, 0.45]
  ]
})

/** Shell: the prompt — the chevron, a hair down, the underscore. */
const shell = (): Mark => ({
  kind: 'linear',
  pts: [[22, 29, 0.55], [36, 40, 1.05], [49, 50, 0.95], [36, 60, 1.05], [22, 71, 0.55], [36, 73.5, 0.22], [53, 75, 0.6], [67, 75, 1.05], [83, 74, 0.7]]
})

/** The ensō every avatar sits in: heavy landing, open at the top left; the orchestrator's closes. */
const enso = (): Mark => ({ kind: 'spline', pts: arc(50, 50.5, 44, -1.95, -1.95 + TAU * 0.9, 1.2, 0.35, 45.5) })
const ensoClosed = (): Mark => ({ kind: 'spline', pts: arc(50, 50.5, 44, -1.95, -1.95 + TAU * 1.04, 1.2, 0.45, 43) })
/** The ownership tie: one bowed stroke, heavy at the owner, dry at the member. */
const tie = (): Mark => ({ kind: 'spline', pts: [[3, 50, 0.75], [22, 48.8, 1.05], [52, 48.5, 1], [80, 49.3, 0.8], [97, 50.4, 0.45]] })

export const MARKS = { claude, codex, opencode, pi, shell, enso, ensoClosed, tie }
export type MarkName = keyof typeof MARKS
export type HarnessMark = 'claude' | 'codex' | 'opencode' | 'pi' | 'shell'

/** Which mark a preset draws: by its name, else the shell prompt. */
export function harnessMark(preset: string | null | undefined): HarnessMark {
  const p = (preset ?? '').toLowerCase()
  if (p.includes('claude')) return 'claude'
  if (p.includes('codex')) return 'codex'
  if (p.includes('opencode')) return 'opencode'
  if (p === 'pi' || p.startsWith('pi ') || p.includes('pi agent') || p === 'pi-agent') return 'pi'
  return 'shell'
}

const cache = new Map<MarkName, Line>()
export function strokeOf(name: MarkName): Line {
  let line = cache.get(name)
  if (!line) {
    const mark = MARKS[name]()
    line = resample(mark.kind === 'spline' ? spline(mark.pts) : linear(mark.pts))
    cache.set(name, line)
  }
  return line
}

export interface BrushOpts {
  width: number
  nib: number
  angle: number
  jitter: number
  dry: number
  seed: number
}
export const BRUSH: BrushOpts = { width: 5.2, nib: 0.55, angle: -0.6, jitter: 0.12, dry: 0.22, seed: 7 }

const noise = (i: number, seed: number): number => 0.5 * Math.sin(i * 0.31 + seed) + 0.3 * Math.sin(i * 0.087 + seed * 1.7) + 0.2 * Math.sin(i * 1.13 + seed * 0.4)

function widthAt(line: Line, i: number, o: BrushOpts): number {
  const n = line.length
  const u = i / (n - 1)
  const prev = line[Math.max(0, i - 2)]
  const next = line[Math.min(n - 1, i + 2)]
  const theta = Math.atan2(next[1] - prev[1], next[0] - prev[0])
  const nib = 1 - o.nib + o.nib * Math.abs(Math.sin(theta - o.angle))
  const land = u < 0.04 ? 0.6 + 0.4 * (u / 0.04) : 1
  const lift = u > 0.86 ? Math.pow(Math.max(0, (1 - u) / 0.14), 0.65) : 1
  return Math.max(0.12, (o.width / 2) * nib * land * lift * line[i][2] * (1 + o.jitter * noise(i, o.seed)))
}

export interface BrushPaths {
  body: string
  bristles: string
  drop: { x: number; y: number; r: number }
}

/** The brush outline of a whole mark, and the dry-brush bristles of its tail, as SVG path data. */
export function brushPath(name: MarkName, opts: Partial<BrushOpts> = {}): BrushPaths {
  const o = { ...BRUSH, ...opts }
  const line = strokeOf(name)
  const n = line.length
  const dryFrom = Math.floor((n - 1) * (1 - o.dry))
  const bodyEnd = Math.min(n, Math.max(2, dryFrom + Math.floor((n - dryFrom) * 0.35)))
  const left: string[] = []
  const right: string[] = []
  const widths: [number, number, number][] = []
  for (let i = 0; i < n; i++) {
    const a = line[Math.max(0, i - 1)]
    const b = line[Math.min(n - 1, i + 1)]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const nx = -(b[1] - a[1]) / len
    const ny = (b[0] - a[0]) / len
    const w = widthAt(line, i, o)
    widths.push([nx, ny, w])
    if (i < bodyEnd) {
      left.push(`${(line[i][0] + nx * w).toFixed(2)} ${(line[i][1] + ny * w).toFixed(2)}`)
      right.push(`${(line[i][0] - nx * w).toFixed(2)} ${(line[i][1] - ny * w).toFixed(2)}`)
    }
  }
  const body = `M${left.join('L')}L${right.reverse().join('L')}Z`
  let bristles = ''
  if (o.dry > 0) {
    const strands = [-0.78, -0.42, -0.1, 0.22, 0.55, 0.86]
    strands.forEach((f, k) => {
      const stop = Math.min(n, n - Math.floor(((k * 37 + o.seed * 11) % 23) * (n - dryFrom) * 0.025))
      let d = ''
      let pen = false
      for (let i = dryFrom; i < stop; i++) {
        const gap = Math.sin(i * (0.21 + k * 0.05) + k * 2.1 + o.seed) > 0.72 - ((i - dryFrom) / Math.max(1, n - dryFrom)) * 0.5
        if (gap) {
          pen = false
          continue
        }
        const [nx, ny, w] = widths[i]
        d += `${pen ? 'L' : 'M'}${(line[i][0] + nx * w * f).toFixed(2)} ${(line[i][1] + ny * w * f).toFixed(2)}`
        pen = true
      }
      bristles += d
    })
  }
  const head = line[0]
  return { body, bristles, drop: { x: head[0], y: head[1], r: widthAt(line, 3, o) * 1.15 } }
}

const pathCache = new Map<string, BrushPaths>()
/** brushPath, remembered: an avatar is drawn many times and its strokes never change. */
export function brushPathCached(name: MarkName, opts: Partial<BrushOpts> = {}): BrushPaths {
  const key = `${name}|${opts.width ?? ''}|${opts.nib ?? ''}|${opts.dry ?? ''}|${opts.seed ?? ''}`
  let paths = pathCache.get(key)
  if (!paths) {
    paths = brushPath(name, opts)
    pathCache.set(key, paths)
  }
  return paths
}
