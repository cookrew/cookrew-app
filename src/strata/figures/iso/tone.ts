// Flat three-tone shading: one fixed light, one fixed view (colorfigures' sun at
// azimuth 105°: the front is lit, the left side is in shade, cast shadows fall
// to the lower left). Materials are { l, m, d } — light, mid and dark.
import { dot, norm, type V3 } from './geom'

export interface Mat {
  readonly l: string
  readonly m: string
  readonly d: string
}

export const INK = '#231e16'
export const SHADOW = '#41538f'
/**
 * Every cast shadow paints with this style: the colorfigures blue on light
 * paper, and whatever the page sets as --cf-shadow on dark paper (a shadow
 * must be darker than its paper; see DARK_SHADOW).
 */
export const SHADOW_STYLE = `style="fill:var(--cf-shadow,${SHADOW})"`
/** A shadow for the shell's dark paper (#17140f): a deep navy, darker than the paper's lightest neighbours. */
export const DARK_SHADOW = '#0b0d1c'
export const PAPER = '#f2efe7'

export const PALS = {
  mustard: { l: '#f4b829', m: '#d49c1f', d: '#4e4a18' },
  tomato: { l: '#ef6a4c', m: '#cf5038', d: '#4a2219' },
  mint: { l: '#93d3b0', m: '#71b693', d: '#1f4034' },
  cobalt: { l: '#76a0e2', m: '#5a82c6', d: '#1c2948' },
  blush: { l: '#f3a6bb', m: '#d8869c', d: '#4b2430' }
} as const satisfies Record<string, Mat>

export const METAL: Mat = { l: '#eef0f0', m: '#c6ccce', d: '#8f989b' }
export const CLEAR: Mat = { l: '#e4f2f4', m: '#c4dfe4', d: '#97b9c0' }
export const CERAMIC: Mat = { l: '#fbfaf3', m: '#e3e0d2', d: '#bdb8a6' }
export const DARK: Mat = { l: '#55504a', m: '#3d3935', d: '#272421' }
export const BOARD: Mat = { l: '#e6e1d4', m: '#cfc8b8', d: '#aaa293' }
export const WOOD: Mat = { l: '#d9a86c', m: '#bf8a4f', d: '#8e6236' }
export const SCREEN = '#1d2a26'
export const SCREEN_TEXT = '#8af0ae'
export const GREEN = '#43c25c'
export const RED = '#e2483d'
export const AMBER = '#f2b431'

const AZ = (105 * Math.PI) / 180
const SHADOW_K = 0.85
/** Cast shadows run 0.45 × height (colorfigures keeps them short so they stay attached). */
export const SHADOW_LEN = 0.45
/** Where a point at height h above the surface lands, per unit of h, in model (x, y). */
export const SH: readonly [number, number] = [
  SHADOW_K * Math.cos(AZ) * (SHADOW_LEN / SHADOW_K),
  SHADOW_K * Math.sin(AZ) * (SHADOW_LEN / SHADOW_K)
]
const SUN = norm([-SHADOW_K * Math.cos(AZ), -SHADOW_K * Math.sin(AZ), 1])
const LAMP = norm([0.6, 0.2, 1])

/** Exterior faces, lit by the sun. */
export const tone = (n: V3, m: Mat): string => {
  const d = dot(n, SUN)
  return d > -0.15 ? m.l : d > -0.45 ? m.m : m.d
}
/** Interiors and small props, lit by the fixed lamp. */
export const toneI = (n: V3, m: Mat): string => {
  const d = dot(n, LAMP)
  return d > 0.6 ? m.l : d > 0.05 ? m.m : m.d
}
export type Shade = (n: V3, m: Mat) => string

const hex2 = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16)
const rgb = (hex: string): [number, number, number] => [hex2(hex, 1), hex2(hex, 3), hex2(hex, 5)]
const toHex = (c: readonly number[]) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')

export const mix = (a: string, b: string, t: number): string => {
  const x = rgb(a)
  const y = rgb(b)
  return toHex(x.map((v, i) => v * (1 - t) + y[i] * t))
}

/** A material from one base colour, the colorfigures way. */
export const matOf = (hex: string): Mat => ({ l: hex, m: mix(hex, '#000000', 0.16), d: mix(hex, '#000000', 0.42) })

/**
 * Toward grey at the same lightness: offline machines. It does not lighten:
 * receding is done with opacity, which falls back into light and dark paper alike.
 */
export const desaturate = (hex: string, t = 0.8): string => {
  const [r, g, b] = rgb(hex)
  const y = 0.3 * r + 0.59 * g + 0.11 * b
  return toHex([r + (y - r) * t, g + (y - g) * t, b + (y - b) * t])
}
export const desaturateMat = (m: Mat, t = 0.8): Mat => ({ l: desaturate(m.l, t), m: desaturate(m.m, t), d: desaturate(m.d, t) })

/** HSL → hex, for palettes picked from a name. */
export const hsl = (h: number, s: number, l: number): string => {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const ch = (n: number) => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))
  return toHex([ch(0), ch(8), ch(4)])
}
