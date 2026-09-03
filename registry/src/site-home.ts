import type { ListedDoor } from './site'
import type { PresetSummary } from './store'
import { FRAMES, frameImg, frameUrl, type Frame } from './site-frames'
import { GITHUB_REPO, esc, page, type Page } from './site-shell'
import { RELEASES_PAGE, pickAsset, type Release } from './releases'
import type { DoorPulse } from './pulse'
import { DEFINITION, FACTS, FEATURES, HEADLINE } from './site-content'
import { organization, softwareApplication, teamList, webPage } from './site-seo'

/**
 * THE FRONT PAGE — short on purpose.
 *
 * Three things, in this order: what Cookrew is and where to get it, the
 * market (served teams and presets, real, with today's numbers), and one
 * line per feature that leads to its own page. Everything longer — the
 * recorded sequences, the comparison, the FAQ, the commits — lives on the
 * pages a reader clicks into, so this one can be read in a minute and still
 * says the sentence an answer engine quotes.
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

function downloadButtons(release: Release | null): string {
  const mac = release ? pickAsset(release, 'mac') : null
  const win = release ? pickAsset(release, 'windows') : null
  const date = release?.publishedAt ? release.publishedAt.slice(0, 10) : ''
  return `<p class="row"><a class="btn primary lg" href="${mac ? esc(mac.url) : '/download'}">⬇ Download for macOS</a>${win ? `<a class="btn lg" href="${esc(win.url)}">Windows preview</a>` : ''}<a class="btn lg" href="${GITHUB_REPO}" target="_blank" rel="noopener">Source ↗</a></p>
<p class="meta">${release ? `v${esc(release.version)}${date ? ` · ${esc(date)}` : ''}` : `<a href="${RELEASES_PAGE}">latest release</a>`} · ${FACTS.license} · Apple Silicon, Windows preview · <a href="/start">get started →</a></p>`
}

function marketSection(input: HomeInput): string {
  const serving = input.doors.filter((d) => d.live !== false).length
  const teams = input.doors.slice(0, 6).map((d) => teamCard(d, input.stars(d.handle, d.name), input.pulse(d.handle, d.name)))
  const presets = input.presets.slice(0, 6).map(presetCard)
  const serveYours = `<article class="team" style="border-style:dashed;box-shadow:none"><div class="body" style="justify-content:center;text-align:center;padding:26px 16px"><h3 style="margin:0 0 6px">Serve yours</h3><p>Save a team in the app, press SERVE. It is listed here while your relay connection is up.</p><p class="row" style="justify-content:center;margin-top:12px"><a class="btn primary" href="/start#serve">How →</a></p></div></article>`
  return `<section id="market"><div class="wrap">
<p class="kicker"><span class="no">MARKET</span>${serving} serving now · ${input.linesToday} line${input.linesToday === 1 ? '' : 's'} opened today</p>
<h2>Teams you can open right now</h2>
<p class="lede" style="font-size:16px">A served team stays on its author’s machine; you get a sandboxed session of your own, from a browser or the app. Presets are signed team files you download and review.</p>
${input.doors.length === 0 ? `<p class="empty">Nobody is serving a team here yet.</p>` : ''}<div class="teams">${teams.join('')}${serveYours}</div>
${presets.length > 0 ? `<h3 style="margin-top:26px">Presets to download</h3><div class="teams">${presets.join('')}</div>` : ''}
<p class="row" style="margin-top:18px"><a class="btn primary" href="/market">Explore the marketplace →</a></p>
</div></section>`
}

function featuresSection(): string {
  return `<section id="features"><div class="wrap">
<p class="kicker"><span class="no">FEATURES</span>one line each · recorded on the pages</p>
<h2>What is in the app</h2>
<ul class="one-liners">${FEATURES.map((f) => `<li><a href="/features/${f.slug}"><b>${esc(f.title)}</b></a><span>${esc(f.short)}</span></li>`).join('')}</ul>
<p class="row" style="margin-top:14px"><a class="btn" href="/features">All features, with recorded steps →</a><a class="btn" href="/features#faq">Questions →</a></p>
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
        teamList(input.doors)
      ]
    },
    `
<div class="hero"><div class="wrap">
<div><span class="tagline">OPEN SOURCE · ${FACTS.harnesses.slice(0, 4).join(' · ').toUpperCase()}</span>
<h1>${esc(HEADLINE)}</h1>
<p class="lede">${esc(ONE_LINE)} Every turn is a checkpoint. Serve a team at a cookrew.dev address and anyone can open it.</p>
${downloadButtons(input.release)}</div>
<div>${figure(FRAMES.canvas, { eager: true })}</div>
</div></div>

${marketSection(input)}

${featuresSection()}`
  )
}
