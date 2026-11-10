/**
 * cookrew.dev, AS FILES (0.6.0).
 *
 * The public site is static: built once from the release tag, uploaded to a
 * static host, and served by no process of ours. This is the build. It renders
 * the pages the registry used to render on request (the front page, a page per
 * feature, the legal pages when they are published), writes the crawl files,
 * and writes the two files a static host reads for its own behaviour:
 *
 *   _redirects   what moved (the account's machines to the console, the
 *                account to the auth host) and what an old link becomes
 *   _headers     the policy every page is served under (no script, no frame),
 *                and how long the fonts may be kept
 *
 * THE HOST'S RULES THIS IS WRITTEN TO (Cloudflare Pages; read 2026-11-11):
 *   - a flat file `a/b.html` is served at `/a/b`; a directory's `index.html`
 *     is served at the address WITH a slash. The pages call the slashless
 *     address canonical, so every page is a flat file.
 *   - a top-level `404.html` answers every address that is no file and no rule
 *   - a rule in `_redirects` is followed even when a file has that address
 *   - a header two matching `_headers` blocks both set is JOINED with a comma,
 *     so no header is set in two blocks that can match one address
 *
 * WHAT IS NOT HERE, because a static site cannot be it: anything that knows
 * who is reading. No sign-in, no account page, no marketplace, no page for a
 * person or a team. A link to one of those lands on a page that says where the
 * thing is now ("opens in Cookrew").
 *
 * WHAT IS A SNAPSHOT: the release the download buttons name and the commits
 * under "what landed" are read once, when the site is built.
 *
 * Pure: everything it needs is handed in, and it answers a map of path to
 * content. scripts/site-build.mjs reads the release and writes the files.
 */
import { FEATURES, GITHUB_REPO, llmsText } from './site-content'
import { featurePage } from './site-features'
import { staticHomePage } from './site-home'
import { privacyPage, termsPage } from './site-legal'
import { LEGAL_PUBLISHED } from './site-legal-entity'
import { FAVICON_SVG, robotsTxt, sitemapXml, webManifest } from './site-seo'
import { esc, icon, page, withStaticSite, type Page } from './site-shell'
import { RELEASES_PAGE, pickAsset, type Release } from './releases'
import type { Commit } from './github-commits'

export interface StaticSiteInput {
  readonly release: Release | null
  readonly commits: readonly Commit[] | null
  /** The console's origin, e.g. https://console.cookrew.dev. */
  readonly console: string
  /** The auth host's origin, e.g. https://auth.cookrew.dev. */
  readonly auth: string
  /** The font files the pages name, by file name (registry/assets/fonts). */
  readonly fonts: Readonly<Record<string, Uint8Array>>
}

/** A bare https origin, or the build stops: these go into links and redirect rules. */
function origin(name: string, raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${name} is not an origin: ${JSON.stringify(raw)}`)
  }
  if (url.protocol !== 'https:' || url.origin !== raw.replace(/\/$/, '') || url.username !== '' || url.password !== '') {
    throw new Error(`${name} must be a bare https origin: ${JSON.stringify(raw)}`)
  }
  return url.origin
}

/**
 * THE RELEASE, AS FAR AS IT IS BELIEVED. Its addresses come from GitHub's API
 * and end up in links and in a redirect rule, where a space starts the next
 * field and a line break starts the next rule. An address is kept only when it
 * is exactly one https address on github.com; an installable without one is
 * dropped, and the release's page falls back to the list of releases.
 */
function onGitHub(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.href === raw && url.protocol === 'https:' && url.host === 'github.com' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

function believed(release: Release | null): Release | null {
  if (release === null) return null
  return { ...release, url: onGitHub(release.url) ? release.url : RELEASES_PAGE, assets: release.assets.filter((asset) => onGitHub(asset.url)) }
}

/**
 * WHERE THE THING IS NOW. The marketplace, a person's page and a team's page
 * were pages of this site until 0.6.0; a link to one still arrives. They are
 * in the app now, so the page says that, and offers the app.
 */
const getTheApp = (release: Release | null): string => {
  const mac = release ? pickAsset(release, 'mac') : null
  return `<p class="row"><a class="btn primary" href="${mac ? esc(mac.url) : '/download'}">${icon('download')} Download Cookrew</a><a class="btn" href="/">Home</a><a class="btn" href="${GITHUB_REPO}">Source</a></p>`
}

function openInCookrewPage(release: Release | null): Page {
  return page(
    { title: 'This opens in Cookrew', kind: 'document', noindex: true },
    `<div class="wrap" style="padding-top:44px"><h1>This opens in Cookrew</h1>
<p class="lede">Teams, the marketplace and the people who serve them are in the app now, not on this site. Paste a team’s address into Cookrew → Import a team, and it opens there.</p>
${getTheApp(release)}</div>`
  )
}

/**
 * WHAT THE HOST ANSWERS FOR AN ADDRESS THAT IS NO FILE OF THE SITE. Most of
 * those are links shared before 0.6.0, to a person (`/@you`) or a team
 * (`/@you/team`); the rest are mistakes. The page cannot tell which, so it
 * says both.
 */
function missingPage(release: Release | null): Page {
  return page(
    { title: 'Not a page of this site — Cookrew', kind: 'document', noindex: true },
    `<div class="wrap" style="padding-top:44px"><h1>Nothing is at this address</h1>
<p class="lede">If this was a link to a team or to the person who serves it, it opens in Cookrew now: paste it into Cookrew → Import a team. Otherwise the address is mistyped, or the page is gone.</p>
${getTheApp(release)}</div>`
  )
}

/**
 * A JOIN LINK (`/join#CODE`). Until 0.6.0 this page ran a script that spent
 * the code in the browser. A static page runs nothing and never sees the
 * fragment, so it says where the code works: typed into the app.
 */
function joinPage(release: Release | null): Page {
  return page(
    { title: 'Join an account — Cookrew', kind: 'document', noindex: true },
    `<div class="wrap" style="padding-top:44px"><h1>A join code is typed into Cookrew</h1>
<p class="lede">Open Cookrew on the machine that is joining and type the code shown on the device that made it. It works once, for ten minutes. This page cannot read the code and does nothing with it.</p>
${getTheApp(release)}</div>`
  )
}

/** A flat file per page: the host serves `features/canvas.html` at `/features/canvas`. */
const htmlAt = (path: string): string => (path === '/' ? 'index.html' : `${path.replace(/^\//, '')}.html`)

/** The files under /assets/ that a page names. */
const ASSET_NAMED = /["'(]\/assets\/([A-Za-z0-9._-]+)/g

export function buildStaticSite(input: StaticSiteInput): Map<string, string | Uint8Array> {
  const console = origin('the console', input.console)
  const auth = origin('the auth host', input.auth)
  const release = believed(input.release)
  const files = new Map<string, string | Uint8Array>()
  const policies = new Set<string>()

  withStaticSite({ console, auth }, () => {
    const put = (path: string, rendered: Page): void => {
      files.set(path, rendered.body)
      policies.add(rendered.headers['content-security-policy'] ?? '')
    }
    put(htmlAt('/'), staticHomePage({ release, commits: input.commits, console }))
    for (const feature of FEATURES) {
      const rendered = featurePage(feature.slug)
      if (rendered) put(htmlAt(`/features/${feature.slug}`), rendered)
    }
    if (LEGAL_PUBLISHED) {
      put(htmlAt('/privacy'), privacyPage())
      put(htmlAt('/terms'), termsPage())
    }
    put(htmlAt('/open'), openInCookrewPage(release))
    put(htmlAt('/join'), joinPage(release))
    put('404.html', missingPage(release))
  })

  // ONE POLICY, because the host is told one for every address. A page that
  // came out under another would be served under a policy it was not drawn for.
  const [policy] = policies
  if (policies.size !== 1 || !policy || !policy.includes("script-src 'none'")) {
    throw new Error(`the pages do not share one scriptless policy: ${[...policies].join(' | ')}`)
  }

  // THE FONTS THE PAGES NAME, and no other file: a name without a file would be
  // a page in the fallback face on every visit, and nobody would be told.
  const named = new Set<string>()
  for (const body of files.values()) {
    if (typeof body === 'string') for (const [, name] of body.matchAll(ASSET_NAMED)) named.add(name)
  }
  for (const name of named) {
    const bytes = input.fonts[name]
    if (!bytes) throw new Error(`a page names /assets/${name}, and no such file was handed to the build`)
    files.set(`assets/${name}`, bytes)
  }

  files.set('robots.txt', robotsTxt())
  files.set('sitemap.xml', sitemapXml([], { market: false }))
  // The marketplace has no page on this site: its line goes, its definition (it is in the app) stays.
  files.set(
    'llms.txt',
    llmsText()
      .split('\n')
      .filter((line) => !/cookrew\.dev\/market\b/.test(line))
      .join('\n')
  )
  files.set('favicon.svg', FAVICON_SVG)
  files.set('site.webmanifest', webManifest())

  // No host can read who is asking, so /download is the Mac build; the front
  // page names the Windows one beside it.
  const download = (release ? pickAsset(release, 'mac')?.url : null) ?? release?.url ?? RELEASES_PAGE
  files.set(
    '_redirects',
    [
      '# What moved in 0.6.0, and what an old link becomes. Written by registry/src/site-static.ts.',
      `/me ${console}/ 302`,
      `/me/account ${auth}/account 302`,
      `/me/* ${auth}/account 302`,
      '/features /#features 301',
      '/start /#start 301',
      `/download ${download} 302`,
      '/favicon.ico /favicon.svg 302',
      '/market /open 302',
      ''
    ].join('\n')
  )
  files.set(
    '_headers',
    [
      '# The policy every page is served under, and how long the fonts are kept. Written by registry/src/site-static.ts.',
      '# Cache-Control is set in ONE block: the host joins a header two matching blocks set, and its own default for a page is to ask again every time.',
      '/*',
      `  Content-Security-Policy: ${policy}`,
      '  X-Content-Type-Options: nosniff',
      '  Referrer-Policy: no-referrer',
      '',
      '/assets/*',
      '  Cache-Control: public, max-age=31536000, immutable',
      ''
    ].join('\n')
  )
  return files
}
