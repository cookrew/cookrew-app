import type { ITheme } from '@xterm/xterm'
import { skinInfo, type SkinId } from '../../../shared/skins'

/*
 * HOW EACH SKIN IS DRAWN (shared/skins.ts says which there are).
 *
 * A skin draws nothing new. It gives the ink palette (--sumi-*, ink-theme.css)
 * its own values, and every surface that already reads it follows: the app's
 * tokens through body.cr-ink, the zoom navigator and the agent cards through
 * --zv-*, the avatars' rings and seals. On top: a face for what is named
 * (--font-serif, which every agent's name is set in), a texture on the ground
 * only (never over text or a page picture, as root's scanlines), a glow for
 * the big type where the skin glows, and the live terminal's colours.
 *
 * The palettes are bowel's (21stware/bowel, skins.go); the tokens a palette
 * does not name are derived from it, so each skin is a dozen colours and the
 * contrast the app relies on (text on a fill, the seal as small text) is
 * computed rather than hoped for.
 *
 * `ink` and `root` are not here: they have stylesheets of their own.
 */

export type DrawnSkin = Exclude<SkinId, 'ink' | 'root'>

export interface Pal {
  readonly dark: boolean
  readonly paper: string
  readonly paper2: string
  readonly card: string
  readonly sheet: string
  readonly ink: string
  readonly ink2: string
  readonly mute: string
  readonly faint: string
  readonly signal: string
  readonly good: string
  readonly warn: string
  readonly blue: string
  readonly ai: string
  readonly media: string
  readonly dev: string
}

interface Layer {
  readonly image: string
  readonly size?: string
  readonly position?: string
  readonly repeat?: string
}

interface Look {
  readonly light?: Pal
  readonly dark?: Pal
  /** What is named: agents, machines, workspaces, sheet titles. */
  readonly display: string
  /** Running text, where the skin changes it. */
  readonly body?: string
  /** The big type's glow, where the skin glows. */
  readonly glow?: string
  readonly texture: (p: Pal) => readonly Layer[]
}

// ── colour ──────────────────────────────────────────────────────────────

type Rgb = readonly [number, number, number]

const rgb = (hex: string): Rgb => {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb
}

const hex = ([r, g, b]: Rgb): string =>
  `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`

/** a toward b by t (0 is a, 1 is b). */
export const mix = (a: string, b: string, t: number): string => {
  const [x, y] = [rgb(a), rgb(b)]
  return hex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as unknown as Rgb)
}

export const alpha = (color: string, a: number): string => `rgba(${rgb(color).join(', ')}, ${+a.toFixed(3)})`

const luminance = (color: string): number => {
  const lin = rgb(color).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

export const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

/** color, pushed away from ground until it reads as small text on it. */
export const legible = (color: string, ground: string, min = 4.5): string => {
  const away = luminance(ground) > 0.4 ? '#000000' : '#ffffff'
  for (let t = 0; t <= 1; t += 0.05) {
    const next = mix(color, away, t)
    if (contrast(next, ground) >= min) return next
  }
  return away
}

/** The palette's darker or lighter end, whichever reads better on fill. */
export const onFill = (fill: string, p: Pal): string => {
  const [darkEnd, lightEnd] = p.dark ? [p.paper, p.ink] : [p.ink, p.paper]
  return contrast(darkEnd, fill) >= contrast(lightEnd, fill) ? darkEnd : lightEnd
}

// ── the palettes (bowel, skins.go) ──────────────────────────────────────

const pal = (dark: boolean, c: Omit<Pal, 'dark'>): Pal => ({ dark, ...c })

const FACE = {
  serif: "Georgia, 'Songti SC', 'STSong', 'Noto Serif SC', serif",
  songti: "'Songti SC', 'STSong', 'Noto Serif SC', 'Iowan Old Style', Georgia, serif",
  mono: "'JetBrains Mono', 'SF Mono', Menlo, 'PingFang SC', monospace",
  din: "'DIN Alternate', 'DIN Condensed', Bahnschrift, 'OPPO Sans 4.0', 'PingFang SC', sans-serif",
  futura: "Futura, 'Century Gothic', 'Avenir Next', 'PingFang SC', sans-serif",
  rounded: "'Arial Rounded MT Bold', 'SF Pro Rounded', Nunito, 'PingFang SC', sans-serif"
} as const

// ── textures, drawn once per pick ───────────────────────────────────────

/** A cheap, fixed scatter: the same specks on every boot (bowel's hash). */
const hash = (i: number): number => {
  let x = Math.imul(i >>> 0, 2654435761) ^ 0x9e3779b9
  x ^= x >>> 15
  x = Math.imul(x, 2246822519)
  x ^= x >>> 13
  return ((x >>> 0) % 10000) / 10000
}

const n1 = (v: number): string => String(Math.round(v * 10) / 10)

/** An SVG as a CSS image: quotes and the characters a url() cannot carry, escaped. */
export const svgUrl = (width: number, height: number, body: string, aspect = 'xMidYMid meet'): string => {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}' width='${width}' height='${height}' preserveAspectRatio='${aspect}'>${body}</svg>`
  return `url("data:image/svg+xml,${svg.replace(/[%#<>"{}\n]/g, (c) => encodeURIComponent(c))}")`
}

const vignette = (color: string, a: number): Layer => ({
  image: `radial-gradient(ellipse at center, ${alpha(color, 0)} 0%, ${alpha(color, 0)} 55%, ${alpha(color, a)} 100%)`
})

const glowAt = (x: string, y: string, reach: string, color: string, a: number): Layer => ({
  image: `radial-gradient(circle ${reach} at ${x} ${y}, ${alpha(color, a)} 0%, ${alpha(color, a * 0.45)} 40%, ${alpha(color, 0)} 100%)`
})

/** Specks of ink, the size of print grain. */
const specks = (color: string, a: number, count: number, tile = 220): Layer => {
  let body = ''
  for (let i = 0; i < count; i += 1) {
    const s = 1 + Math.floor(hash(i + 7) * 2)
    body += `<rect x='${n1(hash(2 * i) * tile)}' y='${n1(hash(2 * i + 1) * tile)}' width='${s}' height='${s}'/>`
  }
  return { image: svgUrl(tile, tile, `<g fill='${color}' fill-opacity='${a}'>${body}</g>`), size: `${tile}px ${tile}px`, repeat: 'repeat' }
}

/** Stars, denser and brighter toward the top. */
const stars = (color: string, count: number, w = 1600, h = 700): Layer => {
  let body = ''
  for (let i = 0; i < count; i += 1) {
    const v = hash(3 * i + 1)
    const r = (1 + Math.floor(hash(3 * i + 2) * 2.2)) / 2
    body += `<circle cx='${n1(hash(3 * i) * w)}' cy='${n1(v * v * h)}' r='${r}' fill-opacity='${(0.18 + 0.3 * hash(i + 5) * (1 - v)).toFixed(2)}'/>`
  }
  return { image: svgUrl(w, h, `<g fill='${color}'>${body}</g>`, 'xMidYMin slice'), size: '100% 100%', position: 'top center', repeat: 'no-repeat' }
}

const petalPath = (x: number, y: number, size: number, angle: number): string => {
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)]
  const at = (px: number, py: number): string => `${n1(x + px * cos - py * sin)} ${n1(y + px * sin + py * cos)}`
  const [l, w] = [size, size * 0.62]
  return (
    `M${at(0, 0)}C${at(-w, -l * 0.45)} ${at(-w * 0.5, -l)} ${at(-w * 0.12, -l * 0.92)}` +
    `L${at(0, -l * 0.8)}L${at(w * 0.12, -l * 0.92)}C${at(w * 0.5, -l)} ${at(w, -l * 0.45)} ${at(0, 0)}Z`
  )
}

/** Petals falling from the top right, thicker where the blush is. */
const petals = (color: string): Layer => {
  const side = 720
  let body = ''
  for (let i = 0; i < 16; i += 1) {
    const [u, v] = [hash(3 * i), hash(3 * i + 1)]
    const size = 6 + hash(3 * i + 2) * 8
    const a = 0.12 + 0.16 * (1 - v)
    body += `<path d='${petalPath((1 - u * u) * side, v * v * side, size, hash(i + 11) * Math.PI * 2)}' fill-opacity='${a.toFixed(2)}'/>`
  }
  return { image: svgUrl(side, side, `<g fill='${color}'>${body}</g>`), size: `${side}px ${side}px`, position: 'top right', repeat: 'no-repeat' }
}

/** Ranges of hills along the bottom, each nearer one darker, fading into the mist. */
const hills = (color: string, dark: boolean): Layer => {
  const [w, h] = [1200, 420]
  let defs = ''
  let body = ''
  for (let k = 0; k < 4; k += 1) {
    const base = h * (0.42 + 0.13 * k)
    const amp = h * (0.2 - 0.02 * k)
    let d = `M0 ${h}`
    for (let x = 0; x <= w; x += 8) {
      const f = (x / w) * (1.6 + 0.5 * k) + k * 3.7
      let y = 0.55 * Math.sin(f * 2.1 + 1.3 * k) + 0.28 * Math.sin(f * 5.3 + k) + 0.12 * Math.sin(f * 11.7 + 2 * k) + 0.05 * Math.sin(f * 29)
      y = Math.sign(y) * Math.abs(y) ** 0.8
      d += `L${x} ${n1(base - amp * y)}`
    }
    d += `L${w} ${h}Z`
    const a = (0.05 + 0.028 * k) * (dark ? 0.8 : 1)
    defs += `<linearGradient id='h${k}' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${color}' stop-opacity='${a.toFixed(3)}'/><stop offset='.35' stop-color='${color}' stop-opacity='${(a * 0.5).toFixed(3)}'/><stop offset='.8' stop-color='${color}' stop-opacity='0'/></linearGradient>`
    body += `<path d='${d}' fill='url(#h${k})'/>`
  }
  return { image: svgUrl(w, h, `<defs>${defs}</defs>${body}`, 'none'), size: '100% 46%', position: 'bottom center', repeat: 'no-repeat' }
}

/** Paper's fibres: short strokes at every angle. */
const fibres = (color: string): Layer => {
  const tile = 300
  let d = ''
  for (let i = 0; i < 26; i += 1) {
    const [x, y] = [hash(4 * i) * tile, hash(4 * i + 1) * tile]
    const ang = hash(4 * i + 2) * Math.PI
    const l = 6 + hash(4 * i + 3) * 14
    d += `M${n1(x)} ${n1(y)}l${n1(l * Math.cos(ang))} ${n1(l * Math.sin(ang))}`
  }
  return { image: svgUrl(tile, tile, `<path d='${d}' stroke='${color}' stroke-opacity='.06' stroke-width='.8' fill='none'/>`), size: `${tile}px ${tile}px`, repeat: 'repeat' }
}

/** A glaze's crackle: wandering hairlines. */
const crackle = (color: string): Layer => {
  const tile = 640
  let d = ''
  for (let i = 0; i < 14; i += 1) {
    let [x, y] = [hash(5 * i) * tile, hash(5 * i + 1) * tile]
    let ang = hash(5 * i + 2) * Math.PI * 2
    d += `M${n1(x)} ${n1(y)}`
    for (let j = 0; j < 6; j += 1) {
      ang += (hash(5 * i + 3 + j * 13) - 0.5) * 1.7
      const l = 22 + hash(5 * i + 4 + j * 29) * 46
      x += l * Math.cos(ang)
      y += l * Math.sin(ang)
      d += `L${n1(x)} ${n1(y)}`
    }
  }
  return { image: svgUrl(tile, tile, `<path d='${d}' stroke='${color}' stroke-opacity='.08' stroke-width='.8' fill='none'/>`), size: `${tile}px ${tile}px`, repeat: 'repeat' }
}

/** Curtains of light hanging from the top, rays in each. */
const curtains = (colors: readonly string[]): Layer => {
  const [w, h, step] = [1200, 700, 10]
  let defs = ''
  let body = ''
  colors.forEach((color, k) => {
    defs += `<linearGradient id='a${k}' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${color}' stop-opacity='0'/><stop offset='.18' stop-color='${color}'/><stop offset='.55' stop-color='${color}' stop-opacity='.35'/><stop offset='1' stop-color='${color}' stop-opacity='0'/></linearGradient>`
    for (let x = 0; x < w; x += step) {
      const f = x / w
      const top = h * (0.03 + 0.05 * k + 0.05 * Math.sin(f * 5.5 + k * 2.1))
      const fold = 0.5 + 0.5 * Math.sin(f * 9 + k * 1.7 + 2 * Math.sin(f * 4 + k))
      const ray = 0.6 + 0.4 * Math.sin(f * 140 + k * 3 + 6 * Math.sin(f * 17))
      const a = fold * fold * ray * (0.15 - 0.03 * k)
      if (a < 0.01) continue
      body += `<rect x='${x}' y='${n1(top)}' width='${step}' height='${n1(h * (0.16 + 0.2 * fold))}' fill='url(#a${k})' opacity='${a.toFixed(3)}'/>`
    }
  })
  return { image: svgUrl(w, h, `<defs>${defs}</defs>${body}`, 'none'), size: '100% 100%', position: 'top center', repeat: 'no-repeat' }
}

/** Halftone dots from a corner, thinning as they go. */
const halftone = (color: string, a: number, corner: 'left' | 'right'): Layer => {
  const [side, pitch] = [460, 9]
  const [cx, cy] = [corner === 'right' ? side : 0, side]
  const buckets = new Map<number, string>()
  for (let gy = 0; gy * pitch < side; gy += 1) {
    for (let gx = 0; gx * pitch < side; gx += 1) {
      const x = gx * pitch + (gy % 2) * (pitch / 2)
      const y = gy * pitch
      const d = Math.hypot(x - cx, y - cy) / side
      if (d >= 1) continue
      const s = Math.round((1 - d) * (1 - d) * 6.5 * 2) / 2
      if (s < 1) continue
      buckets.set(s, `${buckets.get(s) ?? ''}M${n1(x)} ${y}h0`)
    }
  }
  const body = [...buckets].map(([s, d]) => `<path d='${d}' stroke-width='${s}'/>`).join('')
  return {
    image: svgUrl(side, side, `<g stroke='${color}' stroke-opacity='${a}' stroke-linecap='round' fill='none'>${body}</g>`),
    size: `${side}px ${side}px`,
    position: `bottom ${corner}`,
    repeat: 'no-repeat'
  }
}

/** Two facets of glass catching the light. */
const facets = (): Layer => ({
  image: svgUrl(
    100,
    100,
    "<defs><linearGradient id='f' x1='1' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#fff' stop-opacity='.055'/><stop offset='1' stop-color='#fff' stop-opacity='.01'/></linearGradient>" +
      "<linearGradient id='g' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#fff' stop-opacity='.03'/><stop offset='1' stop-color='#fff' stop-opacity='.005'/></linearGradient></defs>" +
      "<path d='M52 0H100V62Z' fill='url(#f)'/><path d='M0 45L42 100H0Z' fill='url(#g)'/>" +
      "<path d='M52 0L100 62M0 45L42 100' stroke='#fff' stroke-opacity='.07' stroke-width='1' vector-effect='non-scaling-stroke' fill='none'/>",
    'none'
  ),
  size: '100% 100%',
  repeat: 'no-repeat'
})

// ── the twelve ──────────────────────────────────────────────────────────

export const LOOKS: Readonly<Record<DrawnSkin, Look>> = {
  broadsheet: {
    light: pal(false, {
      paper: '#efe7d4', paper2: '#e7dec8', card: '#f5eedd', sheet: '#f8f2e4',
      ink: '#1b1712', ink2: '#3e372d', mute: '#6f6555', faint: '#bcb098',
      signal: '#b3261e', good: '#2f6b3a', warn: '#a8700c',
      blue: '#1f3f74', ai: '#6b3d7a', media: '#b3261e', dev: '#2b6a66'
    }),
    dark: pal(true, {
      paper: '#1a1814', paper2: '#201d18', card: '#24211b', sheet: '#2a261f',
      ink: '#efe6d0', ink2: '#cdc3ab', mute: '#9a917b', faint: '#4e483b',
      signal: '#e0533f', good: '#6fb87a', warn: '#e2a540',
      blue: '#7d9bd1', ai: '#b48ac4', media: '#e0705f', dev: '#66b3a9'
    }),
    display: "Georgia, 'Times New Roman', 'Songti SC', 'STSong', serif",
    texture: (p) => [specks(p.ink, p.dark ? 0.05 : 0.07, 90), vignette('#5a3c14', p.dark ? 0.3 : 0.14)]
  },
  phosphor: {
    dark: pal(true, {
      paper: '#050b07', paper2: '#08120b', card: '#0b170e', sheet: '#0e1d12',
      ink: '#a6ffbc', ink2: '#74dc8f', mute: '#4fa566', faint: '#1e4a2a',
      signal: '#ff5f4a', good: '#5dff8a', warn: '#ffc24a',
      blue: '#46f08a', ai: '#f5c542', media: '#ff7a59', dev: '#39d5ff'
    }),
    display: FACE.mono,
    body: FACE.mono,
    glow: 'rgba(70, 240, 138, 0.55)',
    texture: (p) => [
      { image: 'repeating-linear-gradient(to bottom, transparent 0 2px, rgba(0, 0, 0, 0.28) 2px 3px)' },
      glowAt('50%', '50%', '70vmax', p.ink, 0.05),
      vignette('#000000', 0.55)
    ]
  },
  neon: {
    dark: pal(true, {
      paper: '#0d0a1f', paper2: '#130f2b', card: '#171233', sheet: '#1c163f',
      ink: '#f6f2ff', ink2: '#cbc2f2', mute: '#9890c6', faint: '#3b3468',
      signal: '#ff3b6b', good: '#2bffc6', warn: '#ffd23f',
      blue: '#3bd8ff', ai: '#b46bff', media: '#ff3fa4', dev: '#2bffc6'
    }),
    display: FACE.futura,
    glow: 'rgba(255, 63, 164, 0.6)',
    texture: (p) => [
      { image: `linear-gradient(90deg, ${p.media}, ${p.blue})`, size: '100% 2px', position: 'top left', repeat: 'no-repeat' },
      glowAt('8%', '5%', '60vmax', p.media, 0.16),
      glowAt('95%', '98%', '60vmax', p.blue, 0.13),
      glowAt('60%', '40%', '32vmax', p.ai, 0.05)
    ]
  },
  blueprint: {
    dark: pal(true, {
      paper: '#0e3363', paper2: '#113a6e', card: '#123e76', sheet: '#15457f',
      ink: '#f0f7ff', ink2: '#c7def6', mute: '#9dbce0', faint: '#3f6ca3',
      signal: '#ff7a59', good: '#7dffb3', warn: '#ffd166',
      blue: '#ffffff', ai: '#ffd166', media: '#ff8fa3', dev: '#7de3ff'
    }),
    display: FACE.din,
    texture: (p) => [
      { image: `linear-gradient(to right, ${alpha(p.ink, 0.1)} 1px, transparent 1px)`, size: '80px 80px' },
      { image: `linear-gradient(to bottom, ${alpha(p.ink, 0.1)} 1px, transparent 1px)`, size: '80px 80px' },
      { image: `linear-gradient(to right, ${alpha(p.ink, 0.045)} 1px, transparent 1px)`, size: '16px 16px' },
      { image: `linear-gradient(to bottom, ${alpha(p.ink, 0.045)} 1px, transparent 1px)`, size: '16px 16px' },
      vignette('#04142b', 0.35)
    ]
  },
  sakura: {
    light: pal(false, {
      paper: '#fbf2f0', paper2: '#f6e7e4', card: '#fff9f7', sheet: '#fffbfa',
      ink: '#2e1c23', ink2: '#5c4049', mute: '#8a6c75', faint: '#dcc2c8',
      signal: '#de4358', good: '#3a9a6c', warn: '#d18a24',
      blue: '#6c7fd8', ai: '#a468d6', media: '#e45a8a', dev: '#35a6a1'
    }),
    dark: pal(true, {
      paper: '#1e1419', paper2: '#24181e', card: '#2a1c23', sheet: '#302029',
      ink: '#f8e9ee', ink2: '#dcc3cc', mute: '#ad939e', faint: '#56404a',
      signal: '#ff6b7f', good: '#5fd39a', warn: '#f2b04a',
      blue: '#8e9cff', ai: '#c792ff', media: '#ff7fae', dev: '#4fd1c9'
    }),
    display: FACE.rounded,
    texture: (p) => [petals(p.media), glowAt('92%', '2%', '55vmax', p.media, p.dark ? 0.1 : 0.14)]
  },
  shanshui: {
    light: pal(false, {
      paper: '#f1eee4', paper2: '#e9e5d9', card: '#f7f5ed', sheet: '#faf8f1',
      ink: '#1a1a18', ink2: '#3d3d39', mute: '#6f6d65', faint: '#c2bfb3',
      signal: '#c8372d', good: '#3f8468', warn: '#a67c1a',
      blue: '#3a5f8a', ai: '#6f5a8c', media: '#b5495b', dev: '#3f8f7a'
    }),
    dark: pal(true, {
      paper: '#121413', paper2: '#171918', card: '#1b1d1c', sheet: '#202322',
      ink: '#ebe8de', ink2: '#c8c5ba', mute: '#94938a', faint: '#454743',
      signal: '#e85a4c', good: '#6dbb99', warn: '#d9ad4c',
      blue: '#7fa3d1', ai: '#a995cc', media: '#e0808f', dev: '#6fc4ad'
    }),
    display: FACE.songti,
    texture: (p) => [hills(p.ink, p.dark), fibres(p.ink)]
  },
  celadon: {
    light: pal(false, {
      paper: '#e8efe8', paper2: '#dee7de', card: '#f1f6f0', sheet: '#f6faf5',
      ink: '#14231d', ink2: '#33483f', mute: '#5d7368', faint: '#b3c4b8',
      signal: '#c4452f', good: '#2f8a5c', warn: '#b9801a',
      blue: '#2f6f9e', ai: '#7a5aa8', media: '#c4567a', dev: '#1f8f86'
    }),
    dark: pal(true, {
      paper: '#0f1a17', paper2: '#13201c', card: '#172621', sheet: '#1b2c26',
      ink: '#e4f0e9', ink2: '#bcd0c5', mute: '#8aa396', faint: '#3b5148',
      signal: '#f0705a', good: '#5fcf98', warn: '#e6b04e',
      blue: '#6fb0dc', ai: '#b094dc', media: '#ee88a8', dev: '#4fd0c2'
    }),
    display: FACE.serif,
    texture: (p) => [
      crackle(p.ink),
      glowAt('12%', '0%', '65vmax', p.dark ? '#7fe0c0' : '#ffffff', p.dark ? 0.08 : 0.45),
      vignette(p.dark ? '#020806' : '#3f9478', p.dark ? 0.45 : 0.16)
    ]
  },
  dunhuang: {
    light: pal(false, {
      paper: '#ead9bb', paper2: '#e2cfae', card: '#f1e3c8', sheet: '#f5e9d2',
      ink: '#2a1a12', ink2: '#4d3526', mute: '#735a44', faint: '#c4ad8a',
      signal: '#b8321f', good: '#2f7a5e', warn: '#b0700c',
      blue: '#24528f', ai: '#7a4a8a', media: '#c2513a', dev: '#1f7f72'
    }),
    dark: pal(true, {
      paper: '#1c1410', paper2: '#231914', card: '#291d17', sheet: '#30231b',
      ink: '#f0dfc0', ink2: '#d2bd99', mute: '#a68f76', faint: '#54433a',
      signal: '#e8604a', good: '#5fbf9c', warn: '#e6aa48',
      blue: '#6f9be0', ai: '#b98acb', media: '#ee7a62', dev: '#4fc4b0'
    }),
    display: FACE.serif,
    texture: (p) => [
      specks(p.ink, p.dark ? 0.05 : 0.08, 110),
      glowAt('22%', '30%', '18vmax', p.dark ? '#8a5a2e' : '#fff6dc', p.dark ? 0.07 : 0.16),
      glowAt('70%', '62%', '22vmax', p.dark ? '#8a5a2e' : '#fff6dc', p.dark ? 0.07 : 0.16),
      glowAt('100%', '100%', '50vmax', p.blue, 0.07),
      glowAt('0%', '0%', '45vmax', p.signal, 0.06),
      vignette('#4a2a10', p.dark ? 0.32 : 0.16)
    ]
  },
  dusk: {
    dark: pal(true, {
      paper: '#15132b', paper2: '#1a1733', card: '#1f1b3a', sheet: '#252043',
      ink: '#f7efe9', ink2: '#d6c9cf', mute: '#a597b3', faint: '#453c63',
      signal: '#ff6b6b', good: '#7fe0b0', warn: '#ffc66b',
      blue: '#8fb0ff', ai: '#c9a0ff', media: '#ff8fb0', dev: '#6fe0d0'
    }),
    display: FACE.serif,
    texture: (p) => [
      { ...stars(p.ink, 90), size: '100% 60%' },
      glowAt('30%', '112%', '58vmax', '#ffb060', 0.22),
      glowAt('85%', '0%', '42vmax', '#5a6bff', 0.1),
      { image: 'linear-gradient(to bottom, rgba(255, 95, 143, 0) 35%, rgba(255, 95, 143, 0.1) 75%, rgba(255, 176, 96, 0.2) 100%)' }
    ]
  },
  aurora: {
    dark: pal(true, {
      paper: '#0a1220', paper2: '#0e1828', card: '#111d30', sheet: '#152338',
      ink: '#e8f1fb', ink2: '#bccbdf', mute: '#8399b5', faint: '#2f405a',
      signal: '#ff6b7a', good: '#5ff0b0', warn: '#ffcf6b',
      blue: '#6cb6ff', ai: '#b79cff', media: '#ff8fc0', dev: '#4ff0d0'
    }),
    display: FACE.din,
    glow: 'rgba(95, 240, 176, 0.28)',
    texture: (p) => [curtains([p.good, p.dev, p.ai]), stars(p.ink, 120), vignette('#02060c', 0.4)]
  },
  obsidian: {
    dark: pal(true, {
      paper: '#050505', paper2: '#0a0a0a', card: '#0f0f0e', sheet: '#151514',
      ink: '#f5f5f2', ink2: '#c9c9c4', mute: '#8f8f8a', faint: '#3a3a37',
      signal: '#ff4d3d', good: '#3ddc84', warn: '#ffb020',
      blue: '#5b9dff', ai: '#b18cff', media: '#ff6fa0', dev: '#2ad4d4'
    }),
    display: FACE.din,
    texture: () => [facets(), glowAt('4%', '104%', '44vmax', '#ff7a1a', 0.15)]
  },
  riso: {
    light: pal(false, {
      paper: '#f4efe3', paper2: '#ebe5d6', card: '#faf6ec', sheet: '#fdfaf2',
      ink: '#1b2466', ink2: '#3a4388', mute: '#5c6394', faint: '#c3c6da',
      signal: '#f0425a', good: '#1f9d6b', warn: '#d99200',
      blue: '#2b46d6', ai: '#8a3fd1', media: '#ff48a0', dev: '#00a39a'
    }),
    display: FACE.futura,
    texture: (p) => [halftone(p.media, 0.26, 'right'), halftone(p.blue, 0.2, 'left')]
  }
}

export const isDrawnSkin = (id: SkinId): id is DrawnSkin => id in LOOKS

/** The palette a skin draws with: its dark one at night, else whichever it has. */
export const paletteOf = (id: DrawnSkin, night: boolean): Pal => {
  const look = LOOKS[id]
  return (night ? (look.dark ?? look.light) : (look.light ?? look.dark)) as Pal
}

export interface Swatch {
  readonly paper: string
  readonly card: string
  readonly ink: string
  readonly muted: string
  readonly accent: string
  readonly onAccent: string
  readonly display: string
}

/** What the picker shows of a skin: its ground, a card, its ink and its theme colour, in its face. */
export const skinSwatch = (id: SkinId, night: boolean): Swatch => {
  // Ink and root draw from their own sheets (ink-theme.css, root-theme.css); these are their values.
  if (id === 'ink') {
    return night
      ? { paper: '#15130f', card: '#211e18', ink: '#ece4d2', muted: '#9a917f', accent: '#d6a24e', onAccent: '#15130f', display: "'Iowan Old Style', Palatino, Georgia, serif" }
      : { paper: '#f4efe4', card: '#fbf8f1', ink: '#1d1a16', muted: '#6f675b', accent: '#e2b866', onAccent: '#1d1a16', display: "'Iowan Old Style', Palatino, Georgia, serif" }
  }
  if (id === 'root') {
    return { paper: '#050706', card: '#0e1210', ink: '#dce1db', muted: '#8a948b', accent: '#ff3b3b', onAccent: '#050706', display: "'Helvetica Neue', Helvetica, Arial, sans-serif" }
  }
  const p = paletteOf(id, night)
  const accent = skinInfo(id).accent
  return { paper: p.paper, card: p.card, ink: p.ink, muted: p.mute, accent, onAccent: onFill(accent, p), display: LOOKS[id].display }
}

// ── the palette, as the app's tokens ────────────────────────────────────

/** Every --sumi-* the ink theme defines, from one palette and its accent. */
export const sumiTokens = (p: Pal, accent: string): Record<string, string> => {
  const seal = legible(accent, p.paper, 3)
  const sealText = legible(accent, p.paper)
  const shadow = p.dark ? '#000000' : mix(p.ink, '#000000', 0.4)
  return {
    'color-scheme': p.dark ? 'dark' : 'light',
    '--sumi-paper': p.paper,
    '--sumi-paper-2': p.paper2,
    '--sumi-paper-3': mix(p.paper2, p.ink, p.dark ? 0.07 : 0.05),
    '--sumi-card': p.card,
    '--sumi-ink': p.ink,
    '--sumi-ink-soft': legible(p.ink2, p.paper, 6),
    '--sumi-muted': legible(p.mute, p.card),
    '--sumi-dim': p.faint,
    '--sumi-hair': alpha(p.ink, 0.1),
    '--sumi-hair-2': alpha(p.ink, 0.16),
    '--sumi-rule': alpha(p.ink, p.dark ? 0.36 : 0.42),
    '--sumi-seal': seal,
    '--sumi-seal-fill': seal,
    '--sumi-seal-text': sealText,
    '--sumi-on-seal': onFill(seal, p),
    '--sumi-gold': accent,
    '--sumi-gold-soft': mix(p.paper, accent, p.dark ? 0.2 : 0.18),
    '--sumi-on-gold': onFill(accent, p),
    '--sumi-wait': legible(p.signal, p.paper),
    '--sumi-moss': p.good,
    '--sumi-violet': p.ai,
    '--sumi-violet-soft': mix(p.paper, p.ai, 0.22),
    '--sumi-note': mix(p.card, p.warn, p.dark ? 0.18 : 0.24),
    '--sumi-note-text': p.ink,
    '--sumi-wash': alpha(accent, p.dark ? 0.1 : 0.14),
    '--sumi-grain': alpha(p.ink, p.dark ? 0.035 : 0.05),
    '--sumi-scrim': alpha(p.dark ? '#000000' : p.ink, p.dark ? 0.62 : 0.4),
    '--sumi-shadow': alpha(shadow, p.dark ? 0.5 : 0.1),
    '--sumi-shadow-sm': alpha(shadow, p.dark ? 0.4 : 0.08),
    '--sumi-lift': p.dark
      ? `0 0 0 1px ${alpha(p.ink, 0.08)}, 0 12px 32px rgba(0, 0, 0, 0.6)`
      : `0 1px 2px ${alpha(shadow, 0.06)}, 0 10px 28px ${alpha(shadow, 0.1)}`,
    '--phos': sealText,
    '--phos-dim': p.mute,
    '--phos-glow': accent,
    '--phos-bg': p.paper,
    // How strongly the fold's faces show their light and shade (zoom-frame.ts · foldFacesSvg): more on a dark page.
    '--zv-fold-a': p.dark ? '1.3' : '1',
    background: p.paper
  }
}

// ── the sheet ───────────────────────────────────────────────────────────

/**
 * Text on a bright fill: the list night.css and root-theme.css keep. Here the
 * fill is the skin's accent, which may be dark (Broadsheet's vermilion) or
 * bright (Phosphor's green), so the ink on it is computed (--sumi-on-gold).
 */
export const ON_ACCENT = [
  '.ags-mark', '.ags-recover-coin', '.ags-tick.on', '.attach-tab.on', '.browser-tabs-pill.on',
  '.canvas-visual-toggle.mode-agents', '.card-pick.on', '.cr-acct-avatar', '.cr-btn.icon.on', '.cr-btn.on',
  '.cr-btn.primary', '.cr-chip-live', '.cr-chip.amber', '.cr-chip.cr-serving-badge', '.cr-chip.done',
  '.cr-chip.role.amber', '.cr-chip.sel', '.cr-ckpt-action.rewind.armed', '.cr-ckpt-here',
  '.cr-ckpt-row.active .cr-ckpt-dot i', '.cr-ckpt-tick', '.cr-ckpt-tick.rewind', '.cr-fn-stage', '.cr-git-dirty',
  '.cr-led', '.cr-led.busy', '.cr-more-item.on', '.cr-path-relay .cr-path-dot', '.cr-routing-btn.primary',
  '.cr-routing-entry.online .cr-routing-lamp', '.cr-routing-pick.on', '.cr-routing-status.online .cr-routing-lamp',
  '.cr-routing-tick.btn', '.cr-sheet .gs-primary', ".cr-viewseg button[aria-pressed='true']", '.cr-ws-create',
  '.cr-pet-card-send', '.cr-wsw-actions button.primary', '.door-moved-b.primary', '.event-toast-count',
  '.gk-tick.done', '.gk-tick.now', '.lod-overlay .attach-tab.on', '.note-header', '.popout-ask-live',
  '.roster-recover-coin', '.sos-held-b.sel', '.sos-opt.sel .sos-dot', '.stg-dot.connecting', '.stg-dot.live',
  '.stg-thumb-col.agents i.replied', '.stg-thumb-col.agents i.thinking', '.tf-include.on', '.tf-include.on:hover',
  '.voice-speak.on'
] as const

/** The big type: names of agents, machines and workspaces, the crumb, a sheet's title. */
const BIG_TYPE = '.cr-pet-card-name, .zv-nm, .zv-machine-label b, .zv-device-label b, .zv-tile-name, .cr-route-here, .gs-sheet-head h2'

const declare = (tokens: Record<string, string>): string =>
  Object.entries(tokens)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n')

const layered = (layers: readonly Layer[], grain: boolean): Record<string, string> => {
  const all = grain
    ? [...layers, { image: 'radial-gradient(var(--zv-grain) 1px, transparent 1px)', size: '3px 3px', repeat: 'repeat' }]
    : layers
  return {
    'background-image': all.map((l) => l.image).join(',\n    '),
    'background-size': all.map((l) => l.size ?? 'auto').join(', '),
    'background-position': all.map((l) => l.position ?? '0 0').join(', '),
    'background-repeat': all.map((l) => l.repeat ?? 'repeat').join(', ')
  }
}

/** One palette's rules, under `scope` (the skin's attribute, and night's where it has one). */
const paletteRules = (scope: string, look: Look, p: Pal, accent: string): string => {
  const texture = look.texture(p)
  const rules = [
    `${scope} {\n${declare(sumiTokens(p, accent))}\n}`,
    `${scope} :is(body.cr-ink, .cr-stage) {\n${declare(layered(texture, false))}\n}`,
    `${scope} .zv-overview {\n${declare(layered(texture, true))}\n}`
  ]
  if (p.dark) rules.push(`${scope} :is(.cr-logo-mark, .cr-hand-mark) img {\n  filter: invert(1) brightness(0.9);\n}`)
  return rules.join('\n\n')
}

/**
 * The whole stylesheet for one skin. Only the skin worn is ever in the page,
 * so a pick swaps one <style> and its textures are drawn once.
 *
 * `html:root` outranks ink-theme.css's night palette (`:root[data-scheme]`),
 * which would otherwise recolour a light skin on a phone in dark mode.
 */
export const skinCss = (id: DrawnSkin): string => {
  const look = LOOKS[id]
  const accent = skinInfo(id).accent
  const scope = `html:root[data-theme='${id}']`
  const first = (look.light ?? look.dark) as Pal
  const parts = [
    paletteRules(scope, look, first, accent),
    `${scope} {\n  --font-serif: ${look.display};\n  --sumi-serif: var(--font-serif);${look.body ? `\n  --font-body: ${look.body};` : ''}\n}`,
    `${scope} :is(.zv-root, .ag-ink) {\n  --zv-on-tint: var(--sumi-on-seal);\n}`,
    `${scope} ::selection {\n  background: var(--sumi-gold-soft);\n  color: var(--sumi-ink);\n}`,
    `${scope} :is(${ON_ACCENT.join(', ')}),\n${scope} :is(${ON_ACCENT.join(', ')}) * {\n  color: var(--sumi-on-gold);\n}`,
    `${scope} .lod-overlay .ctx-block.active {\n  background: var(--sumi-wash);\n}`
  ]
  if (look.glow) parts.push(`${scope} :is(${BIG_TYPE}) {\n  text-shadow: 0 0 12px ${look.glow};\n}`)
  if (look.light && look.dark) {
    const night = paletteRules(`html:root[data-scheme='auto'][data-theme='${id}']`, look, look.dark, accent)
    parts.push(`@media (prefers-color-scheme: dark) {\n${night}\n}`)
  }
  return `/* skin: ${id} (skins/skin-look.ts) */\n${parts.join('\n\n')}\n`
}

// ── the live terminal ───────────────────────────────────────────────────

/** xterm draws on a canvas, so a skin names its terminal's colours here. */
export const skinTerminal = (id: DrawnSkin, night: boolean): ITheme => {
  const p = paletteOf(id, night)
  const ground = p.dark ? p.paper2 : p.sheet
  const bright = (color: string): string => mix(color, p.dark ? '#ffffff' : '#000000', p.dark ? 0.3 : 0.15)
  const accent = skinInfo(id).accent
  const cursor = legible(accent, ground, 3)
  return {
    background: ground,
    foreground: p.ink,
    cursor,
    cursorAccent: ground,
    selectionBackground: mix(ground, accent, 0.28),
    black: p.dark ? p.faint : p.ink,
    red: p.signal,
    green: p.good,
    yellow: p.warn,
    blue: p.blue,
    magenta: p.ai,
    cyan: p.dev,
    white: p.mute,
    brightBlack: p.mute,
    brightRed: bright(p.signal),
    brightGreen: bright(p.good),
    brightYellow: bright(p.warn),
    brightBlue: bright(p.blue),
    brightMagenta: bright(p.ai),
    brightCyan: bright(p.dev),
    brightWhite: p.ink
  }
}
