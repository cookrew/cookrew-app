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
import { faqPage, organization, softwareApplication, teamList, webPage } from './site-seo'
import { BRAND_LOCKUP_CSS, BRAND_LOCKUP_HTML } from './site-brand'

/**
 * THE FRONT PAGE — one page, top to bottom (owner ruling, 2026-09-06).
 *
 * What used to be three pages is one, in the order of what a visitor came for.
 * The two destinations — a canvas and the marketplace — are both in the first
 * screen: the hero's three buttons open a live canvas, download the app, or go
 * to the market, and the dock strip under it repeats them with today's count.
 * The market itself is the first section, not the last; GET STARTED (the two
 * steps and the crew builder) and the FEATURES (every one with its recorded
 * frame, the comparison, the questions, the commits) follow for the reader who
 * keeps going. The page's
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
 * THE HERO'S BUTTONS — in the order of how fast each one reaches a canvas.
 *
 * A served team is the fastest: it is somebody's canvas, already running, and
 * it opens in this browser with nothing installed. When none is live the
 * download leads, because then the only canvas is the one you run yourself.
 * The marketplace is always the third, never a scroll away.
 */
function heroButtons(release: Release | null, live: ListedDoor | null): string {
  const mac = release ? pickAsset(release, 'mac') : null
  const win = release ? pickAsset(release, 'windows') : null
  const date = release?.publishedAt ? release.publishedAt.slice(0, 10) : ''
  const open = live
    ? `<a class="btn primary lg" href="/${esc(live.handle)}/${esc(live.name)}">▶ Open a live canvas</a>`
    : ''
  const dl = `<a class="btn ${live ? '' : 'primary '}lg" href="${mac ? esc(mac.url) : '/download'}">⬇ Download for Mac</a>`
  const market = `<a class="btn lg" href="/market">◳ Marketplace</a>`
  return `<p class="row" id="download">${open}${dl}${market}</p>
<p class="meta">${release ? `v${esc(release.version)}${date ? ` · ${esc(date)}` : ''}` : `<a href="${RELEASES_PAGE}">latest release</a>`} · ${FACTS.license} · Apple Silicon${win ? ` · <a href="${esc(win.url)}">Windows preview</a>` : ', Windows preview'} · Node 20+ · <a href="${GITHUB_REPO}" target="_blank" rel="noopener">Source ↗</a></p>`
}

/**
 * THE DOCK — the strip right under the hero, and the reason nobody scrolls to
 * find what they came for: what the canvas is, the machines on your own
 * account, and the marketplace with today's count. All three are one click
 * from the first screen.
 *
 * THE MIDDLE CELL IS HONEST ABOUT BOTH STATES. This page has no script, so it
 * cannot know whether the reader is signed in; /me answers for both — a
 * signed-in reader lands on their Macs, a signed-out one on one button.
 */
function dock(input: HomeInput): string {
  const paid = input.doors.filter((d) => d.access === 'paid')
  const serving = input.doors.filter((d) => d.live !== false).length
  const market =
    input.doors.length === 0
      ? 'Nobody is serving a team yet — serve yours'
      : `${paid.length > 0 ? `${paid.length} to rent · ` : ''}${input.doors.length} listed · ${serving} taking calls now`
  return `<nav class="dock" aria-label="Where to go first">
<a href="/features/ai-agents-on-one-canvas"><span class="ico">▦</span><span><span class="t">See the canvas</span><span class="d">Terminals, notes and browsers on one board, wired together.</span></span></a>
<a href="/me#desktops"><span class="ico">⌘</span><span><span class="t">Your machines</span><span class="d">Open a canvas on a Mac of yours, in this browser.</span></span></a>
<a href="/market"><span class="ico">◳</span><span><span class="t">Marketplace →</span><span class="d">${esc(market)}</span></span></a>
</nav>`
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
function catalog(release: Release | null): string {
  const mac = release ? pickAsset(release, 'mac') : null
  const items: [string, string, boolean][] = [
    ['#market', 'Open a team', false],
    ['#rent', 'Instances to rent', true],
    ['#start', 'Get started', true],
    ['#serve', 'Save and serve a team', true],
    ['#build', 'What your orch runs', true],
    ['#features', 'Features', false],
    ['#compare', 'Chat tab, one agent, or a team', true],
    ['#faq', 'Questions', true],
    ['#built', 'What landed on dev', true]
  ]
  return `<aside class="toc" aria-label="On this page">
<div class="jump"><a class="btn sm primary" href="${mac ? esc(mac.url) : '/download'}">⬇ Get the app</a><a class="btn sm" href="/market">◳ Marketplace</a></div>
<p class="kicker"><span class="no">ON THIS PAGE</span></p><ol>${items
    .map(([href, label, sub]) => `<li${sub ? ' class="sub"' : ''}><a href="${href}">${esc(label)}</a></li>`)
    .join('')}</ol></aside>`
}

/**
 * THE MARKET, and it is the page's first section now.
 *
 * RENT COMES FIRST. A paid instance is the one thing here somebody can decide
 * about in a second — the price is on the card — so it leads, under its own
 * heading, and the free ones follow. Presets are last because they are a
 * download and a review, not a door.
 */
function marketSection(input: HomeInput): string {
  const card = (d: ListedDoor): string => teamCard(d, input.stars(d.handle, d.name), input.pulse(d.handle, d.name))
  const paid = input.doors.filter((d) => d.access === 'paid')
  const free = input.doors.filter((d) => d.access !== 'paid')
  const serving = input.doors.filter((d) => d.live !== false).length
  const presets = input.presets.slice(0, 6).map(presetCard)
  const serveYours = `<article class="team" style="border-style:dashed;box-shadow:none"><div class="body" style="justify-content:center;text-align:center;padding:26px 16px"><h3 style="margin:0 0 6px">Serve yours</h3><p>Save a team in the app, press SERVE. It is listed here while your relay connection is up.</p><p class="row" style="justify-content:center;margin-top:12px"><a class="btn primary" href="#serve">How ↑</a></p></div></article>`
  const rent =
    paid.length > 0
      ? `<h3 id="rent" class="mkt-h">Instances you can rent<span class="chip amber">${paid.length} listed · ${paid.filter((d) => d.live !== false).length} taking calls</span></h3>
<p class="meta" style="margin:0 0 14px">Pay per session. The canvas runs on its author's machine; your session is sandboxed and thrown away when you close it.</p>
<div class="teams">${paid.slice(0, 6).map(card).join('')}</div>`
      : ''
  const open =
    free.length > 0
      ? `<h3 id="free" class="mkt-h">Free to open<span class="chip">account needed</span></h3><div class="teams">${free.slice(0, 6).map(card).join('')}${serveYours}</div>`
      : `<div class="teams">${serveYours}</div>`
  return `<section id="market"><div class="wrap">
<p class="kicker"><span class="no">MARKET</span>${serving} serving now · ${input.linesToday} line${input.linesToday === 1 ? '' : 's'} opened today</p>
<h2>Open someone’s canvas — nothing to install</h2>
<p class="lede" style="font-size:16px">A served team stays on its author’s machine; you get a sandboxed session of your own, in this browser or in the app.</p>
${input.doors.length === 0 ? `<p class="empty">Nobody is serving a team here yet.</p>` : ''}${rent}${open}
${presets.length > 0 ? `<h3 class="mkt-h" style="margin-top:26px">Presets to download<span class="chip">signed team files</span></h3><div class="teams">${presets.join('')}</div>` : ''}
<p class="row" style="margin-top:18px"><a class="btn primary lg" href="/market">Explore the marketplace →</a><a class="btn lg" href="/me#desktops">Your own machines →</a></p>
</div></section>`
}

export function homePage(input: HomeInput): Page {
  const live = input.doors.find((d) => d.live !== false) ?? null
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
<style>${BRAND_LOCKUP_CSS}</style>
<div class="hero"><div class="wrap">
<div>${BRAND_LOCKUP_HTML}<span class="tagline">OPEN SOURCE · ${FACTS.harnesses.slice(0, 4).join(' · ').toUpperCase()}</span>
<h1>${esc(HEADLINE)}</h1>
<p class="lede">${esc(ONE_LINE)} Every turn is a checkpoint.</p>
${heroButtons(input.release, live)}</div>
<div><a href="/features/ai-agents-on-one-canvas" style="text-decoration:none;display:block">${figure(FRAMES.canvas, { eager: true })}</a></div>
</div></div>

<div class="wrap" style="padding:0;margin-top:-2px">${dock(input)}</div>

${marketSection(input)}

${startSection()}

${featuresSection(input.commits ?? null)}
</div>
${catalog(input.release)}
</div>`
  )
}
