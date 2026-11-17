import { SITE_FRAMES } from './site-shell'

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
 *   composite     several such renders set side by side; nothing painted in
 *   recording     the running app on real work — none on the site this round
 *
 * Source of every file: the worktree's renderer at dev d28ddfbb on the demo api
 * with a synthetic seed, and watch/Sources/watch-shots on a recast copy of its
 * fixture (the seed, the recast and the shoot scripts are listed in the commit
 * that added the files). The files live under registry/assets/site/ and are
 * served from GitHub at the commit the site is built from.
 */
export type FrameSource = 'illustration' | 'composite' | 'recording'

export interface Frame {
  file: string
  alt: string
  caption: string
  width: number
  height: number
  /** Absent: a recording (the old frames' shape). */
  source?: FrameSource
  /** The width of the -800 twin when it is not 800 (a portrait's twin is narrower). */
  smallWidth?: number
}

/** The words a figure wears for what it is, beside its caption. */
export const SOURCE_CHIP: Readonly<Record<FrameSource, string>> = {
  illustration: 'Product UI on demo data · illustration',
  composite: 'Composite of product UI renders on demo data · illustration',
  recording: '● REC'
}

export const sourceOf = (frame: Frame): FrameSource => frame.source ?? 'recording'

/** Where the pictures were made, once, for every caption that needs to say it. */
export const RENDERED = 'Rendered on 17 Nov 2026 from the app’s code on dev, on demo data.'

const demo = (file: string, width: number, height: number, alt: string, caption: string, source: FrameSource = 'illustration', smallWidth?: number): Frame =>
  ({ file, alt, caption, width, height, source, ...(smallWidth ? { smallWidth } : {}) })

export const DEMO = {
  devices: demo('demo-devices.jpg', 1400, 876, 'The devices stop: this desktop drawn as a laptop with its two workspaces on the screen',
    'Clicked the empty paper: the view stepped out to the devices stop, this desktop with Release Room and Docs Site on its screen.'),
  workspaces: demo('demo-workspaces.jpg', 1400, 876, 'The workspaces stop: Release Room and Docs Site, each with its agents’ faces and what needs you',
    'The workspaces stop: Release Room with four agents on four harnesses and Docs Site with two, each tile counting what needs you.'),
  agents: demo('demo-agents.jpg', 1400, 876, 'One workspace, four agents on four harnesses: Planner working, Reviewer waiting on you, Checker replied, Notes resting',
    'Clicked Release Room: Planner on Claude Code working, Reviewer on Codex waiting on you, Checker on OpenCode replied, Notes on Pi resting.'),
  hitlDesk: demo('demo-hitl-desk.jpg', 1400, 876, 'Reviewer’s card with the question Codex asked, mirrored as rows to pick',
    'Clicked Reviewer: its card opened, and the permission prompt Codex is waiting on came up as rows to pick, 1 to 3, or Esc.'),
  artifacts: demo('demo-artifacts.jpg', 1400, 876, 'The artifacts stop: a browser card, a note, a phone screen card and a computer screen card',
    'Clicked artifacts: the browser card Checker uses, the checklist note Planner keeps, and two screen cards, a phone simulator and the main display. Their pictures are the demo’s flat placeholders, not screens.'),
  browserCard: demo('demo-browser-card.jpg', 1400, 876, 'A browser card open on a release-notes page, used by Checker',
    'Clicked Release notes: the browser card opened on the page Checker checked, a local demo page, with the agent that uses it named at the top right.'),
  routing: demo('demo-routing.jpg', 1400, 828, 'The Routing panel: Magpie online, four harnesses ready to route, subscriptions and a local model, the default group',
    'Opened Routing from the menu: the four harnesses each ticked installed, signed in and routed, two subscriptions and a local model, and the default every new card takes.'),
  crewPhone: demo('demo-crew-phone.jpg', 700, 1514, 'The same four agents at phone width', 'The same workspace at phone width (390 px): the four agents and their states.', 'illustration', 400),
  hitlPhone: demo('demo-hitl-phone.jpg', 700, 1514, 'Reviewer’s question as rows to tap, at phone width',
    'Reviewer’s question at phone width (390 px): the same rows to tap, with the reply box under them.', 'illustration', 400),
  watch: demo('demo-watch.jpg', 1400, 556, 'Three Apple Watch screens: Reviewer’s question, a row picked, and the workspace’s agents',
    'Three watch screens drawn by the watch app’s own views: Reviewer’s question, the row it would send, and Release Room’s agents with what needs you at the foot.', 'composite')
} as const satisfies Record<string, Frame>

export type DemoKey = keyof typeof DEMO

/** An <img> with its size known up front (no layout shift) and a smaller twin for narrow screens. */
export function frameImg(frame: Frame, options: { eager?: boolean; sizes?: string } = {}): string {
  // The hero column is under 600px on a desktop, so the 800px twin is the
  // right file there; only a feature page's wide figure needs the 1400.
  const small = `${SITE_FRAMES}${frame.file.replace(/\.jpg$/, '-800.jpg')}`
  const large = frameUrl(frame)
  const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  return `<img src="${esc(large)}" srcset="${esc(small)} ${frame.smallWidth ?? 800}w, ${esc(large)} ${frame.width}w" sizes="${esc(options.sizes ?? '(max-width: 860px) 100vw, 60vw')}" width="${frame.width}" height="${frame.height}" alt="${esc(frame.alt)}"${options.eager ? ' fetchpriority="high"' : ' loading="lazy" decoding="async"'}>`
}

export function frameUrl(frame: Frame): string {
  return `${SITE_FRAMES}${frame.file}`
}

const escText = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * ONE FIGURE, AND WHAT IT IS. The chip says illustration, composite or recording before the caption says what was
 * clicked; an extra sentence (a status the picture shows, what it is not) follows the caption.
 */
export function figure(frame: Frame, options: { sizes?: string; note?: string; eager?: boolean } = {}): string {
  const source = sourceOf(frame)
  const portrait = frame.height > frame.width
  const note = options.note ? ` ${escText(options.note)}` : ''
  return `<figure class="shot ${source}${portrait ? ' portrait' : ''}" data-source="${source}">${frameImg(frame, { sizes: options.sizes ?? (portrait ? '300px' : '(max-width: 860px) 100vw, 40vw'), eager: options.eager })}<figcaption><span class="rec src-${source}">${escText(SOURCE_CHIP[source])}</span><span>${escText(frame.caption)}${note}</span></figcaption></figure>`
}
