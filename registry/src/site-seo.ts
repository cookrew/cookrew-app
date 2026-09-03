import type { ListedDoor } from './site'
import type { Release } from './releases'
import { DEFINITION, FACTS, FAQ, FEATURES, GITHUB_REPO, SITE_NAME, SITE_ORIGIN, type Faq } from './site-content'

/**
 * WHAT A MACHINE READS — structured data and the crawl files.
 *
 * Every JSON-LD block here says, in schema.org's vocabulary, exactly what the
 * page says in prose: the same definition, the same price, the same stars.
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

/** A served team as a Product with one Offer: the price is per session, the seller is its author. */
export function teamProduct(door: ListedDoor, stars: number): Record<string, unknown> {
  const url = `${SITE_ORIGIN}/${door.handle}/${door.name}`
  return {
    '@type': 'Product',
    '@id': `${url}#team`,
    name: door.title,
    url,
    description:
      door.summary ??
      `${door.title} is a team of ${door.agents} AI agent${door.agents === 1 ? '' : 's'} served by @${door.handle} on Cookrew; ${door.door} answers on its behalf.`,
    category: 'AI agent team',
    brand: { '@type': 'Brand', name: `@${door.handle}` },
    ...(door.harnesses && door.harnesses.length > 0 ? { keywords: door.harnesses.join(', ') } : {}),
    offers: {
      '@type': 'Offer',
      url,
      price: door.access === 'paid' && door.priceUsd ? door.priceUsd : '0',
      priceCurrency: 'USD',
      availability: door.live === false ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
      seller: { '@type': 'Person', name: `@${door.handle}`, url: `${SITE_ORIGIN}/${door.handle}` }
    },
    ...(stars > 0
      ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: 5, bestRating: 5, ratingCount: stars } }
      : {})
  }
}

export function teamList(doors: readonly ListedDoor[]): Record<string, unknown> {
  return {
    '@type': 'ItemList',
    name: 'Served agent teams on Cookrew',
    numberOfItems: doors.length,
    itemListElement: doors.map((d, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${SITE_ORIGIN}/${d.handle}/${d.name}`,
      name: d.title
    }))
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

export interface SitemapEntry {
  path: string
  lastmod?: string
  priority?: number
}

export function sitemapXml(doors: readonly ListedDoor[]): string {
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
  const handles = [...new Set(doors.map((d) => d.handle))]
  const entries: SitemapEntry[] = [
    { path: '/', priority: 1 },
    { path: '/market', priority: 0.9 },
    { path: '/start', priority: 0.8 },
    { path: '/features', priority: 0.7 },
    ...FEATURES.map((f) => ({ path: `/features/${f.slug}`, priority: 0.7 })),
    ...handles.map((h) => ({ path: `/${h}`, priority: 0.5 })),
    ...doors.map((d) => ({ path: `/${d.handle}/${d.name}`, lastmod: iso(d.seenAt), priority: 0.8 }))
  ]
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(
      (e) =>
        `<url><loc>${esc(SITE_ORIGIN + e.path)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}${e.priority !== undefined ? `<priority>${e.priority}</priority>` : ''}</url>`
    ),
    '</urlset>',
    ''
  ].join('\n')
}

/** The pixel mark: a phosphor screen with three lines and a blinking cursor. */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" fill="#14110a" stroke="#2d2a20" stroke-width="2"/><rect x="5" y="6" width="6" height="2" fill="#e9b949"/><rect x="5" y="10" width="10" height="2" fill="#e9b949"/><rect x="5" y="14" width="4" height="2" fill="#e9b949"/><rect x="11" y="14" width="2" height="2" fill="#ffd600"/></svg>`

export function webManifest(): string {
  return JSON.stringify({
    name: SITE_NAME,
    short_name: SITE_NAME,
    description: DEFINITION,
    start_url: '/',
    display: 'browser',
    background_color: '#faf8f4',
    theme_color: '#ffd600',
    icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }]
  })
}

/** The FAQ every page may reuse, so an engine sees one set of answers. */
export const SITE_FAQ = FAQ
