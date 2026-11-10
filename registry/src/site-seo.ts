import type { Release } from './releases'
import { LEGAL_PUBLISHED } from './site-legal-entity'
import { DEFINITION, FACTS, FEATURES, GITHUB_REPO, SITE_NAME, SITE_ORIGIN, type Faq } from './site-content'

/**
 * WHAT A MACHINE READS — structured data and the crawl files.
 *
 * Every JSON-LD block here says, in schema.org's vocabulary, exactly what the
 * page says in prose: the same definition, the same price.
 * One `@id` per entity, on every page, so an engine that reads three pages
 * sees one Cookrew and not three. Nothing is claimed here that the page does
 * not show.
 */

export const ORG_ID = `${SITE_ORIGIN}/#organization`
export const APP_ID = `${SITE_ORIGIN}/#software`

export function organization(): Record<string, unknown> {
  return {
    '@type': 'Organization',
    '@id': ORG_ID,
    name: SITE_NAME,
    url: SITE_ORIGIN,
    logo: `${SITE_ORIGIN}/favicon.svg`,
    sameAs: [GITHUB_REPO]
  }
}

export function softwareApplication(release: Release | null): Record<string, unknown> {
  return {
    '@type': 'SoftwareApplication',
    '@id': APP_ID,
    name: SITE_NAME,
    description: DEFINITION,
    url: SITE_ORIGIN,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: FACTS.platforms.join(', '),
    license: 'https://opensource.org/licenses/MIT',
    codeRepository: GITHUB_REPO,
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    author: { '@id': ORG_ID },
    ...(release
      ? {
          softwareVersion: release.version,
          datePublished: release.publishedAt.slice(0, 10),
          downloadUrl: release.assets.map((a) => a.url)
        }
      : {})
  }
}

export function faqPage(items: readonly Faq[]): Record<string, unknown> {
  return {
    '@type': 'FAQPage',
    mainEntity: items.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a }
    }))
  }
}

export function breadcrumbs(items: readonly { name: string; path: string }[]): Record<string, unknown> {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: `${SITE_ORIGIN}${item.path}`
    }))
  }
}

export function webPage(input: { path: string; name: string; description: string }): Record<string, unknown> {
  return {
    '@type': 'WebPage',
    '@id': `${SITE_ORIGIN}${input.path}`,
    url: `${SITE_ORIGIN}${input.path}`,
    name: input.name,
    description: input.description,
    isPartOf: { '@type': 'WebSite', url: SITE_ORIGIN, name: SITE_NAME, publisher: { '@id': ORG_ID } },
    about: { '@id': APP_ID }
  }
}

/** One <script type="application/ld+json"> with a graph of the blocks given. */
export function jsonLd(blocks: readonly Record<string, unknown>[]): string {
  const graph = { '@context': 'https://schema.org', '@graph': blocks }
  // `<` is escaped so a value can never close the script element.
  return `<script type="application/ld+json">${JSON.stringify(graph).replace(/</g, '\\u003c')}</script>`
}

/* ── the crawl files ─────────────────────────────────────────────────────── */

export function robotsTxt(): string {
  return ['User-agent: *', 'Allow: /', 'Disallow: /v1/', `Sitemap: ${SITE_ORIGIN}/sitemap.xml`, ''].join('\n')
}

/** Every page of the static site that an engine should read: the front page, a page per feature, the legal pages when published. */
export function sitemapXml(): string {
  const entries: { path: string; priority: number }[] = [
    { path: '/', priority: 1 },
    // /start and /features are anchors on the homepage; a fragment is not a
    // sitemap URL, and the redirects cover old links.
    ...FEATURES.map((f) => ({ path: `/features/${f.slug}`, priority: 0.7 })),
    ...(LEGAL_PUBLISHED
      ? [
          { path: '/privacy', priority: 0.3 },
          { path: '/terms', priority: 0.3 }
        ]
      : [])
  ]
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map((e) => `<url><loc>${esc(SITE_ORIGIN + e.path)}</loc><priority>${e.priority}</priority></url>`),
    '</urlset>',
    ''
  ].join('\n')
}

/** The pixel mark: a phosphor screen with three lines and a blinking cursor. */
export { FAVICON_SVG } from './site-brand'

export function webManifest(): string {
  return JSON.stringify({
    name: SITE_NAME,
    short_name: SITE_NAME,
    description: DEFINITION,
    start_url: '/',
    display: 'browser',
    background_color: '#faf8f4',
    theme_color: '#f4efe4',
    icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }]
  })
}

