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
    'The Cookrew Dev canvas: agent terminal cards, notes and wires',
    'Framed the Velvet row of the Cookrew Dev board in the harness view: Fresco, Velvet, Conductor and Solosea show the last turn each agent took, the spec notes they were handed sit under them, the browser cards below carry the pages they opened, and the cables run as shared trunks along the gutters.'
  ),
  task: frame(
    'intro-1.jpg',
    "An agent card open on its record: the brief, the reply, the tool calls, the checkpoint rail",
    "Clicked the Velvet card open on the Cookrew Dev board: its latest turn fills the card \u2014 the brief it was given, the reply it wrote and the Bash calls between \u2014 with the LIVE line under it and the checkpoint rail on the right counting 138."
  ),
  harness: frame(
    'intro-2.jpg',
    "The dock's harness picker: Claude Code, Codex, OpenCode, Pi, Shell and the saved teams",
    "Pressed TERMINAL in the dock over the harness canvas: the picker slid up with the five harness chips, CLAUDE CODE lit, the saved teams beside them and + IMPORT A TEAM at the end of the row."
  ),
  trace: frame(
    'qa-history-trace.jpg',
    "The Velvet card scrubbed to checkpoint T78, the rail fanned open",
    "Dragged the Velvet rail up from its live end: the list of 138 checkpoints fanned out with the title Sous gave each one, T78 took the focus with FORK beside it, and the transcript on the left scrolled to that turn."
  ),
  rail: frame(
    'qa-terminal-rail.jpg',
    "The Conductor card open: the transcript on the left, 1126 checkpoints on the rail",
    "Clicked the Conductor card open: its latest reply sits above the LIVE line, the terminal below it is quiet, and the rail on the right counts 1126 checkpoints across the session's whole chain, compaction ticks included."
  ),
  board: frame(
    'qa-board.jpg',
    "The Board: every agent, its last turn, its role and its checkpoint, on one screen",
    "Switched the header to BOARD: nineteen active agents of twenty listed with the harness, role and workspace chips, the prompt each was last given and the reply it made, and how long ago it finished \u2014 the facet bar counts them by harness and role."
  ),
  mobile: frame(
    'qa-mobile.jpg',
    "The canvas at phone width: the same cards, the same cables",
    "Rendered the same fixture at 500 px with touch emulation, the layout the phone companion uses: Velvet between its notes and the browser card below it, the harness cables running between them, the header's icons and the dock at the bottom."
  ),
  workspaces: frame(
    'intro-6.jpg',
    "The workspace wall: every workspace as a screen, Cookrew Dev picked with its snapshot",
    "Pressed the workspace pill in the header: the wall of workspaces slid in, one tilted screen each, with Cookrew Dev picked in front carrying a snapshot of this canvas and its directory under it, and OPEN, DIRECTORIES, REMOVE and HISTORY below."
  ),
  market: frame(
    'qa-marketplace.jpg',
    "The Import a team sheet showing the COOKREW Alpha door",
    "Pressed + IMPORT A TEAM in the dock and pasted cookrew.dev/@drej/cookrew-alpha: LOOK UP read the door's face from cookrew.dev \u2014 COOKREW Alpha, Pilot answering for 3 agents, a priced seat \u2014 above CANCEL and the import button. Before an address is typed the same sheet lists the teams saved on this machine and the seats the account holds."
  )
} as const

export function frameUrl(frame: Frame): string {
  return `${SITE_FRAMES}${frame.file}`
}
