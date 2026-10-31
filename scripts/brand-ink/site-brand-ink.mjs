// Generates registry/src/site-brand.ts: the cookrew.dev logo in ink (the owner asked on
// 2026-10-31 for the site logo in the style of coo-stroke.html). One brush C drawn from 12 o'clock counter-clockwise
// to 5, closing round the first lens; the glasses in one stroke; krew in English cursive in
// one stroke, a finer brush from the same hand. Version B of coo-stroke.html: an even,
// centred brush, the one that stays legible small.
//
// The site's documents run no script, so every stroke is baked here into static SVG path
// data, and the hero's draw-on is CSS: each stroke sits under a mask whose centre line
// unrolls with stroke-dashoffset, in the order the brush wrote them.
//
//   node scripts/brand-ink/site-brand-ink.mjs > registry/src/site-brand.ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const sandbox = {}
vm.runInNewContext(readFileSync(join(here, 'ink-marks.js'), 'utf8'), { globalThis: sandbox, window: sandbox })
const I = sandbox.InkMarks

const D = Math.PI / 180
const L = { cx: 50, cy: 50, r: 11 }
const R = { cx: 76.5, cy: 50, r: 11 }
const lens = (c, start, turns, r1) => I.arc(c.cx, c.cy, c.r, start, start + Math.PI * 2 * turns, 1.15, 0.6, r1)
const C = I.arc(L.cx, L.cy, 19.5, -90 * D, -300 * D, 1.1, 0.85, 19.5)
const GLASSES = [
  [101, 41.6, 0.35], [96, 40.8, 0.6], [91.2, 44, 0.85],
  ...lens(R, -0.42, 1.55, 10.3),
  [65.4, 47.6, 0.45], [63.25, 44.6, 0.35], [61.1, 47.6, 0.45],
  ...lens(L, 0, -1.04, 10.4)
]
const FIRST_O = lens(L, 0, -1.04, 10.4)
const KREW_RAW = [
  [106, 63, 0.4], [113, 56, 0.7], [119, 47, 0.9], [122, 40, 1], [120.5, 35.5, 0.9], [116.5, 36.5, 0.8], [114.2, 42, 1], [113, 50, 1.1], [112.4, 62, 1.1],
  [112.8, 55, 0.55], [115.4, 50, 0.7], [119.8, 47.6, 0.9], [121.4, 50.6, 0.9], [118.2, 54.2, 0.8], [114.8, 54.8, 0.6], [118.2, 56.2, 0.8], [121.2, 61.4, 1], [124.6, 62.5, 0.8],
  [127, 56, 0.7], [129.5, 48, 0.8], [131.4, 47.4, 0.7], [131.8, 50, 0.6], [134.5, 48.5, 0.8], [136.5, 49.6, 0.9], [136.2, 56, 1], [136.6, 62, 0.9], [139.5, 62.4, 0.7],
  [145, 56, 0.8], [149, 51, 0.9], [147, 47.4, 0.85], [143.4, 48.6, 0.85], [141.6, 53, 0.95], [142.4, 59, 1], [145.6, 62.6, 0.9], [150, 61.4, 0.8],
  [152.6, 49, 0.8], [152.4, 55, 1], [153.6, 60.6, 1], [156, 62.4, 0.9], [158.4, 59, 0.8], [159, 53, 0.8], [159.2, 49, 0.7], [159.4, 55, 1], [160.6, 60.6, 1],
  [163, 62.4, 0.9], [165.4, 59, 0.8], [166.2, 53, 0.9], [166.2, 48.8, 0.9], [164.6, 48.2, 0.6], [167.6, 47.4, 0.5], [173, 46, 0.3]
]
const KREW = KREW_RAW.map(([x, y, p]) => [104 + (x - 106) * 1.4, 62 + (y - 62) * 1.4, p])

const PEN = { width: 7, nib: 0.12, angle: 0, jitter: 0.05, dry: 0.08 }
const GLASS_PEN = { width: 3.2, nib: 0.5, angle: -0.6, jitter: 0.1, dry: 0.2 }
const WORD_PEN = { ...PEN, width: Math.max(3, PEN.width * 0.4), dry: PEN.dry * 0.7 }

/** Path data with one decimal: the strokes are 50–200 units wide, so a tenth is invisible. */
const tidy = (d) => d.replace(/(\d+\.\d)\d+/g, '$1').replace(/\.0(?=\D)/g, '')
const scaled = (pen, k) => ({ ...pen, width: pen.width * k })
/** `step` is the centre line's spacing in units: coarser for the small marks, whose outline
 * a browser draws at 30 px where a tenth of a unit is not a pixel. */
const brush = (pts, pen, step = 1) => {
  const p = I.brushFromLine(I.resample(I.spline(pts), step), pen)
  return { body: tidy(p.body), bristles: tidy(p.bristles) }
}
/** The centre line the hero's mask unrolls, every third resampled point. */
const centre = (pts) => {
  const line = I.resample(I.spline(pts))
  const keep = line.filter((_, i) => i % 3 === 0 || i === line.length - 1)
  return tidy('M' + keep.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L'))
}

/** One instance: filters with their own ids, then each stroke as bleed + body + bristles. */
function svg({ id, viewBox, cls, strokes, label, width, height, paper, draw }) {
  const defs =
    `<filter id="${id}r" x="-10%" y="-10%" width="120%" height="120%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="4" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="1.1" xChannelSelector="R" yChannelSelector="G"/></filter>` +
    `<filter id="${id}b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation=".9"/></filter>` +
    (draw
      ? strokes
          .map((s, i) => `<mask id="${id}m${i}" maskUnits="userSpaceOnUse" x="0" y="0" width="240" height="110"><path class="ink-draw ink-draw-${i}" d="${s.centre}" pathLength="1" fill="none" stroke="#fff" stroke-width="${s.reach}" stroke-linecap="round" stroke-linejoin="round"/></mask>`)
          .join('')
      : '')
  const body = strokes
    .map(
      (s, i) =>
        `<g${draw ? ` mask="url(#${id}m${i})"` : ''}><path id="${id}s${i}" d="${s.body}" filter="url(#${id}r)"/><use href="#${id}s${i}" opacity=".15" filter="url(#${id}b)"/>${s.bristles ? `<path d="${s.bristles}" fill="none" stroke="currentColor" stroke-width=".45" opacity=".8" filter="url(#${id}r)"/>` : ''}</g>`
    )
    .join('')
  const size = width ? ` width="${width}" height="${height}"` : ''
  const xmlns = paper ? ' xmlns="http://www.w3.org/2000/svg"' : ''
  const bg = paper ? `<rect x="${paper.x}" y="${paper.y}" width="${paper.w}" height="${paper.w}" rx="${paper.w * 0.22}" fill="#f4efe4"/>` : ''
  const color = paper ? ' color="#1b1814"' : ''
  return `<svg${xmlns} class="${cls}" viewBox="${viewBox}"${size} role="img" aria-label="${label}" fill="currentColor"${color}><defs>${defs}</defs>${bg}${body}</svg>`
}

function lockupStrokes(k, withCentre, step) {
  const parts = [
    { pts: C, pen: scaled(PEN, k) },
    { pts: GLASSES, pen: scaled(GLASS_PEN, k) },
    { pts: KREW, pen: scaled(WORD_PEN, k) }
  ]
  return parts.map(({ pts, pen }) => ({ ...brush(pts, pen, step), ...(withCentre ? { centre: centre(pts), reach: +(pen.width * 2.6).toFixed(1) } : {}) }))
}

const HERO = svg({ id: 'ikh', viewBox: '20 22 190 56', cls: 'cr-ink-lockup', strokes: lockupStrokes(1, true, 0.9), label: 'COOKREW', draw: true })
const MARK = svg({ id: 'ikm', viewBox: '22 22 186 56', cls: 'mark-coo', strokes: lockupStrokes(1.35, false, 2.2), label: 'Cookrew', width: 104, height: 31 })
const FAVICON = svg({
  id: 'ikf',
  viewBox: '20 20 60 60',
  cls: 'fav',
  strokes: [brush(C, scaled(PEN, 1.75), 1.6), brush(FIRST_O, scaled(GLASS_PEN, 1.9), 1.6)],
  label: 'Cookrew',
  width: 64,
  height: 64,
  paper: { x: 20, y: 20, w: 60 }
})

// The order and pace of coo-stroke.html's play(): C 0–0.95 s, glasses from 1.05 s for 1.1 s,
// the word from 2.25 s for 1.5 s.
const CSS = `.brand{display:flex;justify-content:flex-start;padding:4px 0 22px;color:var(--ink)}
.brand .cr-ink-lockup{display:block;width:min(100%,430px);height:auto;overflow:visible}
.ink-draw{stroke-dasharray:1 1;stroke-dashoffset:1;animation:ink-draw .95s cubic-bezier(.45,0,.55,1) forwards}
.ink-draw-1{animation-duration:1.1s;animation-delay:1.05s}.ink-draw-2{animation-duration:1.5s;animation-delay:2.25s}
@keyframes ink-draw{to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){.ink-draw{animation:none;stroke-dashoffset:0}}`

const out = `// The cookrew.dev logo in ink: one brush C round the first lens (12 o'clock counter-clockwise
// to 5), the glasses in one stroke, krew in cursive in one stroke — coo-stroke.html, version B
// (the centred brush), landed on the site by the owner on 2026-10-31. The hero draws it on load with CSS
// only (the documents run no script); the header carries it still; the favicon is the C round
// one lens on paper. GENERATED by scripts/brand-ink/site-brand-ink.mjs; regenerate rather
// than edit.

export const BRAND_LOCKUP_CSS = ${JSON.stringify(CSS)}

export const BRAND_LOCKUP_HTML = ${JSON.stringify(`<div class="brand">${HERO}</div>`)}

/** The header's mark: the whole lockup, still; it inherits the ink colour, so night turns it to paper. */
export const BRAND_MARK_SVG = ${JSON.stringify(MARK)}

export const FAVICON_SVG = ${JSON.stringify(FAVICON)}
`
process.stdout.write(out)
