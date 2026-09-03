import { describe, expect, it } from 'vitest'
import { faqPage, jsonLd, robotsTxt, sitemapXml, softwareApplication, teamProduct } from '../registry/src/site-seo'
import { DEFINITION, FAQ, FEATURES, llmsText } from '../registry/src/site-content'
import { parseCommits } from '../registry/src/github-commits'
import { featurePage, featuresIndexPage } from '../registry/src/site-features'
import { startPage } from '../registry/src/site-start'
import type { ListedDoor } from '../registry/src/site'

/**
 * WHAT A MACHINE READS. The structured data says what the page says, the
 * crawl files name every page, and the feature pages carry the same
 * definition sentence an answer engine would quote from the homepage.
 */

const door: ListedDoor = {
  handle: 'drej',
  name: 'cookrew-alpha',
  title: 'COOKREW Alpha',
  door: 'Pilot',
  agents: 3,
  address: 'https://cookrew.dev/@drej/cookrew-alpha',
  transport: 'relay',
  access: 'paid',
  priceUsd: '2.50',
  rails: ['stripe'],
  sealKey: 'MCowBQYDK2VuAyEApz6yO0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ab',
  seenAt: Date.UTC(2026, 8, 3),
  live: true,
  summary: 'The crew that builds Cookrew.'
}

describe('structured data', () => {
  it('a team is a Product with one Offer at its price, in stock while live', () => {
    const product = teamProduct(door, 4) as { offers: Record<string, unknown>; aggregateRating: Record<string, unknown>; description: string }
    expect(product.offers.price).toBe('2.50')
    expect(product.offers.availability).toBe('https://schema.org/InStock')
    expect((product as unknown as { interactionStatistic: { userInteractionCount: number } }).interactionStatistic.userInteractionCount).toBe(4)
    expect('aggregateRating' in product).toBe(false)
    expect(product.description).toBe('The crew that builds Cookrew.')
    const off = teamProduct({ ...door, live: false, access: 'account', priceUsd: undefined }, 0) as { offers: Record<string, unknown> }
    expect(off.offers.price).toBe('0')
    expect(off.offers.availability).toBe('https://schema.org/OutOfStock')
    expect('interactionStatistic' in off).toBe(false)
  })

  it('the application carries the definition and the real version', () => {
    const app = softwareApplication({ version: '0.1.2', tag: 'v0.1.2', publishedAt: '2026-08-28T14:05:26Z', url: 'https://x', assets: [{ name: 'a.dmg', url: 'https://x/a.dmg', bytes: 1 }] }) as Record<string, unknown>
    expect(app.description).toBe(DEFINITION)
    expect(app.softwareVersion).toBe('0.1.2')
    expect(app.datePublished).toBe('2026-08-28')
    expect(app.downloadUrl).toEqual(['https://x/a.dmg'])
  })

  it('a JSON-LD script can never be closed by its content', () => {
    const script = jsonLd([faqPage([{ q: 'x', a: '</script><script>alert(1)</script>' }])])
    expect(script).not.toContain('</script><script>')
    expect(script).toContain('\\u003c/script')
  })
})

describe('the crawl files', () => {
  it('robots allows the site, hides the API, names the sitemap', () => {
    const robots = robotsTxt()
    expect(robots).toContain('Allow: /')
    expect(robots).toContain('Disallow: /v1/')
    expect(robots).toContain('Sitemap: https://cookrew.dev/sitemap.xml')
  })

  it('the sitemap names every page, with the door dated by when it was last seen', () => {
    const xml = sitemapXml([door, { ...door, name: 'b<c', handle: 'mira' }])
    expect(xml).toContain('<loc>https://cookrew.dev/</loc>')
    expect(xml).toContain('<loc>https://cookrew.dev/market</loc>')
    expect(xml).toContain('<loc>https://cookrew.dev/start</loc>')
    for (const f of FEATURES) expect(xml).toContain(`<loc>https://cookrew.dev/features/${f.slug}</loc>`)
    expect(xml).toContain('<loc>https://cookrew.dev/drej/cookrew-alpha</loc><priority>0.8</priority>')
    expect(xml).not.toContain('lastmod')
    expect(xml).toContain('<loc>https://cookrew.dev/drej</loc>')
    expect(xml).toContain('b&lt;c')
    expect(xml).not.toContain('b<c')
  })

  it('llms.txt opens with the definition and answers every FAQ', () => {
    const text = llmsText()
    expect(text.startsWith('# Cookrew\n\n> Cookrew is an open-source desktop workspace')).toBe(true)
    for (const f of FAQ) expect(text).toContain(`### ${f.q}`)
    expect(text).toContain('https://cookrew.dev/features/marketplace')
  })
})

describe('the feature and start pages', () => {
  it('every feature page is a document with its intent, its definition, a FAQ and breadcrumbs', () => {
    for (const f of FEATURES) {
      const rendered = featurePage(f.slug)
      expect(rendered, f.slug).not.toBeNull()
      expect(rendered!.status).toBe(200)
      expect(rendered!.headers['content-security-policy']).toContain("script-src 'none'")
      expect(rendered!.body).toContain(`<h1>${f.title.replace(/'/g, '&#39;').replace(/’/g, '’')}`)
      expect(rendered!.body).toContain('"@type":"BreadcrumbList"')
      expect(rendered!.body).toContain('"@type":"FAQPage"')
      expect(rendered!.body).toContain(`<link rel="canonical" href="https://cookrew.dev/features/${f.slug}">`)
      expect(rendered!.body).toContain('<meta name="description"')
      if (f.frames.length > 0) expect(rendered!.body).toContain('● REC')
    }
    expect(featurePage('nope')).toBeNull()
    expect(featurePage('../x')).toBeNull()
  })

  it('the index links every feature', () => {
    const index = featuresIndexPage()
    for (const f of FEATURES) expect(index.body).toContain(`href="/features/${f.slug}"`)
  })

  it('the start page is a HowTo with the crew builder', () => {
    const start = startPage(null)
    expect(start.headers['content-security-policy']).toContain("script-src 'self'")
    expect(start.body).toContain('"@type":"HowTo"')
    expect(start.body).toContain('id="crew-builder"')
    expect(start.body).toContain('cookrew recruit')
    expect(start.body).toContain('href="https://github.com/cookrew/cookrew-app/releases/latest"')
  })
})

describe('GitHub commits', () => {
  it('reads title, short sha and date; drops what is not a commit', () => {
    const out = parseCommits([
      { sha: 'a7e1d0be009cc485ef5a5325338636b6a2804d08', html_url: 'https://github.com/cookrew/cookrew-app/commit/a7e1d0b', commit: { message: 'feat: the web line\n\nbody', committer: { date: '2026-09-03T10:00:00Z' } } },
      { sha: 'nope' },
      { sha: 'b', html_url: 'javascript:alert(1)', commit: { message: 'x', committer: {} } }
    ])
    expect(out).toEqual([
      { sha: 'a7e1d0b', title: 'feat: the web line', date: '2026-09-03', url: 'https://github.com/cookrew/cookrew-app/commit/a7e1d0b' },
      { sha: 'b', title: 'x', date: '', url: 'https://github.com/cookrew/cookrew-app/commits/dev' }
    ])
    expect(parseCommits('nope')).toEqual([])
  })
})
