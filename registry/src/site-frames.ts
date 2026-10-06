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
    "The Cookrew canvas: five agent cards mid-task, wired to the orchestrator that dispatched them",
    "Rested the pointer on the orchestrator of a working crew: its cables light amber and the rest of the board falls back, so what it owns is the only thing drawn bright. The five cards are on three different harnesses, each showing the brief it was handed and the answer it gave."
  ),
  task: frame(
    'intro-1.jpg',
    "An agent card open on its record: the brief, the tool calls, the test run and the commit",
    "Clicked an agent open on the turn it had just finished: the brief at the top, the git calls it made, the files it staged, and the commit it wrote — all of it the agent’s own work in a real repository, with the live terminal still running under the LIVE line."
  ),
  harness: frame(
    'intro-2.jpg',
    "The dock's harness picker: Claude Code, Codex, OpenCode, Pi and a plain shell",
    "Pressed TERMINAL in the dock over a live canvas: the picker slid up with the five harnesses Cookrew ships, Claude Code lit, the saved teams beside them and + IMPORT A TEAM at the end of the row."
  ),
  trace: frame(
    'qa-history-trace.jpg',
    "A checkpoint rail dragged open, every past turn listed with the title it was given",
    "Dragged the rail up from its live end: the session’s checkpoints fanned out with the title each turn was given, one row took the focus with ROLE, FORK and REWIND beside it, and the transcript on the left scrolled to that turn — the test runs and the rename, as the agent recorded them."
  ),
  rail: frame(
    'qa-terminal-rail.jpg',
    "An agent card open: the transcript on the left, its checkpoints on the rail",
    "Clicked a working agent open: the transcript holds the turns it has taken this session, the live terminal runs under the LIVE line, and the rail on the right counts the checkpoints — one per turn, written as the turn lands."
  ),
  board: frame(
    'qa-board.jpg',
    "The Board: every agent in the workspace, its harness, its role and what it last did",
    "Switched the header to BOARD and narrowed it to one workspace: the crew with their harness, role and workspace chips, the prompt each was last given and the answer it made — and the note they wrote, folded into the same stream."
  ),
  mobile: frame(
    'qa-mobile.jpg',
    "The same canvas at phone width: the same cards, the same cables",
    "Opened the phone companion against the same live workspace at 390 px with touch emulation: the crew, their cables and the note and page they are working from, in the layout a paired phone serves."
  ),
  workspaces: frame(
    'intro-6.jpg',
    "The workspace wall: every workspace as a screen, this one picked with its snapshot",
    "Pressed the workspace pill: the wall of workspaces slid in, one tilted screen each, with the shoot’s own workspace picked in front carrying a snapshot of its canvas and its directory under it."
  ),
  market: frame(
    'qa-marketplace.jpg',
    "The cookrew.dev rent strip: a served team taking calls, with what a seat costs",
    "Opened cookrew.dev signed in: the rent strip lists the instances taking calls with what a seat costs and how many lines were opened at each today, every one carrying BUY A SEAT and OPEN — and under it, the invitation to serve your own."
  )
} as const

export function frameUrl(frame: Frame): string {
  return `${SITE_FRAMES}${frame.file}`
}
