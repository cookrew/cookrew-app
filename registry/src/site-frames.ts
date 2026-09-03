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
  'intro-1.jpg': [1400, 1112],
  'intro-2.jpg': [1400, 887],
  'intro-3.jpg': [996, 1400],
  'intro-4.jpg': [1400, 887],
  'intro-5.jpg': [647, 1400],
  'intro-6.jpg': [1400, 887],
  'qa-board.jpg': [1400, 875],
  'qa-canvas.jpg': [1400, 875],
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
  const small = `${SITE_FRAMES}${frame.file.replace(/\.jpg$/, '-800.jpg')}`
  const large = frameUrl(frame)
  const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  return `<img src="${esc(large)}" srcset="${esc(small)} 800w, ${esc(large)} ${frame.width}w" sizes="${esc(options.sizes ?? '(max-width: 860px) 100vw, 60vw')}" width="${frame.width}" height="${frame.height}" alt="${esc(frame.alt)}"${options.eager ? ' fetchpriority="high"' : ' loading="lazy" decoding="async"'}>`
}

export const FRAMES = {
  canvas: frame(
    'qa-canvas.jpg',
    'The Cookrew Dev canvas: agent terminal cards, notes and wires',
    'Framed the Cookrew Dev canvas at 0.42 zoom with cables shown: the Conductor orch card beside Magpie, Forge, Sol and Pixel, the program-spec notes above them, and the dotted wires fanning out of the orchestrator.'
  ),
  task: frame(
    'intro-1.jpg',
    'A real task in an agent terminal, with a checkpoint landing on the rail',
    'Recorded a real task into an agent terminal: the brief went in, Bash counted 36 PNG and 7 JPG files, the agent reported 10.6 MB, and a checkpoint dropped on the rail.'
  ),
  harness: frame(
    'intro-2.jpg',
    'Dock preset chips: Claude Code, Codex, OpenCode, Pi, Shell, Add by link',
    'Recorded placing a harness: chose CLAUDE CODE in the dock, clicked the canvas, the new teammate landed, started, and its card opened.'
  ),
  trace: frame(
    'qa-history-trace.jpg',
    'The Conductor card scrubbed to checkpoint T13, the rail fanned open',
    "Dragged the Conductor rail up to checkpoint T13: the rail fanned into the full checkpoint list with T13 focused, the transcript scrolled to that turn's block and the ask bar read CHECKPOINT T13."
  ),
  rail: frame(
    'qa-terminal-rail.jpg',
    'The Conductor card open: live terminal on the left, checkpoint rail on the right',
    'Zoomed the Conductor card open: the live Claude Code terminal filled the overlay while the checkpoint rail on the right showed 23 CP, two compact ticks and the LIVE dot at the tail.'
  ),
  board: frame(
    'qa-board.jpg',
    'The Board: every agent, its phase, tokens and checkpoint, on one screen',
    'Opened the Board from the header and focused its search: the facet chips counted 20 active and 174 inactive agents by preset and role, with Conductor WORKING and Tinker OFFLINE listed above the notes out of 643 items in total.'
  ),
  mobile: frame(
    'qa-mobile.jpg',
    'The phone companion with the Tinker card open',
    "Paired the phone companion in a 500px headless Chrome and tapped the Tinker card: the overlay showed its last verdict block, the rail with 186 CP, version pins V1 and V7, and the LIVE marker, over the phone's arrow, ESC and send controls."
  ),
  workspaces: frame(
    'intro-6.jpg',
    'The workspace switcher: five named workspaces and a row of served session workspaces',
    "Recorded the switcher: five named workspaces plus a row of served session workspaces, each one a caller's own sandbox."
  ),
  market: frame(
    'qa-marketplace.jpg',
    'The Import a team sheet over the canvas',
    "Armed the dock's terminal family and pressed + IMPORT A TEAM: the Import a team sheet opened over the canvas with its served-team address field, CANCEL and LOOK UP, above the AGENT presets and YOUR TEAMS rows."
  )
} as const

export function frameUrl(frame: Frame): string {
  return `${SITE_FRAMES}${frame.file}`
}
