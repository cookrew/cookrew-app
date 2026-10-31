// VENDORED from docs/brand-ink-2026-10-31/ink-marks.js (the brand draft, which is not in git) so
// scripts/brand-ink/site-brand-ink.mjs can regenerate the site logo. Pure: no DOM until stroke()/defs().
// INK MARKS — the Cookrew logo (one hand pushing up the glasses) and the
// harness avatars (Claude Code, Codex, OpenCode, Pi, Shell), each drawn as
// one brush stroke. A mark is a list of control points [x, y, pressure?] in a
// 100×100 box; `strokeOf` turns it into an even-spaced centre line, and
// `brushPath` turns that line into a filled brush outline whose width follows
// the brush angle, the pressure and a taper, with a dry-brush tail.
// Classic script (window.InkMarks) so it also loads from a file:// page.
;(function (root) {
  'use strict'
  const TAU = Math.PI * 2

  // ── geometry ────────────────────────────────────────────────────────────
  const arc = (cx, cy, r0, a0, a1, p0 = 1, p1 = 1, r1 = r0) => {
    const n = Math.max(8, Math.ceil(Math.abs(a1 - a0) / 0.12))
    const out = []
    for (let i = 0; i <= n; i++) {
      const u = i / n
      const a = a0 + (a1 - a0) * u
      const r = r0 + (r1 - r0) * u
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a), p0 + (p1 - p0) * u])
    }
    return out
  }

  const pressureOf = (p) => (p.length > 2 ? p[2] : 1)

  /** Catmull-Rom through the control points, sampled by segment length. */
  function spline(pts) {
    if (pts.length < 3) return pts.slice()
    const out = []
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i]
      const p1 = pts[i]
      const p2 = pts[i + 1]
      const p3 = pts[i + 2] || p2
      const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
      const steps = Math.max(2, Math.ceil(len / 0.8))
      for (let s = 0; s < steps; s++) {
        const t = s / steps
        const t2 = t * t
        const t3 = t2 * t
        const c = (k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)
        out.push([c(0), c(1), pressureOf(p1) + (pressureOf(p2) - pressureOf(p1)) * t])
      }
    }
    out.push(pts[pts.length - 1].length > 2 ? pts[pts.length - 1] : [...pts[pts.length - 1], 1])
    return out
  }

  /** Straight segments with corners rounded by two passes of Chaikin. */
  function linear(pts) {
    let line = pts.map((p) => [p[0], p[1], pressureOf(p)])
    for (let pass = 0; pass < 2; pass++) {
      const next = [line[0]]
      for (let i = 0; i < line.length - 1; i++) {
        const a = line[i]
        const b = line[i + 1]
        next.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1], 0.75 * a[2] + 0.25 * b[2]])
        next.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1], 0.25 * a[2] + 0.75 * b[2]])
      }
      next.push(line[line.length - 1])
      line = next
    }
    const out = []
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

  /** Even arc-length spacing, so the brush and the reveal move at one speed. */
  function resample(line, step = 0.55) {
    const out = [line[0]]
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

  // ── the marks ───────────────────────────────────────────────────────────
  // Each starts where a brush would land and ends where it would lift.

  /** The logo spells COO in one stroke, as the glove lockup does: the hand
   *  is the C, the glasses are the OO. The brush lands on the thumb (the C's
   *  lower tip), sweeps round the bottom and up the back of the hand, over
   *  the top, and the index finger comes down to press the left lens at its
   *  rim. Then round the left lens, over the bridge, round the right lens
   *  (once more, smaller — the glint), and it lifts off along the temple. */
  const logo = () => {
    // the thumb: a fat rounded tip curling in under the left lens
    const thumb = [[42.2, 61.2, 1.35], [45.4, 64.6, 1.4], [43.6, 69.4, 1.2], [37.8, 72, 1.15]]
    // the back of the hand: the C's spine, from the bottom round to the top
    const hand = arc(25.5, 50.5, 22, 1.22, 2 * Math.PI - 1.02, 1.15, 0.95, 21.2)
    // the index finger leaves the C, runs over the left lens and hooks down onto its rim
    const finger = [[37.4, 31, 0.8], [43.2, 29.4, 0.85], [48.8, 30, 0.9], [52, 33, 1.05], [50.2, 37.4, 1.1]]
    const left = arc(47.5, 51, 12.6, -1.62, 2 * Math.PI, 0.8, 0.65, 11.9)
    const bridge = [[64.2, 46.2, 0.35]]
    const right = arc(77.5, 51, 11.4, Math.PI, 3 * Math.PI + 0.75 * Math.PI + 0.42, 0.65, 0.5, 10.3)
    const temple = [[91.6, 40.6, 0.55], [97, 39.8, 0.45], [102.5, 42.8, 0.3]]
    return { kind: 'spline', pts: [...thumb, ...hand, ...finger, ...left, ...bridge, ...right, ...temple] }
  }

  /** Claude Code: the spark — eleven uneven rays in one zigzag through the centre. */
  const claude = () => {
    const rays = [40, 31, 37, 29, 41, 34, 30, 38, 33, 36, 30]
    const pts = []
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
  const codex = () => {
    const pts = []
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
  const opencode = () => ({
    kind: 'linear',
    pts: [
      [41, 41, 0.6], [59, 41, 0.95], [59, 59, 0.95], [41, 59, 0.95], [41, 44, 0.8], [33, 33, 0.22], [27, 27, 0.6],
      [73, 27, 1], [73, 73, 1], [27, 73, 1], [27, 36, 0.8], [30, 82, 0.2], [50, 82, 0.9], [62, 82, 0.6]
    ]
  })

  /** Pi: π in running hand — left leg up, a hair back, the bar, a hair under it, the right leg kicking out. */
  const pi = () => ({
    kind: 'spline',
    pts: [
      [31, 84, 0.9], [32.5, 66, 1.05], [34.5, 46, 0.95], [35.5, 35, 0.6], [27, 37, 0.25], [17, 39.5, 0.45],
      [21, 32, 0.75], [40, 30.5, 1.05], [62, 29.5, 1.05], [84, 27, 0.8], [86, 30.5, 0.35], [74, 33.5, 0.22],
      [67, 37, 0.5], [65.5, 52, 0.95], [66.5, 70, 1.05], [70, 81, 0.9], [78.5, 84, 0.45]
    ]
  })

  /** Shell: the prompt — the chevron, a hair down, the underscore. */
  const shell = () => ({
    kind: 'linear',
    pts: [[22, 29, 0.55], [36, 40, 1.05], [49, 50, 0.95], [36, 60, 1.05], [22, 71, 0.55], [36, 73.5, 0.22], [53, 75, 0.6], [67, 75, 1.05], [83, 74, 0.7]]
  })

  /** The ensō every avatar sits in: heavy landing, open at the top left. */
  const enso = () => ({ kind: 'spline', pts: arc(50, 50.5, 44, -1.95, -1.95 + TAU * 0.9, 1.2, 0.35, 45.5) })
  /** The orchestrator's ensō closes. */
  const ensoClosed = () => ({ kind: 'spline', pts: arc(50, 50.5, 44, -1.95, -1.95 + TAU * 1.04, 1.2, 0.45, 43) })

  const MARKS = { logo, claude, codex, opencode, pi, shell, enso, ensoClosed }
  /** The viewBox each mark is drawn in; the logo is a wide COO, the rest are square. */
  const BOX = { logo: '-1 22 106 60' }
  const boxOf = (name) => BOX[name] || '-4 -4 108 108'
  const HARNESS = { 'Claude Code': 'claude', Codex: 'codex', OpenCode: 'opencode', Pi: 'pi', Shell: 'shell' }

  const cache = new Map()
  function strokeOf(name) {
    if (!cache.has(name)) {
      const mark = MARKS[name]()
      cache.set(name, resample(mark.kind === 'spline' ? spline(mark.pts) : linear(mark.pts)))
    }
    return cache.get(name)
  }

  // ── the brush ───────────────────────────────────────────────────────────
  const DEFAULTS = { width: 5.2, nib: 0.55, angle: -0.6, jitter: 0.12, dry: 0.22, seed: 7 }

  const noise = (i, seed) => 0.5 * Math.sin(i * 0.31 + seed) + 0.3 * Math.sin(i * 0.087 + seed * 1.7) + 0.2 * Math.sin(i * 1.13 + seed * 0.4)

  function widthAt(line, i, o) {
    const n = line.length
    const u = i / (n - 1)
    const prev = line[Math.max(0, i - 2)]
    const next = line[Math.min(n - 1, i + 2)]
    const theta = Math.atan2(next[1] - prev[1], next[0] - prev[0])
    const nib = 1 - o.nib + o.nib * Math.abs(Math.sin(theta - o.angle))
    const land = u < 0.04 ? 0.6 + 0.4 * (u / 0.04) : 1
    const lift = u > 0.86 ? Math.pow(Math.max(0, (1 - u) / 0.14), 0.65) : 1
    const p = line[i][2]
    return Math.max(0.12, (o.width / 2) * nib * land * lift * p * (1 + o.jitter * noise(i, o.seed)))
  }

  /**
   * The outline of the stroke drawn up to `upto` (0–1), and the dry-brush
   * bristles of its tail. Returns SVG path data.
   */
  function brushPath(name, opts = {}, upto = 1) {
    return brushFromLine(strokeOf(name), opts, upto)
  }

  /** A brush outline for any centre line (already resampled). */
  function brushFromLine(line, opts = {}, upto = 1) {
    const o = { ...DEFAULTS, ...opts }
    const n = line.length
    const end = Math.max(2, Math.floor((n - 1) * Math.min(1, upto)) + 1)
    const dryFrom = Math.floor((n - 1) * (1 - o.dry))
    const bodyEnd = Math.min(end, Math.max(2, dryFrom + Math.floor((n - dryFrom) * 0.35)))
    const left = []
    const right = []
    const widths = []
    for (let i = 0; i < end; i++) {
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
    // Flying white: the tail splits into bristles that run dry at different points.
    let bristles = ''
    if (end > dryFrom && o.dry > 0) {
      const strands = [-0.78, -0.42, -0.1, 0.22, 0.55, 0.86]
      strands.forEach((f, k) => {
        const stop = Math.min(end, n - Math.floor(((k * 37 + o.seed * 11) % 23) * (n - dryFrom) * 0.025))
        let d = ''
        let pen = false
        for (let i = dryFrom; i < stop; i++) {
          const gap = Math.sin(i * (0.21 + k * 0.05) + k * 2.1 + o.seed) > 0.72 - (i - dryFrom) / Math.max(1, n - dryFrom) * 0.5
          const [nx, ny, w] = widths[i]
          const x = (line[i][0] + nx * w * f).toFixed(2)
          const y = (line[i][1] + ny * w * f).toFixed(2)
          if (gap) {
            pen = false
            continue
          }
          d += `${pen ? 'L' : 'M'}${x} ${y}`
          pen = true
        }
        bristles += d
      })
    }
    const head = line[0]
    return { body, bristles, drop: { x: head[0], y: head[1], r: widthAt(line, 3, o) * 1.15 } }
  }

  /** Control points → an even centre line → the brush outline, for marks that are not in MARKS. */
  function brushPoints(pts, opts = {}, upto = 1, kind = 'spline') {
    return brushFromLine(resample(kind === 'spline' ? spline(pts) : linear(pts)), opts, upto)
  }

  const SVGNS = 'http://www.w3.org/2000/svg'
  const el = (tag, attrs) => {
    const node = document.createElementNS(SVGNS, tag)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
    return node
  }

  /**
   * One stroke as an SVG group: the wet bleed under it, the body, the
   * landing drop, the bristles. `set(t)` redraws it up to t.
   */
  function stroke(parent, name, opts = {}, transform = '') {
    const g = el('g', { class: 'ink-stroke', transform })
    const bleed = el('path', { class: 'ink-bleed', filter: 'url(#ink-bleed)' })
    const body = el('path', { class: 'ink-body', filter: 'url(#ink-rough)' })
    const drop = el('circle', { class: 'ink-body', filter: 'url(#ink-rough)' })
    const bristles = el('path', { class: 'ink-bristle', filter: 'url(#ink-rough)' })
    g.append(bleed, body, drop, bristles)
    parent.append(g)
    const set = (t) => {
      const p = brushPath(name, opts, t)
      bleed.setAttribute('d', p.body)
      body.setAttribute('d', p.body)
      bristles.setAttribute('d', p.bristles)
      drop.setAttribute('cx', p.drop.x)
      drop.setAttribute('cy', p.drop.y)
      drop.setAttribute('r', t > 0 ? p.drop.r : 0)
    }
    return { g, set, opts }
  }

  /** The filters a page needs once: rough edges and the wet halo. */
  function defs(svg) {
    const d = el('defs', {})
    d.innerHTML =
      '<filter id="ink-rough" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="4" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="1.1" xChannelSelector="R" yChannelSelector="G"/></filter>' +
      '<filter id="ink-bleed" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="0.9"/></filter>'
    svg.prepend(d)
  }

  /** Draw a stroke over `ms`, slow on landing and on lifting, as a hand does. */
  function animate(strokes, ms = 1400, delay = 0) {
    const total = strokes.length
    return new Promise((resolve) => {
      const start = performance.now() + delay
      const tick = (now) => {
        const raw = Math.max(0, Math.min(1, (now - start) / ms))
        const eased = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2
        strokes.forEach((s, k) => {
          const local = Math.max(0, Math.min(1, eased * total - k))
          s.set(local)
        })
        if (raw < 1) requestAnimationFrame(tick)
        else resolve()
      }
      requestAnimationFrame(tick)
    })
  }

  root.InkMarks = { MARKS, HARNESS, DEFAULTS, boxOf, brushPoints, arc, strokeOf, brushPath, stroke, defs, animate, spline, linear, resample, brushFromLine }
})(typeof window !== 'undefined' ? window : globalThis)
