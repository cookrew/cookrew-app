import type { Commit } from './github-commits'
import { esc, page, type Page } from './site-shell'
import { RELEASES_PAGE, pickAsset, type Release } from './releases'
import { definition, FACTS, GITHUB_REPO } from './site-content'
import { currentLang, local, tr } from './site-lang'
import { organization, softwareApplication, webPage } from './site-seo'
import { BRAND_LOCKUP_CSS, BRAND_LOCKUP_HTML } from './site-brand'
import { flow, flowHero, flowSections, FLOW_STYLE, type FlowLinks } from './site-flow'

/**
 * THE FRONT PAGE OF THE STATIC SITE: "let your tokens flow" (owner 2026-11-18, site-flow.ts). Top to bottom: the hero
 * (lockup, headline, the three flows, the download, the console, the three-device picture), the three flows with the
 * diagram, a chapter each for across devices, across agents and across models, the agents in the field, three steps to
 * start, and a last call to act. The features grid, the comparison, the questions and the roadmap left the front page;
 * each feature keeps its own page (/features/<slug>). No status label or word of progress anywhere (owner 475f4a16).
 *
 * NO MARKETPLACE: nothing here lists what a registry serves. A DOCUMENT page: no script, no form, no handler.
 */

export interface StaticHomeInput {
  release: Release | null
  /** Read by the build; the page lists no commits (owner 2026-11-18). */
  commits?: readonly Commit[] | null
  /** The console's origin. */
  console: string
}

/** What the page says it is, in one or two sentences: the hero's lede. */
const description = (): string => {
  const d = definition()
  return currentLang() === 'zh' || d.length <= 160 ? d : `${d.slice(0, 157).replace(/\s+\S*$/, '')}…`
}

function links(release: Release | null, console: string): FlowLinks {
  const mac = release ? pickAsset(release, 'mac') : null
  const win = release ? pickAsset(release, 'windows') : null
  const date = release?.publishedAt ? release.publishedAt.slice(0, 10) : ''
  const version = release ? `v${esc(release.version)}${date ? ` · ${esc(date)}` : ''}` : `<a href="${RELEASES_PAGE}">${tr('latest release', '最新版本')}</a>`
  return {
    mac: mac?.url ?? release?.url ?? RELEASES_PAGE,
    console,
    source: GITHUB_REPO,
    meta: `${version} · ${FACTS.license} · Apple Silicon · ${win ? `<a href="${esc(win.url)}">Windows</a>` : 'Windows'}`
  }
}

export function staticHomePage(input: StaticHomeInput): Page {
  const f = flow()
  const l = links(input.release, input.console)
  return page(
    {
      title: f.title,
      kind: 'document',
      active: 'home',
      description: description(),
      path: local('/'),
      jsonLd: [
        organization(),
        softwareApplication(input.release),
        webPage({ path: local('/'), name: 'Cookrew', description: definition() }),
        {
          '@type': 'HowTo',
          name: f.start.h2,
          step: f.start.steps.map(([name, text], i) => ({ '@type': 'HowToStep', position: i + 1, name, text: text.replace(/`/g, '') }))
        }
      ]
    },
    `<div class="tf-home">
<style>${BRAND_LOCKUP_CSS}${FLOW_STYLE}.tf-hero .brand{justify-content:center;padding:0 0 4px}</style>
${flowHero(l).replace('<p class="tf-k">', `${BRAND_LOCKUP_HTML}\n<p class="tf-k">`)}
${flowSections(l)}
</div>`
  )
}
