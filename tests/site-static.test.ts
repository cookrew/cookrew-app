import { describe, expect, it } from 'vitest'
import { buildStaticSite, type StaticSiteInput } from '../registry/src/site-static'
import { FEATURES } from '../registry/src/site-content'
import { featurePage } from '../registry/src/site-features'
import type { Commit } from '../registry/src/github-commits'
import type { Release } from '../registry/src/releases'

/**
 * cookrew.dev IS A STATIC SITE (0.6.0). It is built into files once, from the
 * release tag, and served by a static host: no server of ours renders a page,
 * no page runs a script, nothing sets or reads a cookie. Whatever used to
 * live there and needs an account lives elsewhere now: machines in the
 * console, the account on the auth host; the web marketplace and the pages
 * for a person or a team are gone, and an old link to one is told where the
 * thing is now.
 */

const RELEASE: Release = {
  version: '0.6.0',
  tag: 'v0.6.0',
  publishedAt: '2026-11-12T10:00:00Z',
  url: 'https://github.com/cookrew/cookrew-app/releases/tag/v0.6.0',
  assets: [
    { name: 'Cookrew-0.6.0-arm64.dmg', url: 'https://github.com/cookrew/cookrew-app/releases/download/v0.6.0/Cookrew-0.6.0-arm64.dmg', bytes: 1 },
    { name: 'Cookrew-Setup-0.6.0.exe', url: 'https://github.com/cookrew/cookrew-app/releases/download/v0.6.0/Cookrew-Setup-0.6.0.exe', bytes: 1 }
  ]
}

const input = (over: Partial<StaticSiteInput> = {}): StaticSiteInput => ({
  release: RELEASE,
  commits: null,
  console: 'https://console.cookrew.dev',
  auth: 'https://auth.cookrew.dev',
  fonts: { 'inter.woff2': new Uint8Array([1, 2, 3]), 'jetbrains-mono.woff2': new Uint8Array([4]) },
  ...over
})

const text = (files: ReadonlyMap<string, string | Uint8Array>, path: string): string => {
  const file = files.get(path)
  if (typeof file !== 'string') throw new Error(`no text file at ${path}; have ${[...files.keys()].join(', ')}`)
  return file
}
const pages = (files: ReadonlyMap<string, string | Uint8Array>): [string, string][] =>
  [...files].filter((entry): entry is [string, string] => entry[0].endsWith('.html') && typeof entry[1] === 'string')

describe('the files', () => {
  const files = buildStaticSite(input())

  it('are the home page, a page per feature, the crawl files, the fonts and the host’s two rule files', () => {
    const names = [...files.keys()]
    expect(names).toEqual(expect.arrayContaining(['index.html', '404.html', 'robots.txt', 'sitemap.xml', 'llms.txt', 'favicon.svg', 'site.webmanifest', '_redirects', '_headers', 'assets/inter.woff2', 'assets/jetbrains-mono.woff2']))
    // A FLAT FILE PER PAGE (`features/canvas.html`, never `features/canvas/index.html`): the
    // host serves a flat file at the address without a slash, which is the address the
    // page calls canonical, and sends a directory's index to the address WITH one.
    for (const feature of FEATURES) expect(names, feature.slug).toContain(`features/${feature.slug}.html`)
    expect(names.filter((name) => name.endsWith('/index.html'))).toEqual([])
  })

  it('link nowhere on this site that is neither a file of it nor a rule of it', () => {
    const rules = text(files, '_redirects')
      .split('\n')
      .filter((line) => line.startsWith('/'))
      .map((line) => line.split(' ')[0])
    const served = (path: string): boolean => path === '/' || files.has(`${path.slice(1)}.html`) || files.has(path.slice(1)) || rules.includes(path)
    for (const [path, html] of pages(files)) {
      for (const [, link] of html.matchAll(/\s(?:href|src|poster)="(\/[^"#?]*)[^"]*"/g)) expect(served(link), `${path} links ${link}`).toBe(true)
    }
  })

  it('point at no section that is not on the page, with a commit list and without one', () => {
    const commits: Commit[] = [{ sha: 'abc1234', title: 'feat: a thing', date: '2026-11-10', url: 'https://github.com/cookrew/cookrew-app/commit/abc1234' }]
    for (const built of [files, buildStaticSite(input({ commits }))]) {
      const home = text(built, 'index.html')
      for (const [, id] of home.matchAll(/\shref="#([^"]+)"/g)) expect(home, `#${id}`).toContain(`id="${id}"`)
      for (const [path, html] of pages(built)) {
        for (const [, id] of html.matchAll(/\shref="\/#([^"]+)"/g)) expect(home, `${path} links /#${id}`).toContain(`id="${id}"`)
      }
    }
    expect(text(buildStaticSite(input({ commits })), 'index.html')).toContain('href="#built"')
  })

  it('leave the registry’s own pages as they were once the build is over, also when it stops halfway', () => {
    expect(() => buildStaticSite(input({ fonts: {} }))).toThrow()
    buildStaticSite(input())
    // Outside a build the marketplace feature still offers the registry's marketplace.
    expect(featurePage('marketplace')?.body).toContain('href="/market"')
  })

  it('carry the fonts their pages name and no other; a named font that was not handed in stops the build', () => {
    const more = buildStaticSite(input({ fonts: { ...input().fonts, 'unused.woff2': new Uint8Array([9]) } }))
    expect(more.has('assets/unused.woff2')).toBe(false)
    expect(more.get('assets/inter.woff2')).toEqual(new Uint8Array([1, 2, 3]))
    expect(() => buildStaticSite(input({ fonts: { 'inter.woff2': new Uint8Array([1]) } }))).toThrow(/jetbrains-mono\.woff2/)
  })

  it('hold no page that runs a script, posts a form or frames anything', () => {
    for (const [path, html] of pages(files)) {
      expect(html, path).not.toMatch(/<script\b(?![^>]*type="application\/ld\+json")/i)
      expect(html, path).not.toMatch(/<form\b|<iframe\b|\son[a-z]+=/i)
    }
  })

  it('point at the console for your machines and nowhere at a marketplace, a sign-in or a person’s page of this site', () => {
    const home = text(files, 'index.html')
    expect(home).toContain('href="https://console.cookrew.dev/"')
    expect(home).toContain('Open console')
    for (const [path, html] of pages(files)) {
      expect(html, path).not.toMatch(/href="(?:https:\/\/cookrew\.dev)?\/market[^"]*"/)
      expect(html, path).not.toMatch(/href="(?:https:\/\/cookrew\.dev)?\/me(?:[\/#?][^"]*)?"/)
      expect(html, path).not.toMatch(/>\s*(Sign in|Create account)\s*</)
    }
  })

  it('offer the build of the release they were made from', () => {
    const home = text(files, 'index.html')
    expect(home).toContain('Cookrew-0.6.0-arm64.dmg')
    expect(home).toContain('v0.6.0')
  })

  it('are built without a release too: the button points at the list of releases', () => {
    const bare = text(buildStaticSite(input({ release: null })), 'index.html')
    expect(bare).toMatch(/<a class="btn primary lg" href="https:\/\/github\.com\/cookrew\/cookrew-app\/releases\/latest">[^<]*(<svg.*?<\/svg>)?\s*Download for Mac/s)
  })

  it('send /download to the place on the front page where both builds are offered', () => {
    // A static host cannot read which machine is asking, so the address that used to
    // pick a build picks nothing: it lands where the reader picks.
    for (const built of [files, buildStaticSite(input({ release: null }))]) {
      expect(text(built, '_redirects')).toContain('/download /#download 302')
      expect(text(built, 'index.html')).toContain('id="download"')
    }
    expect(text(files, 'features/canvas.html')).toMatch(/href="\/#download">Get Cookrew/)
  })

  it('believe no address of a release unless it is one address under this project’s releases on github.com', () => {
    const elsewhere = (url: string): Release => ({ ...RELEASE, assets: [{ name: 'Cookrew-0.6.0-arm64.dmg', url, bytes: 1 }] })
    for (const url of [
      'https://evil.example/Cookrew.dmg',
      'https://github.com/someone-else/fork/releases/download/v0.6.0/Cookrew.dmg',
      'https://github.com/cookrew/cookrew-app/releases/download/v0.6.0/Cookrew.dmg\n/* https://evil.example/ 302',
      'https://github.com/cookrew/cookrew-app/releases/download/v0.6.0/Cookrew 0.6.0.dmg https://evil.example/'
    ]) {
      const built = buildStaticSite(input({ release: elsewhere(url) }))
      for (const [path, body] of built) {
        if (typeof body !== 'string') continue
        expect(body, `${path} · ${url}`).not.toContain('evil.example')
        expect(body, `${path} · ${url}`).not.toContain('someone-else')
      }
      // The Mac build was not believed, so the button falls back to the release's own page.
      expect(text(built, 'index.html')).toContain(`href="${RELEASE.url}"`)
    }
  })

  it('link a commit only at this project on github.com', () => {
    const commits: Commit[] = [
      { sha: 'abc1234', title: 'feat: a thing', date: '2026-11-10', url: 'https://evil.example/commit/abc1234' },
      { sha: 'def5678', title: 'fix: another', date: '2026-11-09', url: 'https://github.com/cookrew/cookrew-app/commit/def5678' }
    ]
    const home = text(buildStaticSite(input({ commits })), 'index.html')
    expect(home).not.toContain('evil.example')
    expect(home).toContain('feat: a thing')
    expect(home).toContain('https://github.com/cookrew/cookrew-app/commit/def5678')
  })
})

describe('what moved, and where an old link goes', () => {
  const files = buildStaticSite(input())
  const redirects = text(files, '_redirects').split('\n').filter((line) => line !== '' && !line.startsWith('#'))

  it('the account’s machines are the console; the account itself is the auth host', () => {
    expect(redirects).toContain('/me https://console.cookrew.dev/ 302')
    expect(redirects).toContain('/me/account https://auth.cookrew.dev/account 302')
    expect(redirects).toContain('/me/* https://auth.cookrew.dev/account 302')
  })

  it('the old section addresses still land on their sections, and /download on the build', () => {
    expect(redirects).toContain('/features /#features 301')
    expect(redirects).toContain('/start /#start 301')
    expect(redirects).toContain('/download /#download 302')
  })

  it('names only this site, the console and the auth host, each as a whole origin', () => {
    for (const line of redirects) {
      const [from, to, status] = line.split(' ')
      expect(from.startsWith('/'), line).toBe(true)
      expect(['301', '302']).toContain(status)
      if (!to.startsWith('/')) expect(['https://console.cookrew.dev', 'https://auth.cookrew.dev'], line).toContain(new URL(to).origin)
    }
  })

  it('a link to the marketplace, a person or a team that is no longer a page says where the thing is now', () => {
    expect(redirects).toContain('/market /open 302')
    const open = text(files, 'open.html')
    expect(open).toContain('opens in Cookrew')
    expect(open).toContain('Download')
    expect(open).toContain('noindex')
    // A shared link to a person or a team (`/@you/team`) is no file of the site: the host
    // answers it with 404.html, which says the same thing and admits it may be a wrong address.
    const missing = text(files, '404.html')
    expect(missing).toContain('opens in Cookrew')
    expect(missing).toContain('Import a team')
    expect(missing).toContain('noindex')
  })

  it('a join link lands on a page that says the code is typed into the app', () => {
    // The page that spent a join code in the browser ran a script and made an account
    // session; this site does neither. The code works where it always worked: in the app.
    const join = text(files, 'join.html')
    expect(join).toContain('noindex')
    expect(join).toMatch(/type the code/i)
    expect(redirects.some((line) => line.startsWith('/join '))).toBe(false)
  })

  it('refuses to be built for a console or an auth host that is not an https origin', () => {
    expect(() => buildStaticSite(input({ console: 'javascript:alert(1)' }))).toThrow()
    expect(() => buildStaticSite(input({ auth: 'https://auth.cookrew.dev/path' }))).toThrow()
    expect(() => buildStaticSite(input({ console: 'http://console.cookrew.dev' }))).toThrow()
    // A host is letters, digits, dots and hyphens: nothing that could end an attribute or a rule's field.
    expect(() => buildStaticSite(input({ console: 'https://a"b.example' }))).toThrow()
    expect(() => buildStaticSite(input({ auth: 'https://auth.cookrew.dev{x}' }))).toThrow()
  })
})

describe('what a crawler and the host are told', () => {
  const files = buildStaticSite(input())

  it('the sitemap and llms.txt list the pages that exist, and no marketplace', () => {
    const sitemap = text(files, 'sitemap.xml')
    expect(sitemap).toContain('<loc>https://cookrew.dev/</loc>')
    expect(sitemap).toContain(`/features/${FEATURES[0].slug}`)
    expect(sitemap).not.toMatch(/cookrew\.dev\/market</)
    expect(text(files, 'llms.txt')).not.toMatch(/cookrew\.dev\/market/)
  })

  it('every page is served under a policy that lets nothing run, and the files are cached by what they are', () => {
    const headers = text(files, '_headers')
    expect(headers).toMatch(/^\/\*\n/m)
    expect(headers).toContain("script-src 'none'")
    expect(headers).toContain("frame-ancestors 'none'")
    expect(headers).toContain('X-Content-Type-Options: nosniff')
    expect(headers).toContain('Referrer-Policy: no-referrer')
    // Fonts are named with their version: kept for a year.
    expect(headers).toMatch(/\/assets\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/)
    // ONE Cache-Control in the whole file. The host joins a header two matching blocks set
    // with a comma, so a rule for every page would be glued onto the fonts' rule. Pages keep
    // the host's own default, which is to ask again every time.
    expect(headers.match(/^\s+Cache-Control:/gm)).toHaveLength(1)
    for (const line of headers.split('\n')) expect(line.length, line).toBeLessThan(2000)
  })

  it('the pages name no cookie and no storage: there is nobody to remember', () => {
    for (const [path, html] of pages(files)) expect(html, path).not.toMatch(/document\.cookie|localStorage|sessionStorage/)
  })
})
