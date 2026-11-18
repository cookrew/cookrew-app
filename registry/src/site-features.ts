import { DEMO, figure } from './site-frames'
import { clipFigure } from './site-motion'
import { esc, page, type Page } from './site-shell'
import { compare, definition, features, GITHUB_REPO, listedFeatures, type FeatureSpec } from './site-content'
import { local, tr } from './site-lang'
import { breadcrumbs, faqPage, organization, webPage } from './site-seo'

/**
 * FEATURE PAGES — one page per question people ask about the product.
 *
 * The homepage owns the brand and the features overview (site-home.ts renders
 * the grid and the comparison from here); these own the long
 * tail: "run claude code and codex together", "ai
 * agent checkpoints", "agent team marketplace". Each page is the same shape
 * — an intent-shaped H1, the definition in one paragraph, the recorded step
 * sequence QA captured (a picture per step, with what was done in the past
 * tense), the points, its own FAQ, and links to the features it touches — so
 * a reader who lands on any of them learns the product and finds the next
 * page.
 */

export function featurePage(slug: string): Page | null {
  const f = features().find((x) => x.slug === slug)
  if (!f) return null
  const listed = listedFeatures()
  const related = f.related.map((r) => listed.find((x) => x.slug === r)).filter((x): x is FeatureSpec => x !== undefined)
  const path = local(`/features/${f.slug}`)
  // A page still built for old links but listed nowhere is not to be indexed as current (LISTED_FEATURES).
  const unlisted = !listed.some((x) => x.slug === f.slug)
  // The current UI on demo data, labelled; a feature no picture shows yet has none, and nothing stands in.
  const portraits = f.frames.length > 0 && f.frames.every((key) => DEMO[key].height > DEMO[key].width)
  const visual = (f.clip ? clipFigure() : '') + f.frames.map((key) => figure(DEMO[key], { sizes: portraits ? '(max-width: 640px) 100vw, 420px' : '(max-width: 1440px) 96vw, 1392px' })).join('')

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
          { name: 'Cookrew', path: local('/') },
          { name: tr('Features', '功能'), path: local('/#flow') },
          { name: f.title, path }
        ]),
        faqPage(f.faq)
      ]
    },
    `<div class="wrap" style="padding-top:36px">
<p class="meta"><a href="${local('/')}">Cookrew</a> / <a href="${local('/#flow')}">${tr('Features', '功能')}</a> / ${esc(f.slug)}</p>
<h1>${esc(f.title)}</h1>
<p class="lede">${esc(f.definition)}</p>
<ul class="pts">${f.pts.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
<p class="row"><a class="btn primary" href="${local('/#download')}">${tr('Get Cookrew', '获取 Cookrew')}</a><a class="btn" href="${local('/#start')}">${tr('Get started', '开始使用')}</a></p>
</div>
${visual ? `<section><div class="wrap">
<h2>${tr('How it looks', '界面一览')}</h2><div class="feature-shots${portraits ? ' pair' : ''}">${visual}</div></div></section>` : ''}
<section id="faq"><div class="wrap"><h2>${tr(`Questions about ${esc(f.slug === 'cli' ? 'the CLI' : f.slug)}`, '常见问题')}</h2><div class="faq">${f.faq
      .map((q) => `<details open><summary>${esc(q.q)}</summary><p>${esc(q.a)}</p></details>`)
      .join('')}</div></div></section>
<section><div class="wrap"><h2>${tr('Related', '相关功能')}</h2><div class="grid">${related
      .map((r) => `<div class="card"><h3><a href="${local(`/features/${r.slug}`)}">${esc(r.title)}</a></h3><p>${esc(r.short)}</p></div>`)
      .join('')}</div>
<p class="meta" style="margin-top:18px">${esc(definition())} <a href="${GITHUB_REPO}">${tr('Source on GitHub ↗', 'GitHub 上的源码 ↗')}</a></p></div></section>`
  )
}

export function compareTable(): string {
  return `<table class="cmp"><caption>${tr('Chat tab, single agent CLI, or Cookrew — what each can do (2026-11)', '聊天标签页、单个 agent CLI 还是 Cookrew——各自能做什么（2026-11）')}</caption><thead><tr><th></th><th>${tr('A chat tab', '聊天标签页')}</th><th>${tr('One CLI agent', '单个 CLI agent')}</th><th>Cookrew</th></tr></thead><tbody>${compare().map(
    (r) => `<tr><th scope="row">${esc(r.question)}</th><td>${esc(r.chat)}</td><td>${esc(r.singleAgent)}</td><td><b>${esc(r.cookrew)}</b></td></tr>`
  ).join('')}</tbody></table>`
}

/**
 * Every listed feature as a card: its title and one line. No picture: the
 * front page's figures are each shown once, in the pillars, and a feature's
 * own page carries its pictures.
 */
export function featuresGrid(): string {
  return `<div class="grid">${listedFeatures().map((f) => `<div class="card"><h3><a href="${local(`/features/${f.slug}`)}">${esc(f.title)}</a></h3><p>${esc(f.short)}</p></div>`).join('')}</div>`
}
