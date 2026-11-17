import { DEMO, figure } from './site-frames'
import { esc, page, type Page } from './site-shell'
import { COMPARE, DEFINITION, FEATURES, GITHUB_REPO, LISTED_FEATURES, type FeatureSpec } from './site-content'
import type { Commit } from './github-commits'
import { breadcrumbs, faqPage, organization, webPage } from './site-seo'

/**
 * FEATURE PAGES — one page per question people ask about the product.
 *
 * The homepage owns the brand and the features overview (site-home.ts renders
 * the grid, the comparison and the commits from here); these own the long
 * tail: "run claude code and codex together", "ai
 * agent checkpoints", "agent team marketplace". Each page is the same shape
 * — an intent-shaped H1, the definition in one paragraph, the recorded step
 * sequence QA captured (a picture per step, with what was done in the past
 * tense), the points, its own FAQ, and links to the features it touches — so
 * a reader who lands on any of them learns the product and finds the next
 * page.
 */

export function featurePage(slug: string): Page | null {
  const f = FEATURES.find((x) => x.slug === slug)
  if (!f) return null
  const related = f.related.map((r) => LISTED_FEATURES.find((x) => x.slug === r)).filter((x): x is FeatureSpec => x !== undefined)
  const path = `/features/${f.slug}`
  // A page still built for old links but listed nowhere is not to be indexed as current (LISTED_FEATURES).
  const unlisted = !LISTED_FEATURES.some((x) => x.slug === f.slug)
  // The current UI on demo data, labelled; a feature no picture shows yet has none, and nothing stands in.
  const visual = f.frames.map((key) => figure(DEMO[key], { sizes: '(max-width: 860px) 100vw, 70vw' })).join('')

  return page(
    {
      title: `${f.title} · Cookrew`,
      kind: 'document',
      active: 'features',
      description: f.short.slice(0, 160),
      path,
      noindex: unlisted,
      jsonLd: [
        organization(),
        webPage({ path, name: f.title, description: f.definition }),
        breadcrumbs([
          { name: 'Cookrew', path: '/' },
          { name: 'Features', path: '/#features' },
          { name: f.title, path }
        ]),
        faqPage(f.faq)
      ]
    },
    `<div class="wrap" style="padding-top:36px">
<p class="meta"><a href="/">Cookrew</a> / <a href="/#features">Features</a> / ${esc(f.slug)}</p>
<h1>${esc(f.title)}</h1>
<p class="lede">${esc(f.definition)}</p>
<ul class="pts">${f.pts.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
<p class="row"><a class="btn primary" href="/#download">Get Cookrew</a><a class="btn" href="/#start">Get started</a></p>
</div>
${visual ? `<section><div class="wrap"><p class="kicker"><span class="no">ILLUSTRATION</span>the current interface on demo data</p>
<h2>How it looks</h2><div class="feature-shots">${visual}</div></div></section>` : ''}
<section id="faq"><div class="wrap"><h2>Questions about ${esc(f.slug === 'cli' ? 'the CLI' : f.slug)}</h2><div class="faq">${f.faq
      .map((q) => `<details open><summary>${esc(q.q)}</summary><p>${esc(q.a)}</p></details>`)
      .join('')}</div></div></section>
<section><div class="wrap"><h2>Related</h2><div class="grid">${related
      .map((r) => `<div class="card"><h3><a href="/features/${r.slug}">${esc(r.title)}</a></h3><p>${esc(r.short)}</p></div>`)
      .join('')}</div>
<p class="meta" style="margin-top:18px">${esc(DEFINITION)} <a href="${GITHUB_REPO}">Source on GitHub ↗</a></p></div></section>`
  )
}

export function compareTable(): string {
  return `<table class="cmp"><caption>Chat tab, single agent CLI, or Cookrew — what each can do (2026-11)</caption><thead><tr><th></th><th>A chat tab</th><th>One CLI agent</th><th>Cookrew</th></tr></thead><tbody>${COMPARE.map(
    (r) => `<tr><th scope="row">${esc(r.question)}</th><td>${esc(r.chat)}</td><td>${esc(r.singleAgent)}</td><td><b>${esc(r.cookrew)}</b></td></tr>`
  ).join('')}</tbody></table>`
}

export function commitsSection(commits: readonly Commit[] | null): string {
  if (!commits || commits.length === 0) return ''
  return `<section id="built"><div class="wrap"><p class="kicker"><span class="no">PROOF</span>built in the open, by its own crew</p><h2>What landed on the dev branch</h2>
<p>Cookrew is developed on its own canvas by a crew of agents — Forge writes features, Tinker fixes bugs, Magpie runs QA, Conductor directs — and every recorded frame on these pages comes from that canvas. These are the latest commits, straight from GitHub.</p>
<ol class="commits">${commits
    .slice(0, 10)
    .map((c) => `<li><time datetime="${esc(c.date)}">${esc(c.date)}</time> <a href="${esc(c.url)}"><code>${esc(c.sha)}</code></a> ${esc(c.title)}</li>`)
    .join('')}</ol></div></section>`
}

/**
 * Every listed feature as a card: its title and one line. No picture: the
 * front page's figures are each shown once, in the pillars, and a feature's
 * own page carries its pictures.
 */
export function featuresGrid(): string {
  return `<div class="grid">${LISTED_FEATURES.map((f) => `<div class="card"><h3><a href="/features/${f.slug}">${esc(f.title)}</a></h3><p>${esc(f.short)}</p></div>`).join('')}</div>`
}
