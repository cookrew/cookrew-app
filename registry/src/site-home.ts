import type { ListedDoor } from './site'
import type { PresetSummary } from './store'
import type { Commit } from './github-commits'
import { FRAMES, frameImg, frameUrl, type Frame } from './site-frames'
import { GITHUB_REPO, esc, page, type Page } from './site-shell'
import { RELEASES_PAGE, pickAsset, type Release } from './releases'
import type { DoorPulse } from './pulse'
import {
  DEFINITION,
  FACTS,
  FAQ,
  HEADLINE,
  START_FAQ,
  START_HOWTO as HOWTO
} from './site-content'
import { commitsSection, compareTable, featuresGrid } from './site-features'
import { markSvg } from '../../src/shared/brand-mark'
import { faqPage, organization, softwareApplication, teamList, webPage } from './site-seo'

/**
 * THE FRONT PAGE — one page, top to bottom (owner ruling, 2026-09-06).
 *
 * What used to be three pages is one, in the order a newcomer reads: what
 * Cookrew is and the download, then GET STARTED (the two steps and the crew
 * builder), then the FEATURES (every one with its recorded frame, the
 * comparison, the questions, the commits), then the live market. The page's
 * sections are its catalog, on the right rail — where the header's FEATURES,
 * GET STARTED and DOWNLOAD buttons went; the header keeps HOME, the market
 * and the account. The old /start and /features addresses redirect to the
 * sections. A feature's own page
 * (/features/<slug>) stays — that is the long tail, and the cards lead there.
 *
 * A DOCUMENT page, still: no script, no form, no handler (the site tests hold
 * the front page to that, and an owner's page with it). So the crew builder's
 * interactive half — tick harnesses, copy the commands — did not move here;
 * the commands it writes are shown as they are, which is what a reader pastes.
 */

export interface HomeInput {
  doors: readonly ListedDoor[]
  presets: readonly PresetSummary[]
  release: Release | null
  stars: (handle: string, name: string) => number
  /** Today's counts for a door, from the relay's own pulse. */
  pulse: (handle: string, name: string) => DoorPulse
  /** Lines opened at every door today. */
  linesToday: number
  /** The latest commits on dev, for the PROOF section; null when GitHub has not answered. */
  commits?: readonly Commit[] | null
}

/** The definition's first sentence: enough to quote, short enough to read. */
const ONE_LINE = DEFINITION.slice(0, DEFINITION.indexOf('. ') + 1)
const DESCRIPTION = DEFINITION.slice(0, 157).replace(/\s+\S*$/, '') + '…'

export function figure(frame: Frame, options: { eager?: boolean; style?: string } = {}): string {
  return `<figure class="shot"${options.style ? ` style="${options.style}"` : ''}>${frameImg(frame, { eager: options.eager, sizes: '(max-width: 900px) 100vw, 44vw' })}<figcaption><span class="rec">● REC</span>${esc(frame.caption)}</figcaption></figure>`
}

/** One line in a list of doors — the directory, wherever it is shown. */
export function doorRow(door: ListedDoor, stars: number): string {
  const at = `/${esc(door.handle)}/${esc(door.name)}`
  const off = door.live === false
  return `<li>
<span class="led${off ? ' off' : ''}" title="${off ? 'offline' : 'taking calls'}"></span>
<div><a class="ttl" href="${at}">${esc(door.title)}</a> <span class="chip violet">${esc(door.door)} answers</span>
<div class="meta">by <a href="/${esc(door.handle)}">@${esc(door.handle)}</a> · one door: ${esc(door.door)} · ${door.agents} agent${door.agents === 1 ? '' : 's'} · ${off ? '<span class="off">offline</span>' : 'taking calls'} · via ${esc(door.transport)}</div></div>
<div class="row">${priceChip(door)}<a class="star" href="${at}#star">★ <span>${stars}</span></a></div>
</li>`
}

export function priceChip(door: ListedDoor): string {
  return door.access === 'paid' && door.priceUsd
    ? `<span class="price">${esc(door.priceUsd)} USD · per session</span>`
    : `<span class="price free">free · account needed</span>`
}

/** A served team on the board: today's numbers, one button. */
function teamCard(d: ListedDoor, stars: number, today: DoorPulse): string {
  const at = `/${esc(d.handle)}/${esc(d.name)}`
  const off = d.live === false
  const harnesses = d.harnesses ?? []
  return `<article class="team">
<div class="head"><span class="led${off ? ' off' : ''}"></span><a class="ttl" href="${at}">${esc(d.title)}</a><span class="chip">@${esc(d.handle)}</span></div>
<div class="screen crt"><div class="l">${esc(d.door)}&gt; ${off ? 'offline — address stays valid' : `taking calls · ${d.agents} agent${d.agents === 1 ? '' : 's'}`}</div><div class="l d">${harnesses.length > 0 ? esc(harnesses.join(' · ')) : `via ${esc(d.transport)}`}</div><div class="l d">${today.lines} line${today.lines === 1 ? '' : 's'} opened today</div></div>
<div class="body">${d.summary ? `<p>${esc(d.summary)}</p>` : `<p class="dim">${esc(d.door)} answers on behalf of ${d.agents} agent${d.agents === 1 ? '' : 's'}.</p>`}</div>
<div class="foot">${priceChip(d)}<span class="sp"></span><a class="star" href="${at}#star">★ <span>${stars}</span></a><a class="btn sm primary" href="${at}">Open the line</a></div>
</article>`
}

/** A preset on the board: a signed team file, reviewed in the app before anything installs. */
export function presetCard(p: PresetSummary): string {
  return `<article class="team">
<div class="head"><span class="led off" style="background:var(--violet-hi)"></span><a class="ttl" href="/install/${esc(p.id)}">${esc(p.name)}</a><span class="chip">V${p.version}</span></div>
<div class="screen crt"><div class="l">preset — a signed team file</div><div class="l d">by @${esc(p.author)} · ${p.visibility === 'identified' ? 'account needed' : 'public'}</div></div>
<div class="body"><p class="dim">Reviewed in the app before anything is installed.</p></div>
<div class="foot"><span class="price free">download · review first</span><span class="sp"></span><a class="btn sm primary" href="/install/${esc(p.id)}">Review in Cookrew</a></div>
</article>`
}

/**
 * THE LOCKUP (owner ruling, 2026-09-06): the wireframe hand is the C, two
 * lens eyes are the O's, and a second, mirrored hand under the letters types
 * K R E W in and backspaces them out on a six-second loop; both hands are
 * cabled to an eye, the cables bottoming out on one line. Cyan on a phosphor
 * band, CSS only — the front page carries no script. The geometry is
 * src/shared/brand-mark.ts, the same paths the app's header draws.
 */
export function brandBand(): string {
  const mark = markSvg({ stroke: 1.5, attrs: 'aria-hidden="true"' })
  const eye = `<span class="o" aria-hidden="true"><span class="p"></span></span>`
  const left = 'M 46 120 C 46 176 46 176 100 176 L 150 176 C 199 176 199 176 199 91'
  const right = 'M 291 91 C 291 176 291 176 340 176 L 372 176 C 417 176 417 176 417 169'
  return `<div class="brand-band" role="img" aria-label="COOKREW"><span class="lk"><svg class="cb" viewBox="0 -20 700 240" aria-hidden="true"><path d="${left}"/><path class="tt" d="${right}"/><rect x="192" y="86" width="14" height="9" rx="2"/><rect x="284" y="86" width="14" height="9" rx="2"/><rect x="38" y="116" width="16" height="8" rx="2"/><rect class="wp" x="409" y="163" width="16" height="8" rx="2"/></svg><span class="c">${mark}</span>${eye}${eye}<span class="t" aria-hidden="true"><span class="h">${mark}</span><span class="l">K</span><span class="l">R</span><span class="l">E</span><span class="l">W</span></span></span></div>`
}

/** The download links, at the top of the page — the DOWNLOAD button lands here. */
function downloadButtons(release: Release | null): string {
  const mac = release ? pickAsset(release, 'mac') : null
  const win = release ? pickAsset(release, 'windows') : null
  const date = release?.publishedAt ? release.publishedAt.slice(0, 10) : ''
  return `<p class="row" id="download"><a class="btn primary lg" href="${mac ? esc(mac.url) : '/download'}">⬇ Download for macOS</a>${win ? `<a class="btn lg" href="${esc(win.url)}">Windows preview</a>` : ''}<a class="btn lg" href="${GITHUB_REPO}" target="_blank" rel="noopener">Source ↗</a></p>
<p class="meta">${release ? `v${esc(release.version)}${date ? ` · ${esc(date)}` : ''}` : `<a href="${RELEASES_PAGE}">latest release</a>`} · ${FACTS.license} · Apple Silicon, Windows preview · Node 20+ · tmux or herdr · <a href="#start">get started ↓</a></p>`
}

/** GET STARTED: the two steps, the crew builder, and the two questions people ask first. */
function startSection(): string {
  return `<section id="start"><div class="wrap">
<p class="kicker"><span class="no">START</span>two steps to a working crew</p>
<h2>Get started</h2>
<ol class="howto two">${HOWTO.map((s, i) => `<li${i === 1 ? ' id="serve"' : ''}><h3>${esc(s.name)}</h3><p>${esc(s.text)}</p><ul class="pts">${s.detail.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></li>`).join('')}</ol>

<h3 id="build" style="margin-top:26px">What your orch runs</h3>
<p>These are the commands the orchestrator runs when you ask it for teammates — or paste them yourself into any terminal with Cookrew running. Any of ${esc(FACTS.harnesses.filter((h) => h !== 'Shell').join(', '))} goes after <code>--preset</code>.</p>
<div class="card soft" id="crew-commands">
<code class="cmd">$ cookrew recruit "Forge" --preset "Claude Code" --role "builder"
$ cookrew recruit "Bench" --preset "Codex" --role "reviewer"
$ cookrew connect "Forge" "Bench"
$ cookrew orch "Forge"</code>
<p class="meta" style="margin:10px 0 0">Names are placeholders; rename them on the canvas. The first one is the orchestrator.</p>
</div>
<div class="faq" style="margin-top:18px">${START_FAQ.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div>
</div></section>`
}

/** FEATURES: every one with its recorded frame, then what each thing can do, the questions, the proof. */
function featuresSection(commits: readonly Commit[] | null): string {
  return `<section id="features"><div class="wrap">
<p class="kicker"><span class="no">FEATURES</span>recorded, not described</p>
<h2>What Cookrew does</h2>
<p class="lede">${esc(DEFINITION)}</p>
${featuresGrid()}
<h3 id="compare" style="margin-top:32px">A chat tab, one CLI agent, or a team</h3>${compareTable()}
<h3 id="faq" style="margin-top:32px">Questions and answers</h3><div class="faq">${FAQ.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div>
</div></section>
${commitsSection(commits)}`
}

/**
 * THE CATALOG, on the right rail: the page's own sections, which is where
 * the header's FEATURES, GET STARTED and DOWNLOAD buttons went. Plain
 * anchors, because the front page has no script.
 */
function catalog(): string {
  const items: [string, string, boolean][] = [
    ['#download', 'Download', false],
    ['#start', 'Get started', false],
    ['#serve', 'Save and serve a team', true],
    ['#build', 'What your orch runs', true],
    ['#features', 'Features', false],
    ['#compare', 'Chat tab, one agent, or a team', true],
    ['#faq', 'Questions', true],
    ['#built', 'What landed on dev', true],
    ['#market', 'Market', false]
  ]
  return `<aside class="toc" aria-label="On this page"><p class="kicker"><span class="no">ON THIS PAGE</span></p><ol>${items
    .map(([href, label, sub]) => `<li${sub ? ' class="sub"' : ''}><a href="${href}">${esc(label)}</a></li>`)
    .join('')}</ol></aside>`
}

function marketSection(input: HomeInput): string {
  const serving = input.doors.filter((d) => d.live !== false).length
  const teams = input.doors.slice(0, 6).map((d) => teamCard(d, input.stars(d.handle, d.name), input.pulse(d.handle, d.name)))
  const presets = input.presets.slice(0, 6).map(presetCard)
  const serveYours = `<article class="team" style="border-style:dashed;box-shadow:none"><div class="body" style="justify-content:center;text-align:center;padding:26px 16px"><h3 style="margin:0 0 6px">Serve yours</h3><p>Save a team in the app, press SERVE. It is listed here while your relay connection is up.</p><p class="row" style="justify-content:center;margin-top:12px"><a class="btn primary" href="#serve">How ↑</a></p></div></article>`
  return `<section id="market"><div class="wrap">
<p class="kicker"><span class="no">MARKET</span>${serving} serving now · ${input.linesToday} line${input.linesToday === 1 ? '' : 's'} opened today</p>
<h2>Teams you can open right now</h2>
<p class="lede" style="font-size:16px">A served team stays on its author’s machine; you get a sandboxed session of your own, from a browser or the app. Presets are signed team files you download and review.</p>
${input.doors.length === 0 ? `<p class="empty">Nobody is serving a team here yet.</p>` : ''}<div class="teams">${teams.join('')}${serveYours}</div>
${presets.length > 0 ? `<h3 style="margin-top:26px">Presets to download</h3><div class="teams">${presets.join('')}</div>` : ''}
<p class="row" style="margin-top:18px"><a class="btn primary" href="/market">Explore the marketplace →</a></p>
</div></section>`
}

export function homePage(input: HomeInput): Page {
  return page(
    {
      title: 'Cookrew — run a team of AI coding agents on one canvas, or open someone’s',
      kind: 'document',
      active: 'home',
      description: DESCRIPTION,
      path: '/',
      preload: [`${frameUrl(FRAMES.canvas).replace(/\.jpg$/, '-800.jpg')}`],
      jsonLd: [
        organization(),
        softwareApplication(input.release),
        webPage({ path: '/', name: 'Cookrew', description: DEFINITION }),
        {
          '@type': 'HowTo',
          name: 'Get started with Cookrew',
          description: 'Place an agent and let it orchestrate your workflow; save the team as a preset and choose to publish it.',
          step: HOWTO.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s.name, text: s.text }))
        },
        faqPage([...START_FAQ, ...FAQ]),
        teamList(input.doors)
      ]
    },
    `<div class="wrap home">
<div class="home-body">
<div class="hero"><div class="wrap">
<div>${brandBand()}<span class="tagline">OPEN SOURCE · ${FACTS.harnesses.slice(0, 4).join(' · ').toUpperCase()}</span>
<h1>${esc(HEADLINE)}</h1>
<p class="lede">${esc(ONE_LINE)} Every turn is a checkpoint. Serve a team at a cookrew.dev address and anyone can open it.</p>
${downloadButtons(input.release)}</div>
<div>${figure(FRAMES.canvas, { eager: true })}</div>
</div></div>

${startSection()}

${featuresSection(input.commits ?? null)}

${marketSection(input)}
</div>
${catalog()}
</div>`
  )
}
