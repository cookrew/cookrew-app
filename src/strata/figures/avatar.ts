// Avatars: one ball per agent, the same size everywhere for a given
// AvatarSize, laid out like a container seat (BALL), so the art's whole
// viewBox goes into a `slot:i` rect and the ball lands on the seat.
//
//   idle      calm cream — attention should pop, so idle is never green
//   thinking  a small amber ring above the ball, its dash turning
//   waiting   red, with a raised flag that waves
//   replied   a green unread dot on the badge
//   offline   grey
// Only the ring and the flag move (SMIL inside the string, so the art stays
// self-contained; a reduced-motion page calls svg.pauseAnimations()). A phase
// known from a probe or the ledger is a guess: dashed, faded, and still.
//
// Anchors: `badge` (top right of the ball) and `fan` (behind the ball, upper
// left, where attachment cards tuck in).
import type { AgentPhase, FigureArt, Harness, PhaseSource } from '../../shared/strata'
import type { AvatarSize } from '../seams'
import { BALL } from './container/layout'
import { memo } from './iso/memo'
import { num } from './iso/pen'
import { GREEN, INK, SHADOW, SHADOW_STYLE, type Mat } from './iso/tone'

export const AVATAR_VIEW: Record<AvatarSize, number> = { dot: 12, small: 30, full: 88 }

const BALLS: Record<AgentPhase, Mat> = {
  idle: { l: '#f6f0e2', m: '#e4d9c1', d: '#b8aa8a' },
  thinking: { l: '#f6f0e2', m: '#e4d9c1', d: '#b8aa8a' },
  waiting: { l: '#f07a5c', m: '#d65a40', d: '#8c3324' },
  replied: { l: '#f6f0e2', m: '#e4d9c1', d: '#b8aa8a' },
  offline: { l: '#d3cfc6', m: '#b9b4a9', d: '#8e897e' }
}
/** At dot size there is no room for the ring: a thinking dot is amber instead. */
const THINKING_DOT: Mat = { l: '#f7d27a', m: '#eab54a', d: '#b07d1c' }
const RING = { track: '#f3d595', dash: '#dc8f12' }
/** Marks on the red waiting ball go cream so they still read. */
const ON_RED = '#fff1e2'
const FLAG = '#e2483d'

export const HARNESS_INK: Record<Harness, string> = {
  claude: '#c96442',
  codex: '#2b2824',
  opencode: '#3b6fd8',
  pi: '#7a4fd0',
  shell: '#2f8a4c',
  other: '#857d6e'
}

export interface AvatarInput {
  phase: AgentPhase
  source: PhaseSource
  harness: Harness
  size: AvatarSize
}

const xy = (x: number, y: number) => `${num(x)} ${num(y)}`

/** The harness mark, centred at (x, y), about 2u wide. */
const mark = (harness: Harness, x: number, y: number, u: number, w: number, c = HARNESS_INK[harness]): string => {
  const stroke = `stroke="${c}" stroke-width="${num(w)}"`
  switch (harness) {
    case 'claude': {
      const rays = [0, 60, 120].map((a) => {
        const dx = Math.cos((a * Math.PI) / 180) * u
        const dy = Math.sin((a * Math.PI) / 180) * u
        return `M${xy(x - dx, y - dy)} ${xy(x + dx, y + dy)}`
      })
      return `<path d="${rays.join('')}" ${stroke}/>`
    }
    case 'codex': {
      const hex = Array.from({ length: 6 }, (_, i) => {
        const a = ((i * 60 + 30) * Math.PI) / 180
        return xy(x + Math.cos(a) * u * 0.95, y + Math.sin(a) * u * 0.95)
      })
      return `<path d="M${hex.join(' ')}Z" ${stroke}/>`
    }
    case 'opencode':
      return `<path d="M${xy(x - u * 0.35, y - u)} ${xy(x - u, y - u)} ${xy(x - u, y + u)} ${xy(x - u * 0.35, y + u)}M${xy(x + u * 0.35, y - u)} ${xy(x + u, y - u)} ${xy(x + u, y + u)} ${xy(x + u * 0.35, y + u)}" ${stroke}/>`
    case 'pi':
      return `<path d="M${xy(x - u, y - u * 0.7)} ${xy(x + u, y - u * 0.7)}M${xy(x - u * 0.45, y - u * 0.7)} ${xy(x - u * 0.55, y + u)}M${xy(x + u * 0.4, y - u * 0.7)} ${xy(x + u * 0.4, y + u * 0.75)} ${xy(x + u * 0.8, y + u)}" ${stroke}/>`
    case 'shell':
      return `<path d="M${xy(x - u, y - u * 0.8)} ${xy(x - u * 0.15, y)} ${xy(x - u, y + u * 0.8)}M${xy(x + u * 0.1, y + u * 0.85)} ${xy(x + u, y + u * 0.85)}" ${stroke}/>`
    default:
      return `<circle cx="${num(x)}" cy="${num(y)}" r="${num(u * 0.45)}" fill="${c}"/>`
  }
}

/** The turning ring: a small ellipse above the ball, a dash running round it. */
const ring = (cx: number, cy: number, R: number, live: boolean): string => {
  const at = `cx="${num(cx)}" cy="${num(cy - R * 1.2)}" rx="${num(R * 0.62)}" ry="${num(R * 0.2)}"`
  const w = num(Math.max(0.8, R * 0.16))
  const spin = live ? `<animate attributeName="stroke-dashoffset" values="0;-100" dur="1.4s" repeatCount="indefinite"/>` : ''
  return (
    `<ellipse ${at} stroke="${RING.track}" stroke-width="${w}"/>` +
    `<ellipse ${at} pathLength="100" stroke="${RING.dash}" stroke-width="${w}" stroke-dasharray="30 70">${spin}</ellipse>`
  )
}

/** The raised flag: a pole from behind the ball and a pennant that waves. */
const flag = (cx: number, cy: number, R: number, live: boolean, w: number): string => {
  const px = cx + R * 0.5
  const top = cy - R * 2.02
  const base = cy - R * 0.7
  const len = R * 0.95
  const shape = (lift: number) =>
    `M${xy(px, top)}C${xy(px + len * 0.35, top - lift)} ${xy(px + len * 0.65, top + lift)} ${xy(px + len, top + R * 0.1)}` +
    `L${xy(px + len, top + R * 0.52)}C${xy(px + len * 0.65, top + R * 0.42 + lift)} ${xy(px + len * 0.35, top + R * 0.42 - lift)} ${xy(px, top + R * 0.42)}Z`
  const wave = live ? `<animate attributeName="d" values="${shape(R * 0.12)};${shape(-R * 0.12)};${shape(R * 0.12)}" dur="1.1s" repeatCount="indefinite"/>` : ''
  return (
    `<path d="M${xy(px, base)} ${xy(px, top)}" stroke="currentColor" stroke-width="${num(w * 0.9)}"/>` +
    `<path d="${shape(R * 0.12)}" fill="${FLAG}" stroke="${INK}" stroke-width="${num(w * 0.7)}">${wave}</path>`
  )
}

/**
 * Values a newer desktop might send that this kit does not know yet fall back
 * to neutral ones instead of drawing "undefined" or throwing.
 */
const known = (input: AvatarInput): AvatarInput => ({
  phase: input.phase in BALLS ? input.phase : 'idle',
  source: input.source === 'live' || input.source === 'probe' || input.source === 'ledger' ? input.source : 'probe',
  harness: input.harness in HARNESS_INK ? input.harness : 'other',
  size: input.size in AVATAR_VIEW ? input.size : 'small'
})

const drawAvatar = (input: AvatarInput): FigureArt => {
  const { phase, source, harness, size } = known(input)
  const V = AVATAR_VIEW[size]
  const cx = V * BALL.cx
  const cy = V * BALL.cy
  const R = (V * BALL.d) / 2
  const sure = source === 'live'
  const live = sure && phase !== 'offline'
  const w = size === 'dot' ? 0.9 : size === 'small' ? 1.2 : 2
  const base = size === 'dot' && phase === 'thinking' ? THINKING_DOT : BALLS[phase]
  const m = base
  // a guess and an offline agent recede by opacity, which works on light and dark paper alike
  const recede = (sure ? 1 : 0.6) * (phase === 'offline' ? 0.72 : 1)
  const disc = (dx: number, dy: number, r: number, c: string) =>
    `<circle cx="${num(cx + dx * R)}" cy="${num(cy + dy * R)}" r="${num(r * R)}" fill="${c}"/>`
  const dash = sure ? '' : ` stroke-dasharray="${num(R * 0.36)} ${num(R * 0.26)}"`
  let svg = ''
  if (size !== 'dot') svg += `<ellipse cx="${num(cx - R * 0.42)}" cy="${num(cy + R * 0.9)}" rx="${num(R * 0.8)}" ry="${num(R * 0.28)}" fill="${SHADOW}" ${SHADOW_STYLE}${sure ? '' : ' opacity=".5"'}/>`
  if (phase === 'waiting' && size !== 'dot') svg += flag(cx, cy, R, live, w)
  let ball = disc(0, 0, 1, m.d) + disc(0.09, -0.1, 0.86, m.m)
  if (size !== 'dot') ball += disc(0.2, -0.24, 0.55, m.l) + disc(0.34, -0.42, 0.13, '#fffdf6')
  if (size !== 'dot' && phase !== 'offline') {
    ball += mark(harness, cx + R * 0.08, cy + R * 0.12, R * 0.3, Math.max(0.9, R * 0.12), phase === 'waiting' ? ON_RED : HARNESS_INK[harness])
  }
  svg += recede < 1 ? `<g opacity="${recede.toFixed(2)}">${ball}</g>` : ball
  svg += `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(R)}" stroke="currentColor" stroke-width="${num(w)}"${dash}/>`
  if (phase === 'thinking' && size !== 'dot') svg += ring(cx, cy, R, live)
  if (phase === 'replied') {
    const r = size === 'dot' ? R * 0.42 : R * 0.26
    svg += `<circle cx="${num(cx + R * 0.74)}" cy="${num(cy - R * 0.74)}" r="${num(r)}" fill="${GREEN}" stroke="${INK}" stroke-width="${num(w * 0.7)}"/>`
  }
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" class="cf" viewBox="0 0 ${V} ${V}" fill="none" stroke-linecap="round" stroke-linejoin="round" color="${INK}">${svg}</svg>`,
    viewBox: { x: 0, y: 0, w: V, h: V },
    anchors: {
      badge: { x: +num(cx + R * 0.42), y: +num(cy - R * 1.06), w: +num(R * 0.64), h: +num(R * 0.64) },
      fan: { x: +num(cx - R * 1.15), y: +num(cy - R * 1.2), w: +num(R * 1.3), h: +num(R * 1.3) }
    }
  }
}

export const avatarArt = memo(drawAvatar)
