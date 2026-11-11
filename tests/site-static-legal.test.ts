import { describe, expect, it, vi } from 'vitest'

/**
 * THE DAY THE LEGAL PAGES ARE PUBLISHED (site-legal-entity.ts · LEGAL_PUBLISHED).
 * They are written with placeholders today and held back by one switch. When
 * it flips, the static site has to carry them like any other page: as files,
 * linked from the footer, scriptless, and linking nowhere that is not there.
 */
vi.mock('../registry/src/site-legal-entity', async (original) => ({
  ...(await original<typeof import('../registry/src/site-legal-entity')>()),
  LEGAL_PUBLISHED: true
}))

const { buildStaticSite } = await import('../registry/src/site-static')

const files = buildStaticSite({
  release: null,
  commits: null,
  console: 'https://console.cookrew.dev',
  auth: 'https://auth.cookrew.dev',
  fonts: { 'inter.woff2': new Uint8Array([1]), 'jetbrains-mono.woff2': new Uint8Array([2]) }
})
const page = (name: string): string => String(files.get(name))

describe('the legal pages, once published', () => {
  it('are files of the site, in the sitemap, and linked from every page’s footer', () => {
    expect(files.has('privacy.html')).toBe(true)
    expect(files.has('terms.html')).toBe(true)
    expect(page('sitemap.xml')).toContain('https://cookrew.dev/privacy')
    for (const name of ['index.html', 'open.html', '404.html', 'privacy.html']) {
      expect(page(name), name).toContain('href="/privacy"')
      expect(page(name), name).toContain('href="/terms"')
    }
  })

  it('run nothing and link nowhere that is not a file or a rule', () => {
    const rules = page('_redirects').split('\n').filter((line) => line.startsWith('/')).map((line) => line.split(' ')[0])
    for (const name of ['privacy.html', 'terms.html']) {
      const html = page(name)
      expect(html, name).not.toMatch(/<script\b(?![^>]*type="application\/ld\+json")|<form\b|<iframe\b/i)
      for (const [, link] of html.matchAll(/\shref="(\/[^"#?]*)[^"]*"/g)) {
        expect(link === '/' || files.has(`${link.slice(1)}.html`) || files.has(link.slice(1)) || rules.includes(link), `${name} links ${link}`).toBe(true)
      }
    }
  })
})
