import type { ListedDoor } from './site'
import { FRAMES, frameImg, frameUrl, type Frame } from './site-frames'
import { GITHUB_REPO, esc, page, type Page } from './site-shell'
import { RELEASES_PAGE, pickAsset, type Release } from './releases'
import type { Commit } from './github-commits'
import type { DoorPulse } from './pulse'
import { COMPARE, DEFINITION, FACTS, FAQ, FEATURES, HEADLINE, MARKET_DEFINITION } from './site-content'
import { faqPage, organization, softwareApplication, webPage } from './site-seo'

/**
 * THE FRONT PAGE — the marketplace is the homepage.
 *
 * FIRST PRINCIPLES. A search engine ranks a page for a question it answers;
 * an answer engine quotes a sentence that stands alone; a person stays where
 * something real is happening. So the first viewport is a query-shaped
 * headline, the one-paragraph definition, two next steps and dated proof —
 * and beside it the live board: which teams are serving and how many lines
 * opened today, counted by the relay, not typed by anyone. The feature tour,
 * the comparison people search for, the FAQ and the project's own commits
 * follow. Nothing is staged.
 */

export interface HomeInput {
  doors: readonly ListedDoor[]
  release: Release | null
  stars: (handle: string, name: string) => number
  /** Today's counts for a door, from the relay's own pulse. */
  pulse: (handle: string, name: string) => DoorPulse
  /** Lines opened at every door today. */
  linesToday: number
  commits: readonly Commit[] | null
}

const DESCRIPTION = DEFINITION.slice(0, 157).replace(/\s+\S*$/, '') + '…'

const TOUR: { slug: string; no: string; frames: Frame[]; cmd?: string; flip?: boolean }[] = [
  { slug: 'canvas', no: '01', frames: [FRAMES.task] },
  { slug: 'harnesses', no: '02', frames: [FRAMES.harness], flip: true },
  { slug: 'checkpoints', no: '03', frames: [FRAMES.trace, FRAMES.rail] },
  { slug: 'board', no: '04', frames: [FRAMES.board], flip: true },
  {
    slug: 'cli',
    no: '05',
    frames: [],
    cmd: `$ cookrew list                      <span class="c"># who I am wired to</span>
$ cookrew ask "Tinker" "fix the socket singleton bug"
$ cookrew status                    <span class="c"># thinking / waiting / replied</span>
$ cookrew fork "Forge" --turn 40
$ cookrew team save "COOKREW CORE"
$ cookrew workspace create "New project" --team "COOKREW CORE"
$ cookrew recruit "Magpie" --preset "Claude Code" --role "QA"`
  },
  { slug: 'mobile', no: '06', frames: [FRAMES.mobile], flip: true },
  { slug: 'workspaces', no: '07', frames: [FRAMES.workspaces] },
  { slug: 'marketplace', no: '08', frames: [FRAMES.market], flip: true }
]

export function figure(frame: Frame, options: { eager?: boolean; style?: string } = {}): string {
  return `<figure class="shot"${options.style ? ` style="${options.style}"` : ''}>${frameImg(frame, { eager: options.eager })}<figcaption><span class="rec">● REC</span>${esc(frame.caption)}</figcaption></figure>`
}

function tourSection(t: (typeof TOUR)[number]): string {
  const f = FEATURES.find((x) => x.slug === t.slug)
  if (!f) return ''
  const visual = t.cmd ? `<code class="cmd">${t.cmd}</code>` : t.frames.map((fr, i) => figure(fr, { style: i > 0 ? 'margin-top:18px' : '' })).join('')
  return `<section id="${f.slug}"><div class="wrap feature${t.flip ? ' flip' : ''}">
<div class="text"><p class="kicker"><span class="no">${t.no}</span>${t.frames.length > 0 ? '<span class="chip rec-chip">✓ recorded</span>' : ''}</p>
<h2>${esc(f.title)}</h2><p>${esc(f.definition)}</p>
<ul class="pts">${f.pts.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
<p class="row"><a class="btn" href="/features/${f.slug}">Read more →</a></p></div>
<div>${visual}</div></div></section>`
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

/** The live board: one card per door with today's numbers, and a card that recruits owners. */
function liveBoard(input: HomeInput): string {
  const cards = input.doors.slice(0, 5).map((d) => {
    const at = `/${esc(d.handle)}/${esc(d.name)}`
    const off = d.live === false
    const today = input.pulse(d.handle, d.name)
    const harnesses = d.harnesses ?? []
    return `<article class="team">
<div class="head"><span class="led${off ? ' off' : ''}"></span><a class="ttl" href="${at}">${esc(d.title)}</a><span class="chip">@${esc(d.handle)}</span></div>
<div class="screen crt"><div class="l">${esc(d.door)}&gt; ${off ? 'offline — address stays valid' : `taking calls · ${d.agents} agent${d.agents === 1 ? '' : 's'} behind the door`}</div><div class="l d">${harnesses.length > 0 ? esc(harnesses.join(' · ')) : `via ${esc(d.transport)}`}</div><div class="l d">${today.lines} line${today.lines === 1 ? '' : 's'} opened today · ${today.calls} calls</div></div>
<div class="body">${d.summary ? `<p>${esc(d.summary)}</p>` : `<p class="dim">${esc(d.door)} answers on behalf of ${d.agents} agent${d.agents === 1 ? '' : 's'}.</p>`}</div>
<div class="foot">${priceChip(d)}<span class="sp"></span><a class="star" href="${at}#star">★ <span>${input.stars(d.handle, d.name)}</span></a><a class="btn sm primary" href="${at}">Open the line</a></div>
</article>`
  })
  const serveYours = `<article class="team" style="border-style:dashed;box-shadow:none"><div class="body" style="justify-content:center;text-align:center;padding:26px 16px"><h3 style="margin:0 0 6px">Serve yours</h3><p>Save a team in the app, press SERVE, sign with your account. It is listed here the moment your relay connection is up, and marked offline the moment it is not.</p><p class="row" style="justify-content:center;margin-top:12px"><a class="btn primary" href="/start#serve">How →</a></p></div></article>`
  return `<div class="teams">${cards.join('')}${serveYours}</div>`
}

function downloadButtons(release: Release | null): string {
  const mac = release ? pickAsset(release, 'mac') : null
  const win = release ? pickAsset(release, 'windows') : null
  const date = release?.publishedAt ? release.publishedAt.slice(0, 10) : ''
  return `<p class="row"><a class="btn primary lg" href="${mac ? esc(mac.url) : '/download'}">⬇ Download for macOS</a>${win ? `<a class="btn lg" href="${esc(win.url)}">Windows preview</a>` : ''}<a class="btn lg" href="/market">Explore teams →</a></p>
<p class="meta">${release ? `v${esc(release.version)}${date ? ` · released ${esc(date)}` : ''}` : `<a href="${RELEASES_PAGE}">latest release</a>`} · ${FACTS.license} · ${FACTS.testsGreen.value} tests green (${FACTS.testsGreen.date}) · built by ${FACTS.builtBy} · <a href="${GITHUB_REPO}">source ↗</a></p>`
}

function compareTable(): string {
  return `<table class="cmp"><caption>Chat tab, single agent CLI, or Cookrew — what each can do (2026-09)</caption><thead><tr><th></th><th>A chat tab</th><th>One CLI agent</th><th>Cookrew</th></tr></thead><tbody>${COMPARE.map(
    (r) => `<tr><th scope="row">${esc(r.question)}</th><td>${esc(r.chat)}</td><td>${esc(r.singleAgent)}</td><td><b>${esc(r.cookrew)}</b></td></tr>`
  ).join('')}</tbody></table>`
}

function faqSection(): string {
  return `<section id="faq"><div class="wrap"><p class="kicker"><span class="no">FAQ</span>the questions people type</p><h2>Questions and answers</h2><div class="faq">${FAQ.map(
    (f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`
  ).join('')}</div></div></section>`
}

function commitsSection(commits: readonly Commit[] | null): string {
  if (!commits || commits.length === 0) return ''
  return `<section id="built"><div class="wrap"><p class="kicker"><span class="no">PROOF</span>built in the open, by its own crew</p><h2>What landed on the dev branch</h2>
<p>Cookrew is developed on its own canvas by a crew of agents — Forge writes features, Tinker fixes bugs, Magpie runs QA, Conductor directs — and every recorded frame on this page comes from that canvas. These are the latest commits, straight from GitHub.</p>
<ol class="commits">${commits
    .slice(0, 10)
    .map((c) => `<li><time datetime="${esc(c.date)}">${esc(c.date)}</time> <a href="${esc(c.url)}"><code>${esc(c.sha)}</code></a> ${esc(c.title)}</li>`)
    .join('')}</ol></div></section>`
}

export function downloadSection(release: Release | null): string {
  const mac = release ? pickAsset(release, 'mac') : null
  const win = release ? pickAsset(release, 'windows') : null
  const mb = (bytes: number): string => (bytes > 0 ? ` · ${(bytes / 1048576).toFixed(0)} MB` : '')
  return `<section id="download"><div class="wrap">
<p class="kicker"><span class="no">GET IT</span>${release ? `v${esc(release.version)}` : 'latest'}</p>
<h2>Download Cookrew</h2>
<div class="dl">
<div class="card"><h3>macOS · Apple Silicon</h3>${mac ? `<a class="btn primary" href="${esc(mac.url)}">${esc(mac.name)}</a><small>${esc(release?.publishedAt.slice(0, 10) ?? '')}${mb(mac.bytes)}</small>` : `<a class="btn primary" href="${RELEASES_PAGE}">latest release ↗</a>`}</div>
<div class="card"><h3>Windows · preview</h3>${win ? `<a class="btn" href="${esc(win.url)}">${esc(win.name)}</a><small>Preview quality${mb(win.bytes)}</small>` : `<a class="btn" href="${RELEASES_PAGE}">latest release ↗</a>`}</div>
<div class="card"><h3>Build from source</h3><code class="cmd" style="margin:8px 0;font-size:14px">git clone ${GITHUB_REPO}
npm install &amp;&amp; npm run dev</code><small>Node 20+, tmux or herdr. <a href="${GITHUB_REPO}">Read the README ↗</a></small></div>
</div>
<p class="meta">Every team page also answers a <code>cookrew://</code> link, so a team you found on the web opens in the app you already have. <a href="/start">Get started →</a></p>
</div></section>`
}

export function homePage(input: HomeInput): Page {
  const { doors, release } = input
  const serving = doors.filter((d) => d.live !== false).length
  const board =
    doors.length === 0
      ? `<p class="empty">Nobody is serving a team here yet. <a href="/start#serve">Serve the first one.</a></p>`
      : liveBoard(input)

  return page(
    {
      title: 'Cookrew — run a team of AI coding agents on one canvas, or open someone’s',
      kind: 'document',
      active: 'home',
      description: DESCRIPTION,
      path: '/',
      preload: [frameUrl(FRAMES.canvas)],
      jsonLd: [
        organization(),
        softwareApplication(release),
        webPage({ path: '/', name: 'Cookrew', description: DEFINITION }),
        faqPage(FAQ)
      ]
    },
    `
<div class="hero"><div class="wrap">
<div><span class="tagline">OPEN SOURCE · MAC &amp; WINDOWS PREVIEW</span>
<h1>${esc(HEADLINE)}</h1>
<p class="lede">${esc(DEFINITION)}</p>
${downloadButtons(release)}
<p class="row" style="margin-top:14px"><span class="chip amber">● ${serving} team${serving === 1 ? '' : 's'} serving now</span><span class="chip">${input.linesToday} line${input.linesToday === 1 ? '' : 's'} opened today</span><span class="chip">${FACTS.harnesses.slice(0, 4).join(' · ')}</span></p></div>
<div>${figure(FRAMES.canvas, { eager: true })}</div>
</div></div>

<section id="serving"><div class="wrap">
<p class="kicker"><span class="no">LIVE</span>the board · counted by the relay, refreshed on every request</p>
<h2>Serving right now${serving > 0 ? ` · ${serving}` : ''}</h2>
<p class="lede" style="font-size:16px">${esc(MARKET_DEFINITION)}</p>
${board}
<p class="row" style="margin-top:18px"><a class="btn primary" href="/market">Explore all teams →</a><a class="btn" href="/features/marketplace">How the marketplace works</a></p>
</div></section>

${TOUR.map(tourSection).join('\n')}

<section id="compare"><div class="wrap"><p class="kicker"><span class="no">COMPARE</span>what each can do</p><h2>A chat tab, one CLI agent, or a team</h2>${compareTable()}</div></section>

${faqSection()}

${commitsSection(input.commits)}

${downloadSection(release)}`
  )
}
