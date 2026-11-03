// Attachment cards: the notes and browsers wired to an agent, as small inked
// paper cards with a hard offset edge (the cream-and-ink chip look). They are
// flat on purpose: the levels lane tucks them behind an avatar's `fan` anchor
// and fans them out on hover with plain 2D rotations.
//
// Anchors: `chip` (the shared marker's spot, top right).
import type { FigureArt, LevelsAttachment } from '../../shared/strata'
import { memo } from './iso/memo'
import { AMBER, GREEN, INK, PALS, RED } from './iso/tone'

export const CARD_VIEW = { w: 48, h: 36 } as const

const NOTE_PAPER = '#fff3cf'
const NOTE_LINES = '#cdb98a'
const BROWSER_PAPER = '#fbfaf3'
const BROWSER_BAR = '#e3e0d2'

export interface CardInput {
  kind: LevelsAttachment['kind']
  shared: boolean
}

const note = (): string =>
  `<rect x="1" y="1" width="43" height="31" rx="3" fill="${NOTE_PAPER}" stroke="${INK}" stroke-width="1.4"/>` +
  `<path d="M36 1.7 43.3 9H38a2 2 0 0 1-2-2Z" fill="#e9d9a8" stroke="${INK}" stroke-width="1"/>` +
  `<path d="M7 11h22M7 17h30M7 23h24" stroke="${NOTE_LINES}" stroke-width="2.2"/>`

const browser = (): string =>
  `<rect x="1" y="1" width="43" height="31" rx="3" fill="${BROWSER_PAPER}" stroke="${INK}" stroke-width="1.4"/>` +
  `<path d="M1.7 9V4a3 3 0 0 1 3-3h35.6a3 3 0 0 1 3 3v5Z" fill="${BROWSER_BAR}"/>` +
  `<path d="M1.7 9h41.6" stroke="${INK}" stroke-width="1"/>` +
  [RED, AMBER, GREEN].map((c, i) => `<circle cx="${6 + i * 4.6}" cy="5" r="1.6" fill="${c}"/>`).join('') +
  `<rect x="6" y="13" width="15" height="13" rx="1.5" fill="${PALS.mint.l}" stroke="${INK}" stroke-width=".9"/>` +
  `<path d="M25 15h13M25 20h10M25 25h12" stroke="#c6ccce" stroke-width="2"/>`

/** Shared with another agent: a mustard chip with a chain link. */
const chip = (): string =>
  `<circle cx="41" cy="7" r="6" fill="${PALS.mustard.l}" stroke="${INK}" stroke-width="1.3"/>` +
  `<path d="M38.4 8.4 39.6 9.6a1.8 1.8 0 0 0 2.5 0l2-2a1.8 1.8 0 0 0 0-2.5l-1-1M43.6 5.6 42.4 4.4a1.8 1.8 0 0 0-2.5 0l-2 2a1.8 1.8 0 0 0 0 2.5l1 1" stroke="${INK}" stroke-width="1.1"/>`

const drawCard = ({ kind, shared }: CardInput): FigureArt => ({
  svg:
    `<svg xmlns="http://www.w3.org/2000/svg" class="cf" viewBox="0 0 ${CARD_VIEW.w} ${CARD_VIEW.h}" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    `<rect x="3.5" y="3.5" width="43" height="31" rx="3" fill="${INK}"/>` +
    (kind === 'note' ? note() : browser()) +
    (shared ? chip() : '') +
    `</svg>`,
  viewBox: { x: 0, y: 0, w: CARD_VIEW.w, h: CARD_VIEW.h },
  anchors: { chip: { x: 35, y: 1, w: 12, h: 12 } }
})

export const cardArt = memo(drawCard)
