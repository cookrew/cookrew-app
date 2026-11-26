import { PHONE_MEDIA } from './site-frames'
import { FRAME_SIZES } from './site-frame-sizes'
import { SITE_FRAMES, esc } from './site-shell'
import { tr } from './site-lang'

/**
 * THE CANVAS CLIP (2026-11-17). The 1 Nov recordings (promo.mp4 and the six
 * motion-* clips) were of the maintainer's own workspace; none is on a page
 * now. This clip is the current UI on the demo cast, every beat one real click
 * through the app's renderer on demo data, never a recording (no caption since
 * 2026-11-18; a day and a night take). It sits on the canvas feature page; the front
 * page's hero is the multi-device composite (site-frames.ts DEMO.hero).
 */
export const CANVAS_CLIP = {
  file: 'demo-canvas.mp4',
  poster: 'demo-canvas.jpg',
  /** 1280×800: each step cropped from 2048×1280 frames (scripts/site-demo/clip.mjs); shown at most 1024 CSS px wide. */
  width: FRAME_SIZES['demo-canvas.mp4']!.width,
  height: FRAME_SIZES['demo-canvas.mp4']!.height,
  label:
    'Twenty seconds of the current Cookrew interface on demo data: two workspaces, a crew of four on four harnesses, an agent’s question as rows to pick, the artifacts, a browser card, and the board of every agent',
  labelZh: '二十秒的 Cookrew 当前界面，演示数据：两个工作空间、四个 harness 上的四个 agent、一个 agent 的问题和可选的回答、产出物、一张浏览器卡片，以及所有 agent 的面板',
  caption:
    'Twenty seconds clicked through the app’s current interface on demo data (17 Nov 2026): the workspaces, Release Room’s four agents on Claude Code, Codex, OpenCode and Pi, Planner’s question as rows to pick, the artifacts, Checker’s browser card, and the BOARD. Each step is cropped to what it shows. Nobody’s real work is in it.'
} as const

/**
 * THE FILM (2026-11-25). The 60-second promo with music, in the front page's hero in place of the ink lockup, under
 * the buttons so the headline and the download stay in the first screen: 1920×1080 H.264 + AAC, faststart, encoded
 * down from the master for the web. It opens muted and loops; the controls let a reader turn the sound on and scrub.
 * Each language plays its own cut (2026-11-26): English subtitles on the English pages, Chinese on /zh.
 */
export const HERO_FILM = {
  file: 'cookrew-film-en.mp4',
  fileZh: 'cookrew-film.mp4',
  poster: 'cookrew-film-poster.jpg',
  width: 1920,
  height: 1080,
  label: 'Cookrew: Let your tokens flow (60-second film)',
  labelZh: 'Cookrew：让你的 token 自由流转（60 秒宣传片）'
} as const

/**
 * The film, script-free. Reduced motion cannot strip an autoplay attribute without a script, so there are two players
 * and CSS shows one: the autoplaying one names its source only for no-preference (under reduce it loads nothing), and
 * the still one (poster and controls, preload none, sound on when played) is shown only under reduce.
 */
export function heroFilm(): string {
  const film = HERO_FILM
  const label = esc(tr(film.label, film.labelZh))
  const src = `${SITE_FRAMES}${tr(film.file, film.fileZh)}`
  const common = `playsinline controls poster="${esc(`${SITE_FRAMES}${film.poster}`)}" width="${film.width}" height="${film.height}" aria-label="${label}" title="${label}"`
  return `<div class="tf-film"><video class="f-auto" autoplay muted loop preload="metadata" ${common}><source src="${src}" type="video/mp4" media="(prefers-reduced-motion: no-preference)"></video><video class="f-still" preload="none" ${common}><source src="${src}" type="video/mp4"></video></div>`
}

export const HERO_FILM_STYLE =
  '.tf-film{width:min(92vw,960px);aspect-ratio:16/9;margin:44px auto 0;border:1px solid var(--hair);border-radius:16px;box-shadow:var(--lift);background:var(--phos-bg);overflow:hidden}' +
  '.tf-film video{display:block;width:100%;height:100%;object-fit:cover;background:var(--phos-bg)}' +
  '.tf-film .f-still{display:none}' +
  '@media (prefers-reduced-motion:reduce){.tf-film .f-auto{display:none}.tf-film .f-still{display:block}}'

/**
 * The clip as a figure. No script: <video autoplay muted loop playsinline> needs none, and a reader whose browser
 * refuses autoplay sees the poster (the browser-card beat). A phone is not shown it: a 1024 px movie is unreadable at
 * 390, the source's media keeps the file from loading there, and CSS hides the figure (.feature-shots figure.clip).
 */
export function clipFigure(): string {
  const clip = CANVAS_CLIP
  const video = (file: string, poster: string, cls: string): string =>
    `<video class="${cls}" autoplay muted loop playsinline preload="${cls === 'v-day' ? 'metadata' : 'none'}" poster="${esc(`${SITE_FRAMES}${poster}`)}" width="${clip.width}" height="${clip.height}" aria-label="${esc(tr(clip.label, clip.labelZh))}"><source src="${SITE_FRAMES}${file}" type="video/mp4" media="not all and ${PHONE_MEDIA}"></video>`
  const night = FRAME_SIZES[clip.file.replace(/\.mp4$/, '-night.mp4')]
  return `<figure class="shot clip illustration" data-source="illustration">${video(clip.file, clip.poster, night ? 'v-day' : '')}${night ? video(clip.file.replace(/\.mp4$/, '-night.mp4'), clip.poster.replace(/\.jpg$/, '-night.jpg'), 'v-night') : ''}</figure>`
}
