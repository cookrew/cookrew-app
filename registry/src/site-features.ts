import { FRAMES, frameImg, type Frame } from './site-frames'
import { esc, page, type Page } from './site-shell'
import { COMPARE, DEFINITION, FAQ, FEATURES, GITHUB_REPO, type FeatureSpec } from './site-content'
import type { Commit } from './github-commits'
import { SEQUENCES, type Step } from './site-sequences'
import { breadcrumbs, faqPage, organization, webPage } from './site-seo'

export interface FeaturesIndexInput {
  commits: readonly Commit[] | null
}

/**
 * FEATURE PAGES — one page per question people ask about the product.
 *
 * The homepage owns the brand; these own the long tail: "run claude code and
 * codex together", "ai agent checkpoints", "agent team marketplace". Each
 * page is the same shape — an intent-shaped H1, the definition in one
 * paragraph, the recorded step sequence QA captured (a picture per step,
 * with what was done in the past tense), the points, its own FAQ, and links
 * to the features it touches — so a reader who lands on any of them learns
 * the product and finds the next page.
 */

function stepFigure(step: Step, index: number): string {
  const frame: Frame = { file: step.file, alt: step.title, caption: step.caption, width: step.width, height: step.height }
  return `<li class="step"><div class="step-no">${index + 1}</div><div><h3>${esc(step.title)}</h3><figure class="shot">${frameImg(frame, { sizes: '(max-width: 860px) 100vw, 70vw' })}<figcaption><span class="rec">● REC</span>${esc(step.caption)}</figcaption></figure></div></li>`
}

function overviewFigure(key: string): string {
  const frame = (FRAMES as Record<string, Frame>)[key]
  if (!frame) return ''
  return `<figure class="shot">${frameImg(frame, { sizes: '(max-width: 860px) 100vw, 70vw' })}<figcaption><span class="rec">● REC</span>${esc(frame.caption)}</figcaption></figure>`
}

export function featurePage(slug: string): Page | null {
  const f = FEATURES.find((x) => x.slug === slug)
  if (!f) return null
  const steps = SEQUENCES[slug] ?? []
  const related = f.related.map((r) => FEATURES.find((x) => x.slug === r)).filter((x): x is FeatureSpec => x !== undefined)
  const path = `/features/${f.slug}`
  const visual =
    steps.length > 0
      ? `<ol class="steps">${steps.map(stepFigure).join('')}</ol>`
      : f.frames.map(overviewFigure).join('')

  return page(
    {
      title: `${f.title} · Cookrew`,
      kind: 'document',
      active: 'features',
      description: f.short.slice(0, 160),
      path,
      jsonLd: [
        organization(),
        webPage({ path, name: f.title, description: f.definition }),
        breadcrumbs([
          { name: 'Cookrew', path: '/' },
          { name: 'Features', path: '/features' },
          { name: f.title, path }
        ]),
        faqPage(f.faq)
      ]
    },
    `<div class="wrap" style="padding-top:36px">
<p class="meta"><a href="/">Cookrew</a> / <a href="/features">Features</a> / ${esc(f.slug)}</p>
<h1>${esc(f.title)}</h1>
<p class="lede">${esc(f.definition)}</p>
<ul class="pts">${f.pts.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
<p class="row"><a class="btn primary" href="/download">Get Cookrew</a><a class="btn" href="/start">Get started</a>${f.slug === 'marketplace' ? '<a class="btn" href="/market">Explore teams</a>' : ''}</p>
</div>
<section><div class="wrap"><p class="kicker"><span class="no">RECORDED</span>${steps.length > 0 ? `${steps.length} steps, captured from the running app` : 'captured from the running app'}</p>
<h2>How it looks</h2>${visual}</div></section>
<section id="faq"><div class="wrap"><h2>Questions about ${esc(f.slug === 'cli' ? 'the CLI' : f.slug)}</h2><div class="faq">${f.faq
      .map((q) => `<details open><summary>${esc(q.q)}</summary><p>${esc(q.a)}</p></details>`)
      .join('')}</div></div></section>
<section><div class="wrap"><h2>Related</h2><div class="grid">${related
      .map((r) => `<div class="card"><h3><a href="/features/${r.slug}">${esc(r.title)}</a></h3><p>${esc(r.short)}</p></div>`)
      .join('')}</div>
<p class="meta" style="margin-top:18px">${esc(DEFINITION)} <a href="${GITHUB_REPO}">Source on GitHub ↗</a></p></div></section>`
  )
}

function compareTable(): string {
  return `<table class="cmp"><caption>Chat tab, single agent CLI, or Cookrew — what each can do (2026-09)</caption><thead><tr><th></th><th>A chat tab</th><th>One CLI agent</th><th>Cookrew</th></tr></thead><tbody>${COMPARE.map(
    (r) => `<tr><th scope="row">${esc(r.question)}</th><td>${esc(r.chat)}</td><td>${esc(r.singleAgent)}</td><td><b>${esc(r.cookrew)}</b></td></tr>`
  ).join('')}</tbody></table>`
}

function commitsSection(commits: readonly Commit[] | null): string {
  if (!commits || commits.length === 0) return ''
  return `<section id="built"><div class="wrap"><p class="kicker"><span class="no">PROOF</span>built in the open, by its own crew</p><h2>What landed on the dev branch</h2>
<p>Cookrew is developed on its own canvas by a crew of agents — Forge writes features, Tinker fixes bugs, Magpie runs QA, Conductor directs — and every recorded frame on these pages comes from that canvas. These are the latest commits, straight from GitHub.</p>
<ol class="commits">${commits
    .slice(0, 10)
    .map((c) => `<li><time datetime="${esc(c.date)}">${esc(c.date)}</time> <a href="${esc(c.url)}"><code>${esc(c.sha)}</code></a> ${esc(c.title)}</li>`)
    .join('')}</ol></div></section>`
}

export function featuresIndexPage(input: FeaturesIndexInput = { commits: null }): Page {
  return page(
    {
      title: 'Cookrew features — canvas, harnesses, checkpoints, Board, CLI, phone, workspaces, marketplace',
      kind: 'document',
      active: 'features',
      description: 'Every Cookrew feature, each with recorded frames from the running app: the canvas, multi-harness teams, checkpoints, the Board, the CLI, the phone companion, workspaces and the marketplace.',
      path: '/features',
      jsonLd: [organization(), webPage({ path: '/features', name: 'Cookrew features', description: DEFINITION }), breadcrumbs([{ name: 'Cookrew', path: '/' }, { name: 'Features', path: '/features' }]), faqPage(FAQ)]
    },
    `<div class="wrap" style="padding-top:44px">
<p class="kicker"><span class="no">FEATURES</span>recorded, not described</p>
<h1>What Cookrew does</h1>
<p class="lede">${esc(DEFINITION)}</p>
<div class="grid">${FEATURES.map((f) => {
      const steps = SEQUENCES[f.slug] ?? []
      const frame = steps[0] ? { file: steps[0].file, alt: steps[0].title, caption: steps[0].caption, width: steps[0].width, height: steps[0].height } : (FRAMES as Record<string, Frame>)[f.frames[0] ?? '']
      return `<div class="card" style="padding:0;overflow:hidden">${frame ? `<a href="/features/${f.slug}">${frameImg(frame, { sizes: '(max-width: 860px) 100vw, 33vw' })}</a>` : ''}<div style="padding:14px 16px"><h3><a href="/features/${f.slug}">${esc(f.title)}</a></h3><p>${esc(f.short)}</p></div></div>`
    }).join('')}</div>
</div>
<section id="compare"><div class="wrap"><p class="kicker"><span class="no">COMPARE</span>what each can do</p><h2>A chat tab, one CLI agent, or a team</h2>${compareTable()}</div></section>
<section id="faq"><div class="wrap"><p class="kicker"><span class="no">FAQ</span>the questions people type</p><h2>Questions and answers</h2><div class="faq">${FAQ.map(
      (f) => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`
    ).join('')}</div></div></section>
${commitsSection(input.commits)}`
  )
}
