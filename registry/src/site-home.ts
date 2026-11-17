import type { Commit } from './github-commits'
import { SITE_FRAMES } from './site-shell'
import { esc, icon, page, type Page } from './site-shell'
import { RELEASES_PAGE, pickAsset, type Release } from './releases'
import { DEFINITION, FACTS, FAQ, HEADLINE, HEADLINE_SUB, PILLARS, START_FAQ, START_HOWTO as HOWTO } from './site-content'
import { commitsSection, compareTable, featuresGrid } from './site-features'
import { faqPage, organization, softwareApplication, webPage } from './site-seo'
import { BRAND_LOCKUP_CSS, BRAND_LOCKUP_HTML } from './site-brand'
import { PROMO } from './site-motion'
import { SOURCE_CHIP } from './site-frames'
import { pillarsSection, roadmapSection } from './site-pillars'

/**
 * THE FRONT PAGE OF THE STATIC SITE (0.6.0, site-static.ts) — one page, top to
 * bottom: the hero (the claim, the download, the way to the console and the
 * hero clip), the three pillars (site-pillars.ts: every claim with its
 * status, and pictures of the current UI on demo data, each labelled as an
 * illustration), the roadmap, GET STARTED (the two steps and the commands the
 * orch runs) and the FEATURES (every one as a card, the comparison, the
 * questions, the commits). The page's sections are
 * its catalog, on the right rail. A feature's own page (/features/<slug>) is
 * the long tail, and the cards lead there.
 *
 * NO MARKETPLACE: nothing here is served by a registry, so nothing here lists
 * what one is serving. The way to "your machines" is the console.
 *
 * A DOCUMENT page: no script, no form, no handler. So the commands the crew
 * builder would write are shown as they are, which is what a reader pastes.
 */

/** The definition's first sentence: enough to quote, short enough to read. */
const ONE_LINE = DEFINITION.slice(0, DEFINITION.indexOf('. ') + 1)
const DESCRIPTION = DEFINITION.slice(0, 157).replace(/\s+\S*$/, '') + '…'

/**
 * THE HERO CLIP (2026-11-17) — twenty seconds of the current UI on the demo
 * cast, every beat one real click through the app's renderer: the workspaces
 * stop, Release Room's four agents on four harnesses, Reviewer's question as
 * rows to pick, the artifacts, Checker's browser card, and back out. It is an
 * illustration on demo data and says so; the file and its poster live with
 * the frames on GitHub. No script: <video autoplay muted loop playsinline>
 * needs none, and a reader whose browser refuses autoplay sees the poster.
 */
function promo(): string {
  const poster = `${SITE_FRAMES}${PROMO.poster}`
  return `<figure class="shot promo illustration" data-source="illustration"><video autoplay muted loop playsinline preload="metadata" poster="${esc(poster)}" width="1400" height="874" aria-label="${esc(PROMO.label)}"><source src="${SITE_FRAMES}${PROMO.file}" type="video/mp4"></video><figcaption><span class="rec src-illustration">${esc(SOURCE_CHIP.illustration)}</span><span>${esc(PROMO.caption)}</span></figcaption></figure>`
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

/** FEATURES: every one as a card, then what each thing can do, the questions, the proof. */
function featuresSection(commits: readonly Commit[] | null): string {
  return `<section id="features"><div class="wrap">
<p class="kicker"><span class="no">FEATURES</span>what each part does</p>
<h2>What Cookrew does</h2>
<p class="lede">${esc(DEFINITION)}</p>
${featuresGrid()}
<h3 id="compare" style="margin-top:32px">A chat tab, one CLI agent, or a team</h3>${compareTable()}
<h3 id="faq" style="margin-top:32px">Questions and answers</h3><div class="faq">${FAQ.map((f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</div>
</div></section>
${commitsSection(commits)}`
}

export interface StaticHomeInput {
  release: Release | null
  commits?: readonly Commit[] | null
  /** The console's origin. */
  console: string
}

function staticHeroButtons(release: Release | null, console: string): string {
  const mac = release ? pickAsset(release, 'mac') : null
  const win = release ? pickAsset(release, 'windows') : null
  const date = release?.publishedAt ? release.publishedAt.slice(0, 10) : ''
  return `<p class="row" id="download"><a class="btn primary lg" href="${esc(mac?.url ?? release?.url ?? RELEASES_PAGE)}">${icon('download')} Download for Mac</a><a class="btn lg" href="${esc(console)}/">${icon('mac')} Open console</a></p>
<p class="meta">${release ? `v${esc(release.version)}${date ? ` · ${esc(date)}` : ''}` : `<a href="${RELEASES_PAGE}">latest release</a>`} · ${FACTS.license} · Apple Silicon${win ? ` · <a href="${esc(win.url)}">Windows preview</a>` : ', Windows preview'}</p>`
}

/** The three pillars, one link each: the page's argument in one row. */
function staticDock(): string {
  const icons = ['canvas', 'mac', 'play'] as const
  return `<nav class="dock compact" aria-label="The three parts of Cookrew">
${PILLARS.map((p, i) => `<a href="#${p.id}"><span class="ico">${icon(icons[i])}</span><span><span class="t">${esc(p.title)}</span></span></a>`).join('\n')}
</nav>`
}

function staticCatalog(console: string, built: boolean): string {
  const listed: [string, string, boolean][] = [
    ['#status', 'What is shipped', false],
    ...PILLARS.map((p): [string, string, boolean] => [`#${p.id}`, p.title, true]),
    ['#roadmap', 'Roadmap', true],
    ['#start', 'Get started', false],
    ['#serve', 'Save the team', true],
    ['#build', 'What your orch runs', true],
    ['#features', 'Features', false],
    ['#compare', 'Chat tab, one agent, or a team', true],
    ['#faq', 'Questions', true],
    ['#built', 'What landed on dev', true]
  ]
  // The list of commits is on the page only when GitHub was read at build time.
  const items = listed.filter(([href]) => built || href !== '#built')
  return `<aside class="toc" aria-label="On this page">
<div class="jump"><a class="btn sm primary" href="#download">${icon('download')} Get the app</a><a class="btn sm" href="${esc(console)}/">${icon('mac')} Open console</a></div>
<p class="kicker"><span class="no">ON THIS PAGE</span></p><ol>${items
    .map(([href, label, sub]) => `<li${sub ? ' class="sub"' : ''}><a href="${href}">${esc(label)}</a></li>`)
    .join('')}</ol></aside>`
}

export function staticHomePage(input: StaticHomeInput): Page {
  return page(
    {
      title: 'Cookrew — AI coding agents on every machine, one account',
      kind: 'document',
      active: 'home',
      description: DESCRIPTION,
      path: '/',
      preload: [`${SITE_FRAMES}${PROMO.poster}`],
      jsonLd: [
        organization(),
        softwareApplication(input.release),
        webPage({ path: '/', name: 'Cookrew', description: DEFINITION }),
        {
          '@type': 'HowTo',
          name: 'Get started with Cookrew',
          description: 'Place an agent and let it orchestrate your workflow; save the team and start your next project with it.',
          step: HOWTO.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s.name, text: s.text }))
        },
        faqPage([...START_FAQ, ...FAQ])
      ]
    },
    `<div class="wrap home">
<div class="home-body">
<style>${BRAND_LOCKUP_CSS}</style>
<div class="hero"><div class="wrap">
<div>${BRAND_LOCKUP_HTML}<span class="tagline">OPEN SOURCE · ${FACTS.license} · ${FACTS.harnesses.slice(0, 4).join(' · ').toUpperCase()}</span>
<h1>${esc(HEADLINE)}</h1>
<p class="hero-sub">${esc(HEADLINE_SUB)}</p>
<p class="lede">${esc(ONE_LINE)} Follow and answer them from the desktop or any browser.</p>
${staticHeroButtons(input.release, input.console)}</div>
<div>${promo()}</div>
</div></div>

<div class="wrap" style="padding:0">${staticDock()}</div>

${pillarsSection()}

${roadmapSection()}

${startSection()}

${featuresSection(input.commits ?? null)}
</div>
${staticCatalog(input.console, (input.commits?.length ?? 0) > 0)}
</div>`
  )
}
