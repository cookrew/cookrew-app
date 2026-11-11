import { describe, expect, it } from 'vitest'
import { faqPage, jsonLd, robotsTxt, sitemapXml, softwareApplication } from '../registry/src/site-seo'
import { DEFINITION, FAQ, FEATURES, llmsText } from '../registry/src/site-content'
import { parseCommits } from '../registry/src/github-commits'
import { featurePage } from '../registry/src/site-features'
import { staticHomePage } from '../registry/src/site-home'
import { withStaticSite } from '../registry/src/site-shell'

/**
 * WHAT A MACHINE READS. The structured data says what the page says, the
 * crawl files name every page, and the feature pages carry the same
 * definition sentence an answer engine would quote from the homepage.
 */

/** The pages are the static site's (0.6.0): each is drawn the way the build draws it. */
const CONSOLE = 'https://console.cookrew.dev'
const drawn = <T>(render: () => T): T => withStaticSite({ console: CONSOLE, auth: 'https://auth.cookrew.dev' }, render)

describe('structured data', () => {
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

  it('the sitemap names every page of the static site, and nothing the registry used to list', () => {
    const xml = sitemapXml()
    expect(xml).toContain('<loc>https://cookrew.dev/</loc><priority>1</priority>')
    expect(xml).not.toContain('<loc>https://cookrew.dev/market</loc>')
    // /start and /features are sections of the homepage now; a fragment is
    // not a sitemap URL, and the old addresses redirect.
    expect(xml).not.toContain('<loc>https://cookrew.dev/start</loc>')
    expect(xml).not.toContain('<loc>https://cookrew.dev/features</loc>')
    for (const f of FEATURES) expect(xml).toContain(`<loc>https://cookrew.dev/features/${f.slug}</loc><priority>0.7</priority>`)
    expect(xml).not.toContain('lastmod')
    // No person and no team: those pages are gone, so no address but the site's own is named.
    const listed = [...xml.matchAll(/<loc>https:\/\/cookrew\.dev(\/[^<]*)<\/loc>/g)].map(([, at]) => at)
    expect(listed.filter((at) => at !== '/' && !at.startsWith('/features/') && at !== '/privacy' && at !== '/terms')).toEqual([])
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
      const rendered = drawn(() => featurePage(f.slug))
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

  // The features index and the start page are sections of the homepage now
  // (2026-09-06); what they promised a crawler, the homepage promises.
  const home = drawn(() =>
    staticHomePage({
      release: null,
      commits: [{ sha: 'a7e1d0b', title: 'feat: the web line', date: '2026-09-03', url: 'https://github.com/cookrew/cookrew-app/commit/a7e1d0b' }],
      console: CONSOLE
    })
  )

  it('the homepage links every feature, with the questions and the commits', () => {
    for (const f of FEATURES) expect(home.body).toContain(`href="/features/${f.slug}"`)
    expect(home.body).toContain('"@type":"FAQPage"')
    expect(home.body).toContain('feat: the web line')
  })

  it('the homepage is a HowTo with the commands the orch runs, and stays a document', () => {
    expect(home.headers['content-security-policy']).toContain("script-src 'none'")
    expect(home.body).toContain('"@type":"HowTo"')
    expect(home.body).toContain('id="crew-commands"')
    expect(home.body).toContain('cookrew recruit')
    expect(home.body).toContain('href="https://github.com/cookrew/cookrew-app/releases/latest"')
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
