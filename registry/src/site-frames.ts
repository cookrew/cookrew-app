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
  'intro-1.jpg': [1400, 874],
  'intro-2.jpg': [1400, 874],
  'intro-6.jpg': [1400, 874],
  'qa-board.jpg': [1400, 874],
  'qa-canvas.jpg': [1400, 874],
  'promo-poster.jpg': [1400, 874],
  'qa-history-trace.jpg': [1400, 874],
  'qa-marketplace.jpg': [1400, 874],
  'qa-mobile.jpg': [700, 1400],
  'qa-terminal-rail.jpg': [1400, 874]
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
    'One workspace in Cookrew: its agents as ink faces on paper, tied by the cables of who can ask whom',
    'Clicked Cookrew Dev on the machine: its crew stood on the paper, each agent with its name and state under it, the cables between them showing who can ask whom. Lark, Finch and Moss at the top and bottom were working a small TypeScript package together.'
  ),
  task: frame(
    'intro-1.jpg',
    'An agent opened to its full transcript: the tool calls, the test run and its reply',
    'Clicked Lark twice: the card grew into its full transcript, every Bash call in mono, the test run with 22 passing, and the reply in which Lark took Finch’s review of chunk.ts and fixed the guard. The rail on the right counts its checkpoints.'
  ),
  harness: frame(
    'intro-2.jpg',
    "The dock's harness picker: Claude Code, Codex, OpenCode, Pi and a plain shell",
    'Pressed TERMINAL in the dock: the picker opened with the five harnesses Cookrew ships, the saved teams and + IMPORT A TEAM, and the next click on the paper places an agent on the one chosen.'
  ),
  trace: frame(
    'qa-history-trace.jpg',
    'A checkpoint rail dragged open, every past turn listed with the title it was given',
    'Pressed the rail at its live end and dragged up: the checkpoints opened as a list of titled turns, the one under the marker offered ROLE, FORK and REWIND, and the transcript followed back to that turn, Update comments and rerun tests.'
  ),
  rail: frame(
    'qa-terminal-rail.jpg',
    'An orchestrator’s transcript: the cookrew commands it ran to hand work to its crew',
    'Scrolled Lark’s transcript back to its first turn: one Bash call dispatched chunk.ts to Finch and kebab-case to Moss with the cookrew CLI, another polled both dispatches for their replies, and the rail on the right kept one checkpoint per turn.'
  ),
  board: frame(
    'qa-board.jpg',
    'One machine with every workspace at once, each a ring of the agents in it',
    'Clicked the machine: its seven workspaces laid out as rings, each holding its agents’ faces with the count on its label. A click on a name opens that crew; a click on the paper steps back out to the machines.'
  ),
  mobile: frame(
    'qa-mobile.jpg',
    'The phone companion showing an agent’s full transcript, the rail down the right edge',
    'Opened the phone companion against the same Mac at 412 px and tapped Lark twice: its transcript filled the phone, with Finch’s NaN and 1.5 findings and the 22 passing tests, the rail down the right and a key row with arrows and Esc under it.'
  ),
  workspaces: frame(
    'intro-6.jpg',
    'The workspace wall: every workspace as a screen with a snapshot of its paper',
    'Opened the wall from the header menu: every workspace on this Mac as a tilted screen with a snapshot of its paper, GOAT Team picked in front with its directory under it, and OPEN, DIRECTORIES, REMOVE and HISTORY below.'
  ),
  market: frame(
    'qa-marketplace.jpg',
    'Import a team: a served team looked up by its cookrew.dev address, with what a seat costs',
    'Pressed + IMPORT A TEAM, pasted cookrew.dev/@drej/cookrew-alpha and pressed LOOK UP: the sheet answered with the team, COOKREW Alpha at 1 USD a seat with Pilot answering and running the other two on the owner’s side, and CONTINUE — REVIEW THE TERMS.'
  )
} as const

export function frameUrl(frame: Frame): string {
  return `${SITE_FRAMES}${frame.file}`
}
