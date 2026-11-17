import { SOURCE_CHIP } from './site-frames'
import { SITE_FRAMES, esc } from './site-shell'

/**
 * THE CANVAS CLIP (2026-11-17). The 1 Nov recordings (promo.mp4 and the six
 * motion-* clips) were of the maintainer's own workspace; none is on a page
 * now. This clip is the current UI on the demo cast, every beat one real click
 * through the app's renderer, and its caption says it is an illustration on
 * demo data, never a recording. It sits on the canvas feature page; the front
 * page's hero is the multi-device composite (site-frames.ts DEMO.hero).
 */
export const CANVAS_CLIP = {
  file: 'demo-canvas.mp4',
  poster: 'demo-canvas.jpg',
  width: 1400,
  height: 874,
  label:
    'Twenty seconds of the current Cookrew interface on demo data: two workspaces, one workspace with four agents on four harnesses, an agent’s question as rows to pick, the artifacts, a browser card, and back out',
  caption:
    'Twenty seconds clicked through the app’s current interface on demo data (17 Nov 2026): the workspaces stop, Release Room’s four agents on Claude Code, Codex, OpenCode and Pi, Planner’s question as rows to pick, the artifacts, Checker’s browser card, and back out. Nobody’s real work is in it.'
} as const

/**
 * The clip as a figure. No script: <video autoplay muted loop playsinline> needs none, and a reader whose browser
 * refuses autoplay sees the poster.
 */
export function clipFigure(): string {
  const clip = CANVAS_CLIP
  return `<figure class="shot clip illustration" data-source="illustration"><video autoplay muted loop playsinline preload="metadata" poster="${esc(`${SITE_FRAMES}${clip.poster}`)}" width="${clip.width}" height="${clip.height}" aria-label="${esc(clip.label)}"><source src="${SITE_FRAMES}${clip.file}" type="video/mp4"></video><figcaption><span class="rec src-illustration">${esc(SOURCE_CHIP.illustration)}</span><span>${esc(clip.caption)}</span></figcaption></figure>`
}
