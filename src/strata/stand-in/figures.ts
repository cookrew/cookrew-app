// STAND-IN FigureKit: flat boxes, rings and dots with the real anchors, so the
// levels and the stage can be built before the colorfigures kit lands. Swap the
// import for the real kit; nothing else changes.
import type { FigureArt } from '../../shared/strata'
import type { FigureKit } from '../seams'

const PHASE_FILL = { idle: '#e8dfc6', thinking: '#ff9f0a', waiting: '#ff453a', replied: '#32d74b', offline: '#a39d8f' }
const KIND_LABEL = { laptop: 'LAPTOP', desktop: 'DESKTOP', server: 'SERVER', cloud: 'CLOUD', vm: 'VM', cluster: 'CLUSTER', sandbox: 'SANDBOX', unknown: '?' }
const COLUMNS = 8
const CAPACITY = 48

const art = (w: number, h: number, body: string, anchors: FigureArt['anchors']): FigureArt => ({
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${body}</svg>`,
  viewBox: { x: 0, y: 0, w, h },
  anchors
})

const memo = <I, O>(draw: (input: I) => O) => {
  const seen = new Map<string, O>()
  return (input: I): O => {
    const key = JSON.stringify(input)
    const hit = seen.get(key)
    if (hit) return hit
    const out = draw(input)
    seen.set(key, out)
    return out
  }
}

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

export const standInFigures: FigureKit = {
  machine: memo(({ kind, link }) => {
    const dim = link === 'offline' || link === 'unpaired' ? ' opacity="0.5"' : ''
    return art(
      240,
      180,
      `<g${dim}><rect x="4" y="4" width="232" height="172" fill="#fffaf0" stroke="#2d2a20" stroke-width="3"/>` +
        `<rect x="20" y="20" width="200" height="120" fill="#14110a"/>` +
        `<text x="120" y="164" text-anchor="middle" font-family="monospace" font-size="14" fill="#2d2a20">${KIND_LABEL[kind]}</text></g>`,
      { portal: { x: 20, y: 20, w: 200, h: 120 } }
    )
  }),

  container: memo(({ name, slots }) => {
    const seats = Math.min(slots, CAPACITY)
    const columns = Math.min(COLUMNS, Math.max(1, seats))
    const rows = Math.max(1, Math.ceil(seats / columns))
    const cell = 40
    const w = columns * cell + 24
    const h = rows * cell + 56
    const seatsAt = Array.from({ length: seats }, (_, i) => [
      `slot:${i}`,
      { x: 12 + (i % columns) * cell + 4, y: 32 + Math.floor(i / columns) * cell + 4, w: cell - 8, h: cell - 8 }
    ])
    const anchors: FigureArt['anchors'] = {
      label: { x: 12, y: 8, w: w - 24, h: 20 },
      tray: { x: 12, y: h - 20, w: w - 24, h: 12 },
      ...Object.fromEntries(seatsAt)
    }
    const body =
      `<rect x="2" y="2" width="${w - 4}" height="${h - 4}" fill="#f3ecd8" stroke="#2d2a20" stroke-width="3"/>` +
      `<text x="12" y="22" font-family="monospace" font-size="13" fill="#2d2a20">${escape(name)}</text>`
    return { ...art(w, h, body, anchors), archetype: 'box', capacity: CAPACITY }
  }),

  avatar: memo(({ phase, source, size }) => {
    const r = size === 'dot' ? 4 : size === 'small' ? 9 : 16
    const d = r * 2 + 4
    const dash = source === 'live' ? '' : ' stroke-dasharray="3 2"'
    return art(d, d, `<circle cx="${d / 2}" cy="${d / 2}" r="${r}" fill="${PHASE_FILL[phase]}" stroke="#2d2a20" stroke-width="1.5"${dash}/>`, {
      badge: { x: d - 8, y: 0, w: 8, h: 8 },
      fan: { x: 0, y: 0, w: d, h: d }
    })
  }),

  attachment: memo(({ kind, shared }) =>
    art(
      48,
      36,
      `<rect x="2" y="2" width="44" height="32" fill="${kind === 'note' ? '#fff3c4' : '#ffffff'}" stroke="#2d2a20" stroke-width="2"/>` +
        (shared ? '<circle cx="40" cy="8" r="4" fill="#ffd600" stroke="#2d2a20"/>' : ''),
      {}
    )
  )
}
