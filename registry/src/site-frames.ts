import { SITE_FRAMES } from './site-shell'
import { FRAME_SIZES } from './site-frame-sizes'

/**
 * WHAT THE SITE SHOWS, AND WHAT EACH PICTURE IS (2026-11-17).
 *
 * The 1 Nov recordings were of the maintainer's own workspace and machine, and
 * the interface has moved on since; none of them is on a page any more. Every
 * picture now is the CURRENT product UI, rendered from the app's own code on a
 * demo cast with nobody's data in it (the workspace "Release Room": Planner on
 * Claude Code, Reviewer on Codex, Checker on OpenCode, Notes on Pi), and each
 * says so beside it: an illustration on demo data, never a recording.
 *
 *   illustration  the app's renderer (or the watch's SwiftUI views) on the
 *                 demo cast, driven by real clicks; nothing drawn over it
 *   composite     several such renders set side by side in plain frames, or
 *                 (the operation cards) a picture of a demo page laid into a
 *                 card's empty stage; the caption says which
 *   recording     the running app on real work — none on the site this round
 *
 * Source of every file: the worktree's renderer at dev d28ddfbb on the demo api
 * with a synthetic seed, and watch/Sources/watch-shots on a recast copy of its
 * fixture (scripts/site-demo: the seed, the recast, and the shoot and compose
 * scripts). The files live under registry/assets/site/ and are
 * served from GitHub at the commit the site is built from.
 */
export type FrameSource = 'illustration' | 'composite' | 'recording'

export interface Frame {
  file: string
  alt: string
  caption: string
  /** The largest file's size (site-frame-sizes.ts, written by the script that crops the renders). */
  width: number
  height: number
  source: FrameSource
  /** Narrower copies of the same crop: <file>-<width>.jpg. */
  twins: readonly number[]
  /** Its own framing for a phone screen (<file>-phone.jpg), when the desktop framing would be too small to read there. */
  phone?: { width: number; height: number }
  /** A sparse picture (two faces) is drawn no wider than this many CSS px on a desktop, not blown up to the page. */
  maxWidth?: number
}

/** The words a figure wears for what it is, beside its caption. */
export const SOURCE_CHIP: Readonly<Record<FrameSource, string>> = {
  illustration: 'Product UI on demo data · illustration',
  composite: 'Composite of product UI renders on demo data · illustration',
  recording: '● REC'
}

export const sourceOf = (frame: Frame): FrameSource => frame.source

/** Where the pictures were made, once, for every caption that needs to say it. */
export const RENDERED = 'Rendered on 17 Nov 2026 from the app’s code on dev, on demo data.'

const demo = (file: string, alt: string, caption: string, source: FrameSource = 'illustration', maxWidth?: number): Frame => {
  const size = FRAME_SIZES[file]
  if (!size) throw new Error(`site-frames: no size for ${file}; run scripts/site-demo/assets.mjs`)
  return { file, alt, caption, source, width: size.width, height: size.height, twins: size.twins, ...(size.phone ? { phone: size.phone } : {}), ...(maxWidth ? { maxWidth } : {}) }
}

/**
 * Every picture once (2026-11-17, second round): each section of each page has its own file, cropped to what it is
 * about from a render at high density, never a window of empty paper and never scaled up.
 */
export const DEMO = {
  hero: demo('demo-hero-devices.jpg', 'The same question from Planner on three devices: the desktop app, the app at phone width, and an Apple Watch',
    'One agent, three screens: Planner (Claude Code) waits on an edit to CHANGELOG.md, drawn by the desktop renderer (cropped to Release Room’s four agents on four harnesses and the question opened from the dock), by the same renderer at phone width, and by the watch app’s own view. Renders on demo data set side by side in plain frames; not a photograph of devices.', 'composite'),
  routing: demo('demo-routing.jpg', 'The Routing panel: Magpie online, four harnesses ready to route, subscriptions and a local model, the default group',
    'Opened Routing from the menu: the four harnesses each ticked installed, signed in and routed, two subscriptions and a local model, and the default every new card takes.'),
  crewPhone: demo('demo-crew-phone.jpg', 'Release Room’s four agents at phone width', 'Release Room at phone width (390 px): the four agents and their states, Planner waiting on you.'),
  watch: demo('demo-watch.jpg', 'Three Apple Watch screens: Checker’s reply, Release Room’s agents, and the account’s machines',
    'Three watch screens drawn by the watch app’s own views on demo data: Checker’s reply with a box to answer it, Release Room’s agents with what needs you at the foot, and the account’s two machines, both online.', 'composite'),
  ops: demo('demo-ops-cards.jpg', 'Three operation cards: a computer’s screen, a browser page, and a phone’s screen',
    'The three kinds of card an agent operates: a computer screen card, a browser card and a phone screen card, each used by Checker. The browser card renders its page itself. The demo has no screen behind the computer and phone cards, so a picture of a demo desktop, and of the same page at phone width, is laid into each card’s stage; the cards around them are the product’s.', 'composite'),
  agents: demo('demo-agents.jpg', 'One workspace, four agents on four harnesses: Planner waiting on you, Reviewer working, Checker replied, Notes resting',
    'Clicked Release Room: Planner on Claude Code waiting on you, Reviewer on Codex working, Checker on OpenCode replied, Notes on Pi resting.'),
  workspaces: demo('demo-workspaces.jpg', 'The workspaces stop: Release Room and Docs Site, each with its agents’ faces and what needs you',
    'The workspaces stop: Release Room with four agents on four harnesses and Docs Site with two, each tile counting what needs you.'),
  hitlDesk: demo('demo-hitl-desk.jpg', 'Planner’s card with the permission prompt Claude Code asked, mirrored as rows to pick',
    'Clicked Planner: its card opened, and the permission prompt Claude Code is waiting on, an edit to CHANGELOG.md, came up as rows to pick, 1 to 3, or Esc.'),
  artifacts: demo('demo-artifacts.jpg', 'The artifacts stop: a phone screen card, a computer screen card, a browser card and a note',
    'Clicked artifacts: the phone simulator, the main display and the release-notes page, each used by Checker, and under them the checklist note Planner keeps. Their thumbnails are the demo’s flat placeholders, not screens.'),
  board: demo('demo-board.jpg', 'The BOARD: every agent of Release Room with its harness, its last prompt and its state',
    'Pressed the count beside search: the BOARD lists every agent with its harness (OpenCode, Pi, Claude Code, Codex), its workspace, what you last asked it and where it stands: done, needs you, working.'),
  devices: demo('demo-devices.jpg', 'The devices stop: Studio Mac and Build Server, each drawn as a laptop with its workspaces on the screen',
    'Pressed devices in the dock: Studio Mac (2 workspaces, 6 agents) and the account’s second machine, Build Server (1 workspace, 2 agents), each machine’s workspaces drawn small on its screen. On a phone, the same stop as the app draws it at phone width.'),
  hitlPhone: demo('demo-hitl-phone.jpg', 'Planner’s question as rows to tap, at phone width',
    'Planner’s question at phone width (390 px): the same rows to tap, with the reply box under them.'),
  phoneWorkspaces: demo('demo-phone-workspaces.jpg', 'The workspaces stop at phone width: Release Room and Docs Site',
    'The workspaces stop at phone width (390 px): Release Room and Docs Site, each tile with its agents and what needs you.'),
  browserCard: demo('demo-browser-card.jpg', 'A browser card open on a release-notes page, used by Checker',
    'Clicked Release notes: the browser card opened on the page Checker checked, a local demo page, with the agent that uses it named at the top right.'),
  docsCrew: demo('demo-docs-crew.jpg', 'A second workspace, Docs Site: Writer waiting on you, Editor done',
    'Clicked Docs Site, the second workspace on the same machine: Writer on Claude Code waiting on you, Editor on Codex done (cropped to the two agents).', 'illustration', 360)
} as const satisfies Record<string, Frame>

export type DemoKey = keyof typeof DEMO

/** Where a phone takes its own framing of a figure. */
export const PHONE_MEDIA = '(max-width: 640px)'

const escAttr = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const twinUrl = (frame: Frame, width: number): string => `${SITE_FRAMES}${frame.file.replace(/\.jpg$/, `-${width}.jpg`)}`

/**
 * A <picture>: the crop and its narrower twins with their widths (no layout shift: the size is known up front), and,
 * when the figure has one, its phone framing for narrow screens.
 */
export function frameImg(frame: Frame, options: { eager?: boolean; sizes?: string } = {}): string {
  const set = [...frame.twins.map((w) => `${escAttr(twinUrl(frame, w))} ${w}w`), `${escAttr(frameUrl(frame))} ${frame.width}w`].join(', ')
  const phone = frame.phone
    ? `<source media="${PHONE_MEDIA}" srcset="${escAttr(`${SITE_FRAMES}${frame.file.replace(/\.jpg$/, '-phone.jpg')}`)}" width="${frame.phone.width}" height="${frame.phone.height}">`
    : ''
  const img = `<img src="${escAttr(frameUrl(frame))}" srcset="${set}" sizes="${escAttr(options.sizes ?? '(max-width: 860px) 100vw, 60vw')}" width="${frame.width}" height="${frame.height}" alt="${escAttr(frame.alt)}"${options.eager ? ' fetchpriority="high"' : ' loading="lazy" decoding="async"'}>`
  return `<picture>${phone}${img}</picture>`
}

export function frameUrl(frame: Frame): string {
  return `${SITE_FRAMES}${frame.file}`
}

const escText = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * ONE FIGURE, AND WHAT IT IS. The chip says illustration, composite or recording before the caption says what was
 * clicked; an extra sentence (a status the picture shows, what it is not) follows the caption.
 */
export function figure(frame: Frame, options: { sizes?: string; note?: string; eager?: boolean; cls?: string } = {}): string {
  const source = sourceOf(frame)
  const portrait = frame.height > frame.width
  const note = options.note ? ` ${escText(options.note)}` : ''
  const cls = `shot ${source}${portrait ? ' portrait' : ''}${options.cls ? ` ${options.cls}` : ''}`
  const style = frame.maxWidth ? ` style="--max:${frame.maxWidth}px"` : ''
  return `<figure class="${cls}${frame.maxWidth ? ' narrow' : ''}" data-source="${source}"${style}>${frameImg(frame, { sizes: options.sizes, eager: options.eager })}<figcaption><span class="rec src-${source}">${escText(SOURCE_CHIP[source])}</span><span>${escText(frame.caption)}${note}</span></figcaption></figure>`
}
