import { SITE_FRAMES } from './site-shell'

/**
 * RECORDED FEATURE CASES — what the homepage shows instead of describing.
 *
 * Every frame is a capture of the running app driven with real input by QA,
 * and its caption says in the past tense what was actually done, not what
 * the feature is for. The files live in this repository under
 * registry/assets/site/ and are served from GitHub, so a frame can be retaken
 * with a commit and never lives in the registry's bundle.
 */
export interface Frame {
  file: string
  alt: string
  caption: string
  width: number
  height: number
}

/** Pixel size of every 1400-wide frame in registry/assets/site (an 800-wide twin exists for each). */
const SIZES: Record<string, [number, number]> = {
  'intro-1.jpg': [1400, 875],
  'intro-2.jpg': [1400, 875],
  'intro-6.jpg': [1400, 875],
  'qa-board.jpg': [1400, 875],
  'qa-canvas.jpg': [1400, 874],
  'promo-poster.jpg': [1400, 874],
  'qa-history-trace.jpg': [1400, 875],
  'qa-marketplace.jpg': [1400, 875],
  'qa-mobile.jpg': [700, 1400],
  'qa-terminal-rail.jpg': [1400, 875]
}

const frame = (file: string, alt: string, caption: string): Frame => {
  const [width, height] = SIZES[file] ?? [1400, 875]
  return { file, alt, caption, width, height }
}

/** An <img> with its size known up front (no layout shift) and a smaller twin for narrow screens. */
export function frameImg(frame: Frame, options: { eager?: boolean; sizes?: string } = {}): string {
  // The hero column is under 600px on a desktop, so the 800px twin is the
  // right file there; only a feature page's wide figure needs the 1400.
  const small = `${SITE_FRAMES}${frame.file.replace(/\.jpg$/, '-800.jpg')}`
  const large = frameUrl(frame)
  const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  return `<img src="${esc(large)}" srcset="${esc(small)} 800w, ${esc(large)} ${frame.width}w" sizes="${esc(options.sizes ?? '(max-width: 860px) 100vw, 60vw')}" width="${frame.width}" height="${frame.height}" alt="${esc(frame.alt)}"${options.eager ? ' fetchpriority="high"' : ' loading="lazy" decoding="async"'}>`
}

export const FRAMES = {
  canvas: frame(
    'qa-canvas.jpg',
    "The Cookrew Dev canvas: eight agent cards mid-turn, wired to their notes and browser cards",
    "Framed the crew in the harness view with the pointer resting on the orchestrator: its cables light amber while the rest of the board falls back, the dispatch it just sent has landed on Vigil — whose card now reads Auditing the door seal — and the others carry on, each showing the brief it was given and the tool call it is on."
  ),
  task: frame(
    'intro-1.jpg',
    'An agent card open on its record: the brief, the work, the test result and the commit',
    "Clicked Mason open after it finished: the turn above the LIVE line holds what it did \u2014 wrote the test first, ran it, implemented, re-ran \u2014 and the live screen under it still shows the run: tests/round.test.ts, 17 tests passed, committed as \u201cadd roundTo with half-to-even rounding and vitest coverage\u201d. The work, the test and the commit are the agent's own."
  ),
  harness: frame(
    'intro-2.jpg',
    "The dock's harness picker: Claude Code, Codex, OpenCode, Pi and a plain shell",
    "Pressed TERMINAL in the dock over the harness canvas: the picker slid up with the five harnesses Cookrew ships, CLAUDE CODE lit, the ORCH toggle beside them and + IMPORT A TEAM at the end of the row."
  ),
  trace: frame(
    'qa-history-trace.jpg',
    "The Velvet card scrubbed back through its checkpoints, the rail fanned open",
    "Dragged the Velvet rail up from its live end: the 124 checkpoints fanned out with the title each turn was given, one row took the focus with FORK beside it, and the transcript on the left scrolled to that turn."
  ),
  rail: frame(
    'qa-terminal-rail.jpg',
    "The orchestrator card open: the transcript on the left, 311 checkpoints on the rail",
    "Clicked the orchestrator open: the transcript holds the turns it has taken, the live terminal runs under the LIVE line, and the rail on the right counts 311 checkpoints across the session’s whole chain."
  ),
  board: frame(
    'qa-board.jpg',
    "The Board: every agent, its harness, its role and what it is doing now, on one screen",
    "Switched the header to BOARD: eight agents with their harness, role and workspace chips, the prompt each was last given and what it is doing now — five working, one just finished, and Velvet in red, because it has stopped to ask its owner which way to go."
  ),
  mobile: frame(
    'qa-mobile.jpg',
    "The canvas at phone width: the same cards, the same cables",
    "Rendered the same canvas at 390 px with touch emulation, the layout the phone companion serves: the orchestrator between its notes and the browser cards below it, the harness cables running between them, and the dock along the bottom."
  ),
  workspaces: frame(
    'intro-6.jpg',
    "The workspace wall: every workspace as a screen, Cookrew Dev picked with its snapshot",
    "Pressed the workspace pill in the header: the wall of workspaces slid in, one tilted screen each, Cookrew Dev picked in front carrying a snapshot of this canvas and its directory under it, with BACK, DIRECTORIES, REMOVE and HISTORY below."
  ),
  market: frame(
    'qa-marketplace.jpg',
    "The cookrew.dev rent strip: the instances taking calls, each with a price and a seat to buy",
    "Opened cookrew.dev: the rent strip lists the instances taking calls with what a seat costs and how many lines were opened at each today, every one carrying BUY A SEAT and OPEN — and under it the free doors, which need nothing but an account."
  )
} as const

export function frameUrl(frame: Frame): string {
  return `${SITE_FRAMES}${frame.file}`
}
