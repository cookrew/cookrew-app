import type { IncomingMessage, ServerResponse } from 'node:http'
import { json } from './http'
import { serveAsset } from './assets'
import { RELEASES_PAGE, pickAsset, type Release } from './releases'
import type { Commit } from './github-commits'
import { featurePage, featuresIndexPage } from './site-features'
import { startPage } from './site-start'
import { FAVICON_SVG, robotsTxt, sitemapXml, webManifest } from './site-seo'
import { FEATURES, llmsText } from './site-content'
import { notFoundPage, respondPage } from './site-shell'
import type { ListedDoor } from './site'
import type { Pulse } from './pulse'

/**
 * THE SITE'S OWN ROUTES — everything under a reserved top-level name that is
 * not an owner's page: the crawl files a machine reads first, the feature
 * pages, /start, the bundled assets and the /download redirect. One function
 * so server.ts stays the registry's router and this stays the site's.
 * Answers true when it claimed the request.
 */

export interface SiteRouteContext {
  method: string
  parts: string[]
  url: URL
  request: IncomingMessage
  response: ServerResponse
  decode: (value: string) => string | null
  doors: () => ListedDoor[]
  release: () => Promise<Release | null>
  commits: () => Promise<readonly Commit[] | null>
  pulse?: Pulse
  note?: (message: string) => void
}

const CRAWL_FILES = new Set(['robots.txt', 'sitemap.xml', 'llms.txt', 'favicon.svg', 'favicon.ico', 'site.webmanifest'])

export function handleSiteRoute(ctx: SiteRouteContext): boolean {
  const { method, parts, response } = ctx
  const readable = method === 'GET' || method === 'HEAD'
  if (!readable) return false

  if (parts.length === 1 && CRAWL_FILES.has(parts[0])) {
    crawlFile(ctx, parts[0])
    return true
  }
  if (parts[0] === 'features' && parts.length <= 2) {
    if (parts.length === 1) {
      ctx.pulse?.page('/features')
      void ctx
        .commits()
        .then((commits) => respondPage(response, featuresIndexPage({ commits })))
        .catch((error: unknown) => failed(ctx, error))
      return true
    }
    // Resolve before counting: only a page that exists is a page viewed.
    const slug = ctx.decode(parts[1]) ?? ''
    const known = FEATURES.some((f) => f.slug === slug)
    const rendered = known ? featurePage(slug) : null
    if (!rendered) {
      respondPage(response, notFoundPage('feature'))
      return true
    }
    ctx.pulse?.page(`/features/${slug}`)
    respondPage(response, rendered)
    return true
  }
  if (parts.length === 1 && parts[0] === 'start') {
    ctx.pulse?.page('/start')
    void ctx
      .release()
      .then((release) => respondPage(response, startPage(release)))
      .catch((error: unknown) => failed(ctx, error))
    return true
  }
  if (parts.length === 2 && parts[0] === 'assets') {
    if (!serveAsset(response, parts[1])) json(response, 404, { error: 'not_found' })
    return true
  }
  // GET /download[?platform=mac|windows] — the current build for the reader's
  // platform, or the release page when there is no build for it (or GitHub
  // has not answered yet). A redirect, so the link people share is ours and
  // keeps working when the version moves on.
  if (parts.length === 1 && parts[0] === 'download') {
    void ctx
      .release()
      .then((release) => {
        const platform = ctx.url.searchParams.get('platform') ?? ctx.request.headers['user-agent'] ?? ''
        const asset = release ? pickAsset(release, platform) : null
        response.writeHead(302, { location: asset?.url ?? release?.url ?? RELEASES_PAGE, 'cache-control': 'no-store' })
        response.end()
      })
      .catch((error: unknown) => failed(ctx, error))
    return true
  }
  return false
}

function failed(ctx: SiteRouteContext, error: unknown): void {
  ctx.note?.(`render failed: ${error instanceof Error ? error.message : String(error)}`)
  if (!ctx.response.headersSent) json(ctx.response, 500, { error: 'server' })
  else ctx.response.end()
}

function text(response: ServerResponse, method: string, type: string, body: string, cache: number): void {
  const payload = Buffer.from(body, 'utf8')
  response.writeHead(200, {
    'content-type': type,
    'content-length': String(payload.byteLength),
    'cache-control': `public, max-age=${cache}`,
    'x-content-type-options': 'nosniff'
  })
  response.end(method === 'HEAD' ? undefined : payload)
}

function crawlFile(ctx: SiteRouteContext, name: string): void {
  const { response, method } = ctx
  switch (name) {
    case 'robots.txt':
      return text(response, method, 'text/plain; charset=utf-8', robotsTxt(), 3600)
    case 'sitemap.xml':
      return text(response, method, 'application/xml; charset=utf-8', sitemapXml(ctx.doors()), 600)
    case 'llms.txt':
      return text(response, method, 'text/plain; charset=utf-8', llmsText(), 3600)
    case 'favicon.svg':
      return text(response, method, 'image/svg+xml', FAVICON_SVG, 86400)
    case 'site.webmanifest':
      return text(response, method, 'application/manifest+json', webManifest(), 86400)
    default:
      response.writeHead(302, { location: '/favicon.svg', 'cache-control': 'public, max-age=86400' })
      response.end()
  }
}
