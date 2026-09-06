/**
 * THE MARK — a wireframe machine hand making a C (owner ruling, 2026-09-06:
 * "就他了", the all-wireframe lockup from docs/design/brand-renders.html).
 *
 * One geometry, drawn procedurally so the app, the site header and the
 * favicon cannot drift: a ring segment in a 32-unit box, centred (17,17),
 * outer radius 12, inner radius 6, open on the right between −40° and +40°;
 * flat pads at the fingertips and the thumb tip; a square cuff at the wrist,
 * bottom-left. The mesh is what makes it a wireframe: concentric arcs along
 * the band and radial spokes across it, every 15°.
 *
 * Colour is the caller's: every stroke is `currentColor`, so the mark is ink
 * on the cream bar and cyan on a phosphor ground. The glow, where wanted, is a
 * CSS filter on the element, never baked into the paths.
 */

const CX = 17
const CY = 17
const R_OUT = 12
const R_IN = 6
/** The opening, in degrees either side of the +x axis. */
const OPEN = 40

const rad = (deg: number): number => (deg * Math.PI) / 180
const pt = (r: number, deg: number): [number, number] => [
  +(CX + r * Math.cos(rad(deg))).toFixed(2),
  +(CY + r * Math.sin(rad(deg))).toFixed(2),
]
const p = (xy: [number, number]): string => `${xy[0]} ${xy[1]}`

/** An arc of radius r from `from` to `to` degrees, the LONG way round through the left. */
function arc(r: number, from: number, to: number): string {
  const a = pt(r, from)
  const b = pt(r, to)
  // sweep-flag 0 walks decreasing angles (counter-clockwise on screen), which
  // from −40° down to −320° (= +40°) is the whole back of the hand.
  return `M ${p(a)} A ${r} ${r} 0 1 0 ${p(b)}`
}

/** The band's outline: outer arc, the cuff, the thumb pad, inner arc, the fingertip pad. */
export function handOutline(): string {
  const tipOut = pt(R_OUT, -OPEN)
  const tipIn = pt(R_IN, -OPEN)
  const thumbOut = pt(R_OUT, OPEN)
  const thumbIn = pt(R_IN, OPEN)
  // the cuff leaves the band at about 150° and 105°; between them the wrist
  const cuffL = pt(R_OUT, 150)
  const cuffR = pt(R_OUT, 105)
  return [
    `M ${p(tipOut)}`,
    `A ${R_OUT} ${R_OUT} 0 0 0 ${p(cuffL)}`,
    `L 5.4 25.8 L 5.4 33 L 14.2 33 L ${p(cuffR)}`,
    `A ${R_OUT} ${R_OUT} 0 0 0 ${p(thumbOut)}`,
    `L ${p(thumbIn)}`,
    `A ${R_IN} ${R_IN} 0 1 1 ${p(tipIn)}`,
    'Z',
  ].join(' ')
}

/** The mesh: three arcs along the band and a spoke across it every 15°. */
export function handMesh(): string {
  const arcs = [7.5, 9, 10.5].map((r) => arc(r, -OPEN, -(360 - OPEN)))
  const spokes: string[] = []
  for (let deg = -OPEN - 15; deg > -(360 - OPEN); deg -= 15) {
    spokes.push(`M ${p(pt(R_IN, deg))} L ${p(pt(R_OUT, deg))}`)
  }
  return [...arcs, ...spokes].join(' ')
}

/** The cuff's seams: two lines across the wrist. */
export function handCuff(): string {
  return 'M 5.4 28.2 L 14.2 28.2 M 5.4 30.6 L 14.2 30.6'
}

export interface MarkOptions {
  /** Stroke width for the outline; the mesh is drawn at 40% of it. */
  stroke?: number
  /** Drop the mesh, for sizes under ~20 px where it would be noise. */
  plain?: boolean
  /** Attributes on the root svg — class, aria, width — as one string. */
  attrs?: string
}

/**
 * The mark as an SVG string, for the site (no React there). The React mark in
 * CrLogoMark.tsx draws the same three paths, and a test holds them equal.
 */
export function markSvg({ stroke = 1.5, plain = false, attrs = '' }: MarkOptions = {}): string {
  const mesh = plain
    ? ''
    : `<path d="${handMesh()}" fill="none" stroke="currentColor" stroke-width="${(stroke * 0.4).toFixed(2)}" stroke-linecap="round" opacity=".85"/>`
  return `<svg viewBox="0 0 32 32" ${attrs}><path d="${handOutline()}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linejoin="round"/>${mesh}<path d="${handCuff()}" fill="none" stroke="currentColor" stroke-width="${(stroke * 0.6).toFixed(2)}" stroke-linecap="round"/></svg>`
}

/** The brand's cyan, the one colour the wireframe wears on a phosphor ground. */
export const BRAND_CYAN = '#3ee8e0'
export const BRAND_CYAN_DIM = '#1c8a86'
export const BRAND_GROUND = '#0b0f12'

/**
 * The favicon: the mark in cyan on the dark tile, no mesh (it is 16–32 px).
 * Self-contained — a favicon has no stylesheet.
 */
export function faviconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${BRAND_GROUND}"/><g color="${BRAND_CYAN}" transform="translate(1.5 -1) scale(.9)">${markSvg({ stroke: 2.4, plain: true }).replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g></svg>`
}
