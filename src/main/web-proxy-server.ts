import type http from 'node:http'
import { defaultTreeAdapter as tree, html as htmlTokens, parse, serialize, type DefaultTreeAdapterTypes } from 'parse5'
import type { BrowserInstance, BrowserProxyCookie } from './browser-instance'
import { respondJson } from './mobile-http'
import {
  allowedTarget, cookieScope, decodeTarget, isWebProxyUrl, PROXY_PAGE_MIME, PROXY_SHIM, PROXY_SVG_MIME, rewriteCss, rewriteHtml, WEB_PROXY_ROUTE
} from '../shared/web-proxy'
import { BlockedProxyTarget, publicProxyFetch, publicProxyHost } from './web-proxy-network'
import { activeBrowserTab, type WorkspaceState } from '../shared/model'

const MAX_REDIRECTS = 5
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const FETCH_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 8 * 1024 * 1024
const SESSION_COOKIE_NAME = /^[!#$%&'*+.\-^_`|~0-9A-Za-z]+$/
const SESSION_COOKIE_VALUE = /^[\x20-\x3a\x3c-\x7e]*$/
const BLOCKED = 'This address is not allowed for this card.'
const UPSTREAM_FAILED = 'The browser card could not load this address.'

export interface WebProxyDeps {
  session: (cardId: string) => Promise<Pick<BrowserInstance, 'cookiesFor'> | null>
  fetch?: typeof fetch
}

function cookieBelongsToCard(cookie: BrowserProxyCookie, hostname: string): boolean {
  const domain = cookie.domain.toLowerCase()
  return (domain === hostname || (domain.startsWith('.') && `.${hostname}`.endsWith(domain))) &&
    !cookie.partitionKey && !cookie.partitionKeyOpaque &&
    SESSION_COOKIE_NAME.test(cookie.name) && SESSION_COOKIE_VALUE.test(cookie.value)
}

async function cookieHeader(session: Pick<BrowserInstance, 'cookiesFor'>, page: URL, target: URL): Promise<string> {
  if (page.protocol !== target.protocol || !cookieScope(page.href, target.hostname)) return ''
  const cookies = await session.cookiesFor?.(target.href) ?? []
  return cookies.filter((cookie) => cookieBelongsToCard(cookie, page.hostname))
    .map(({ name, value }) => `${name}=${value}`).join('; ')
}

export async function fetchThrough(
  session: Pick<BrowserInstance, 'cookiesFor'>,
  cardUrl: string,
  target: string,
  { fetch: fetchUpstream = publicProxyFetch, method = 'GET', omitCookies = false, origin }: {
    fetch?: typeof fetch; method?: 'GET' | 'HEAD'; omitCookies?: boolean; origin?: string
  } = {}
): Promise<{ response: Response; url: string }> {
  const page = new URL(cardUrl)
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  let next = new URL(target)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowedTarget(cardUrl, next.href) || !publicProxyHost(next) || (origin !== undefined && next.origin !== origin)) {
      throw new BlockedProxyTarget(BLOCKED)
    }
    const cookie = omitCookies ? '' : await cookieHeader(session, page, next)
    const response = await fetchUpstream(next.href, {
      method, redirect: 'manual', signal, headers: cookie ? { cookie } : undefined
    })
    if (response.ok) return { response, url: next.href }
    await response.body?.cancel()
    const location = response.headers.get('location')
    if (!REDIRECTS.has(response.status) || !location) break
    next = new URL(location, next)
  }
  throw new Error(UPSTREAM_FAILED)
}

async function readProxyBody(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) return Buffer.concat(chunks, size)
      size += part.value.byteLength
      if (size > MAX_BODY_BYTES) throw new Error('Proxy response is too large.')
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function proxyHtml(html: string, url: string, cardId: string): string {
  const doc = parse(html, { scriptingEnabled: false })
  const root = doc.childNodes.find((node): node is DefaultTreeAdapterTypes.Element => tree.isElementNode(node) && node.tagName === 'html')!
  const attrs = [
    { name: 'data-cookrew-proxy-card', value: cardId },
    { name: 'data-cookrew-proxy-url', value: url }
  ]
  const shim = tree.createElement('script', htmlTokens.NS.HTML, [{ name: 'data-cookrew-proxy-shim', value: '' }])
  tree.insertText(shim, PROXY_SHIM)
  const rewrite = (node: DefaultTreeAdapterTypes.ChildNode): DefaultTreeAdapterTypes.ChildNode => {
    if (!tree.isElementNode(node)) return node
    const children = node.childNodes.map(rewrite)
    const patched = rewriteHtml(node.attrs, url, cardId)
    return {
      ...node,
      attrs: node === root ? [...patched.filter(({ name }) => !attrs.some((attr) => attr.name === name)), ...attrs] : patched,
      childNodes: node.tagName === 'body' ? [...children, shim] : children
    }
  }
  return serialize({ ...doc, childNodes: doc.childNodes.map(rewrite) }, { scriptingEnabled: false })
}

function decodedText(body: Buffer, contentType: string): string {
  const charset = /;\s*charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1]
  try {
    return new TextDecoder(charset).decode(body)
  } catch {
    return body.toString('utf8')
  }
}

async function respondProxy(response: http.ServerResponse, upstream: Response, url: string, cardId: string, method: string, frame: boolean): Promise<void> {
  const type = upstream.headers.get('content-type') ?? 'application/octet-stream'
  const mime = type.split(';')[0].trim().toLowerCase()
  const html = mime === 'text/html'
  const css = mime === 'text/css'
  const svg = frame && mime === 'image/svg+xml'
  const reserved = mime === PROXY_PAGE_MIME || mime === PROXY_SVG_MIME
  const contentType = frame && html ? PROXY_PAGE_MIME : svg ? PROXY_SVG_MIME
    : reserved ? 'application/octet-stream' : html || css ? `${mime}; charset=utf-8` : type
  const headers: http.OutgoingHttpHeaders = {
    'content-type': contentType,
    'cache-control': html ? 'no-store' : 'private, max-age=60',
    'content-security-policy': "sandbox allow-scripts allow-forms allow-popups; default-src 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    vary: 'Origin, Authorization'
  }
  for (const name of ['etag', 'last-modified']) {
    const value = upstream.headers.get(name)
    if (value) headers[name] = value
  }
  if (method === 'HEAD' || upstream.status === 204 || upstream.status === 205) {
    await upstream.body?.cancel()
    response.writeHead(upstream.status, headers).end()
    return
  }
  const bytes = await readProxyBody(upstream)
  const page = html ? proxyHtml(decodedText(bytes, type), url, cardId) : null
  const body = page !== null ? Buffer.from(frame ? JSON.stringify({ html: page }) : page)
    : css ? Buffer.from(rewriteCss(decodedText(bytes, type), url, cardId))
    : svg ? Buffer.from(JSON.stringify({ svg: bytes.toString('base64') }))
    : bytes
  response.writeHead(upstream.status, { ...headers, 'content-length': body.length }).end(body)
}

export async function handleWebProxy(
  response: http.ServerResponse,
  { method, url: requestUrl, paired, workspace, deps }: {
    method: 'GET' | 'HEAD'; url: URL; paired: boolean; workspace: () => WorkspaceState | null; deps?: WebProxyDeps
  }
): Promise<boolean> {
  const route = WEB_PROXY_ROUTE.exec(requestUrl.pathname)
  if (!route) return false
  if (!paired) {
    respondJson(response, 401, { error: "Unauthorized — the owner's pairing is required." })
    return true
  }
  const [, cardId, segment] = route
  const target = decodeTarget(segment)
  const card = workspace()?.nodes.find((node) => node.id === cardId && node.kind === 'browser')
  if (!card || card.kind !== 'browser') {
    respondJson(response, 404, { error: 'This workspace has no browser card with that ID.' })
    return true
  }
  const cardUrl = activeBrowserTab(card).url
  if (!isWebProxyUrl(cardUrl) || !target || !allowedTarget(cardUrl, target) || !publicProxyHost(new URL(target))) {
    respondJson(response, 403, { error: BLOCKED })
    return true
  }
  try {
    const session = await deps?.session(card.id)
    if (!session?.cookiesFor) throw new Error(UPSTREAM_FAILED)
    const origin = requestUrl.searchParams.get('origin') ?? undefined
    const upstream = await fetchThrough(session, cardUrl, target, {
      method, fetch: deps?.fetch, omitCookies: requestUrl.searchParams.get('cookies') === 'omit', origin
    })
    await respondProxy(response, upstream.response, upstream.url, card.id, method, requestUrl.searchParams.get('format') === 'frame')
  } catch (error) {
    const blocked = error instanceof BlockedProxyTarget || (error instanceof Error && error.cause instanceof BlockedProxyTarget)
    respondJson(response, blocked ? 403 : 502, { error: blocked ? BLOCKED : UPSTREAM_FAILED })
  }
  return true
}
