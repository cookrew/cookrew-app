import { SITE_FRAMES } from './site-shell'
import { FRAME_SIZES } from './site-frame-sizes'
import { currentLang } from './site-lang'

/**
 * WHAT THE SITE SHOWS, AND WHAT EACH PICTURE IS (2026-11-17).
 *
 * The 1 Nov recordings were of the maintainer's own workspace and machine, and
 * the interface has moved on since; none of them is on a page any more. Every
 * picture now is the CURRENT product UI, rendered from the app's own code on a
 * demo cast with nobody's data in it (the workspace "Release Room": Planner on
 * Claude Code, Reviewer on Codex, Checker on OpenCode, Notes on Pi). Since
 * 2026-11-18 (owner) a picture wears no chip and no caption: what it is stays
 * in the markup as data-source, and its alt text says what it shows.
 *
 *   illustration  the app's renderer (or the watch's SwiftUI views) on the
 *                 demo cast, driven by real clicks; nothing drawn over it
 *   composite     several such renders set side by side in plain frames, or
 *                 (the operation cards) a picture of a demo page laid into a
 *                 card's empty stage
 *   recording     the running app on real work — none on the site this round
 *
 * Source of every file: the worktree's renderer at dev fd70898d (day and night) on the demo api
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
  /** The same render at night (<file>-night.jpg, the app's night palette): shown at night instead. */
  night?: Frame
}

export const sourceOf = (frame: Frame): FrameSource => frame.source

const demo = (file: string, alt: string, caption: string, source: FrameSource = 'illustration', maxWidth?: number): Frame => {
  const size = FRAME_SIZES[file]
  if (!size) throw new Error(`site-frames: no size for ${file}; run scripts/site-demo/assets.mjs`)
  const at = (name: string): Frame | null => {
    const z = FRAME_SIZES[name]
    return z ? { file: name, alt, caption, source, width: z.width, height: z.height, twins: z.twins, ...(z.phone ? { phone: z.phone } : {}), ...(maxWidth ? { maxWidth } : {}) } : null
  }
  const night = at(file.replace(/\.jpg$/, '-night.jpg'))
  return { ...at(file)!, ...(night ? { night } : {}) }
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
  devices: demo('demo-devices.jpg', 'The devices stop: Studio Mac and Build Server with their load, and under it each machine’s screen enlarged: Release Room and Docs Site, and Nightly Builds',
    'Pressed devices in the dock: Studio Mac (2 workspaces, 6 agents) and Build Server (1 workspace, 2 agents), each with its CPU, memory, disk and GPU (demo readings). The stop draws a machine’s workspaces at the size of its laptop screen; under it, each screen from the same render, enlarged. On a phone, the machines as the app draws them at phone width.', 'composite'),
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

/** The alt text on a Chinese page, by file (day and night share it). */
const ALT_ZH: Readonly<Record<string, string>> = {
  'demo-hero-devices.jpg': 'Planner 的同一个问题出现在三台设备上：桌面应用、手机宽度的应用和 Apple Watch',
  'demo-routing.jpg': 'Routing 面板：Magpie 在线，四个 harness 都可路由，订阅和本地模型，默认分组',
  'demo-crew-phone.jpg': '手机宽度下 Release Room 的四个 agent',
  'demo-watch.jpg': '三个 Apple Watch 屏幕：Checker 的回复、Release Room 的 agent 和账号下的机器',
  'demo-ops-cards.jpg': '三种操作卡片：电脑屏幕、浏览器页面和手机屏幕',
  'demo-agents.jpg': '一个工作空间，四个 harness 上的四个 agent：Planner 在等你，Reviewer 工作中，Checker 已回复，Notes 休息中',
  'demo-workspaces.jpg': '工作空间视图：Release Room 和 Docs Site，各自显示 agent 头像和等你处理的事',
  'demo-hitl-desk.jpg': '从底栏打开 Planner 的问题，Claude Code 的权限请求变成可选择的几行',
  'demo-artifacts.jpg': '产出物视图：手机屏幕卡片、电脑屏幕卡片、浏览器卡片和一张便签',
  'demo-board.jpg': 'BOARD 面板：Release Room 的每个 agent，带着它的 harness、最后的提示和状态',
  'demo-devices.jpg': '设备视图：Studio Mac 和 Build Server，屏幕上是各自的工作空间，下方是负载',
  'demo-hitl-phone.jpg': '手机宽度下 Planner 的问题，可以点选的几行',
  'demo-phone-workspaces.jpg': '手机宽度下的工作空间视图：Release Room 和 Docs Site',
  'demo-browser-card.jpg': '打开在发布说明页面上的浏览器卡片，由 Checker 使用',
  'demo-docs-crew.jpg': '第二个工作空间 Docs Site：Writer 在等你，Editor 已完成'
}
const altOf = (frame: Frame): string => (currentLang() === 'zh' ? (ALT_ZH[frame.file.replace(/-night\.jpg$/, '.jpg')] ?? frame.alt) : frame.alt)

/** Where a phone takes its own framing of a figure. */
export const PHONE_MEDIA = '(max-width: 640px)'

const escAttr = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const twinUrl = (frame: Frame, width: number): string => `${SITE_FRAMES}${frame.file.replace(/\.jpg$/, `-${width}.jpg`)}`

/**
 * A <picture>: the crop and its narrower twins with their widths (no layout shift: the size is known up front), and,
 * when the figure has one, its phone framing for narrow screens.
 */
export function frameImg(frame: Frame, options: { eager?: boolean; sizes?: string; cls?: string } = {}): string {
  const set = [...frame.twins.map((w) => `${escAttr(twinUrl(frame, w))} ${w}w`), `${escAttr(frameUrl(frame))} ${frame.width}w`].join(', ')
  const phone = frame.phone
    ? `<source media="${PHONE_MEDIA}" srcset="${escAttr(`${SITE_FRAMES}${frame.file.replace(/\.jpg$/, '-phone.jpg')}`)}" width="${frame.phone.width}" height="${frame.phone.height}">`
    : ''
  const img = `<img src="${escAttr(frameUrl(frame))}" srcset="${set}" sizes="${escAttr(options.sizes ?? '(max-width: 860px) 100vw, 60vw')}" width="${frame.width}" height="${frame.height}" alt="${escAttr(altOf(frame))}"${options.eager ? ' fetchpriority="high"' : ' loading="lazy" decoding="async"'}>`
  return `<picture${options.cls ? ` class="${options.cls}"` : ''}>${phone}${img}</picture>`
}

export function frameUrl(frame: Frame): string {
  return `${SITE_FRAMES}${frame.file}`
}

const escText = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * ONE FIGURE (owner 2026-11-18: no illustration box and no caption on a picture). What it is stays in the markup,
 * as `data-source` (illustration or composite), and its alt text says what it shows.
 */
export function figure(frame: Frame, options: { sizes?: string; eager?: boolean; cls?: string } = {}): string {
  const source = sourceOf(frame)
  const portrait = frame.height > frame.width
  const cls = `shot ${source}${portrait ? ' portrait' : ''}${options.cls ? ` ${options.cls}` : ''}${frame.maxWidth ? ' narrow' : ''}`
  const style = frame.maxWidth ? ` style="--max:${frame.maxWidth}px"` : ''
  // Day and night: the one not shown is not loaded (lazy, and display:none until the scheme or the reader's pick asks).
  const pictures = frame.night
    ? frameImg(frame, { sizes: options.sizes, eager: options.eager, cls: 'v-day' }) + frameImg(frame.night, { sizes: options.sizes, cls: 'v-night' })
    : frameImg(frame, { sizes: options.sizes, eager: options.eager })
  return `<figure class="${cls}" data-source="${source}"${style}>${pictures}</figure>`
}
