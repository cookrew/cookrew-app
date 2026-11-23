import { defaultTreeAdapter as tree, html, parse, serialize, type DefaultTreeAdapterTypes as Tree } from 'parse5'
import { decodeTarget, PROXY_SVG_MIME, proxyPath, rewriteUrl, WEB_PROXY_ROUTE } from '../../../shared/web-proxy'
import { PROXY_FRAME_SCRIPT, PROXY_FRAME_SCRIPT_HASH } from '../../../shared/web-proxy-frame.mjs'

const MAX_ASSETS = 128
const MAX_ASSET_BYTES = 12 * 1024 * 1024
const ASSET_CONCURRENCY = 6
const MAX_STYLE_DEPTH = 4
const FRAME_CSP = [
  "default-src 'none'", `script-src ${PROXY_FRAME_SCRIPT_HASH}`, "style-src 'unsafe-inline'", 'img-src data: blob:',
  'font-src data:', 'media-src data: blob:', 'connect-src blob: data:', "base-uri 'none'", "form-action 'none'"
].join('; ')
export interface ProxyReadOptions {
  readonly origin?: string
  readonly omitCookies?: boolean
  readonly frameFormat?: boolean
}

export type ReadProxyAsset = (path: string, method: 'GET' | 'HEAD', options?: ProxyReadOptions) => Promise<Response>
const element = (tag: string, attrs: Tree.Element['attrs'] = [], text?: string): Tree.Element => {
  const node = tree.createElement(tag, html.NS.HTML, attrs)
  if (text !== undefined) tree.insertText(node, text)
  return node
}

export function proxyTargetOf(path: unknown, card: string): string | null {
  if (typeof path !== 'string' || path.length > 16_384) return null
  const match = WEB_PROXY_ROUTE.exec(path)
  if (match?.[1] !== card) return null
  const decoded = decodeTarget(match[2])
  if (!decoded) return null
  const target = new URL(decoded)
  return /^(https?:)$/.test(target.protocol) && !target.username && !target.password ? target.href : null
}

function base64(bytes: Uint8Array): string {
  const chunks: string[] = []
  const chunkSize = 8192
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)))
  }
  return btoa(chunks.join(''))
}

const mimeOf = (response: Response): string => response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
const attr = (node: Tree.Element, name: string): string | undefined => node.attrs.find((entry) => entry.name === name)?.value
const without = (node: Tree.Element, ...names: string[]): Tree.Element => ({ ...node, attrs: node.attrs.filter(({ name }) => !names.includes(name)) })
const textOf = (node: Tree.Element): string => node.childNodes.filter(tree.isTextNode).map((text) => text.value).join('')
const setAttr = (node: Tree.Element, name: string, value: string): Tree.Element => ({
  ...node, attrs: [...node.attrs.filter((entry) => entry.name !== name), { name, value }]
})

const CSS_URL = /url\(\s*(['"]?)([^'"\s)]+)\1\s*\)/gi
const CSS_IMPORT = /@import\s+(?:url\(\s*(['"]?)([^'"\s)]+)\1\s*\)|(['"])([^'"\r\n]+)\3)\s*([^;]*);/gi
const MEDIA = /^(?:image|audio|video|font)\/[-+.a-z0-9]+$|^application\/(?:font-woff|vnd\.ms-fontobject)$/
const SCRIPT_TYPE = /^(?:module|(?:application|text)\/(?:x-)?(?:java|ecma)script|text\/javascript1\.[0-5])$/
const executable = (node: Tree.Element): boolean => {
  const type = attr(node, 'type')?.trim().toLowerCase() ?? ''
  return attr(node, 'data-cookrew-proxy-shim') === undefined && (!type || SCRIPT_TYPE.test(type))
}

type Asset = { bytes: Uint8Array; type: string }

class PageAssets {
  private readonly pending = new Map<string, Promise<Asset | null>>()
  private readonly lanes = new Map<number, Promise<Asset | null>>()
  private bytes = 0

  constructor(private readonly card: string, private readonly origin: string, private readonly read: ReadProxyAsset) {}

  async get(path: string): Promise<Asset | null> {
    const target = proxyTargetOf(path, this.card)
    if (!target) return null
    const cached = this.pending.get(path)
    if (cached) return cached
    if (this.pending.size >= MAX_ASSETS) return null
    const lane = this.pending.size % ASSET_CONCURRENCY
    const origin = new URL(target).origin
    const task = (this.lanes.get(lane) ?? Promise.resolve()).then(() => this.load(path, origin)).catch(() => null)
    this.pending.set(path, task)
    this.lanes.set(lane, task)
    return task
  }

  private async load(path: string, origin: string): Promise<Asset | null> {
    if (this.bytes >= MAX_ASSET_BYTES) return null
    const response = await this.read(path, 'GET', { origin, omitCookies: origin !== this.origin, frameFormat: true })
    const type = mimeOf(response)
    if (!response.ok) return null
    if (type === PROXY_SVG_MIME) {
      const data: unknown = await response.json()
      if (!data || typeof data !== 'object' || !('svg' in data) || typeof data.svg !== 'string') return null
      return this.keep(Uint8Array.from(atob(data.svg), (character) => character.charCodeAt(0)), 'image/svg+xml')
    }
    if (!(MEDIA.test(type) || type === 'text/css')) return null
    return this.keep(new Uint8Array(await response.arrayBuffer()), type)
  }

  private keep(bytes: Uint8Array, type: string): Asset | null {
    if (this.bytes + bytes.length > MAX_ASSET_BYTES) return null
    this.bytes += bytes.length
    return { bytes, type }
  }

  async media(path: string): Promise<string> {
    if (/^(?:#|data:)/i.test(path)) return path
    const asset = await this.get(path)
    return asset && MEDIA.test(asset.type) ? `data:${asset.type};base64,${base64(asset.bytes)}` : ''
  }

  async css(css: string, base: string, depth = 0): Promise<string> {
    if (depth >= MAX_STYLE_DEPTH) return ''
    const imports = [...css.matchAll(CSS_IMPORT)]
    const own = await replaceMatches(css.replace(CSS_IMPORT, '/* cookrew-import */'), CSS_URL, async ([, , raw]) => {
      const path = proxyTargetOf(raw, this.card) ? raw : rewriteUrl(raw, base, this.card) ?? raw
      return `url("${await this.media(path)}")`
    })
    const styles = await Promise.all(imports.map(async ([, , raw, , quoted, condition]) => {
      const address = raw ?? quoted
      const path = proxyTargetOf(address, this.card) ? address : rewriteUrl(address, base, this.card)
      if (!path) return ''
      const asset = await this.get(path)
      if (asset?.type !== 'text/css') return ''
      const nested = await this.css(new TextDecoder().decode(asset.bytes), proxyTargetOf(path, this.card)!, depth + 1)
      return condition ? `@media ${condition} {${nested}}` : nested
    }))
    let index = 0
    return own.replace(/\/\* cookrew-import \*\//g, () => styles[index++] ?? '')
  }
}

async function replaceMatches(text: string, pattern: RegExp, replace: (match: RegExpMatchArray) => Promise<string>): Promise<string> {
  const matches = [...text.matchAll(pattern)]
  const values = await Promise.all(matches.map(replace))
  let index = 0
  return text.replace(pattern, () => values[index++])
}

async function rewriteElement(node: Tree.Element, assets: PageAssets, url: string, card: string): Promise<Tree.Element | null> {
  const { tagName: tag } = node
  if (['base', 'embed', 'object', 'iframe', 'frame', 'portal'].includes(tag)) return null
  if (tag === 'meta' && (attr(node, 'http-equiv') || attr(node, 'charset'))) return null
  if (tag === 'script') return executable(node) ? element('meta', [{ name: 'data-cookrew-needs-screen', value: '' }]) : null
  if (tag === 'link') {
    const href = attr(node, 'href') ?? ''
    if (attr(node, 'rel')?.toLowerCase() !== 'stylesheet' || attr(node, 'integrity')) return null
    const asset = await assets.get(href)
    if (asset?.type !== 'text/css') return null
    return element('style', node.attrs.filter(({ name }) => name === 'media'),
      (await assets.css(new TextDecoder().decode(asset.bytes), proxyTargetOf(href, card) ?? url)).replace(/<\/style/gi, '\\3c /style'))
  }
  if (tag === 'style') {
    const css = (await assets.css(textOf(node), url)).replace(/<\/style/gi, '\\3c /style')
    return element('style', node.attrs, css)
  }
  if (tag === 'a' || tag === 'area') {
    const href = attr(node, 'href') ?? ''
    if (proxyTargetOf(href, card)) return setAttr(setAttr(without(node, 'target', 'ping', 'download'), 'href', '#'), 'data-cookrew-proxy-link', href)
    return href.startsWith('#') ? node : without(node, 'href', 'target', 'ping')
  }
  const attrs = await Promise.all(node.attrs.filter(({ name }) => !/^on/i.test(name)).map(async (entry) => {
    if (entry.name === 'style') return { ...entry, value: await assets.css(entry.value, url) }
    if (['src', 'poster', 'data-src'].includes(entry.name)) {
      const path = proxyTargetOf(entry.value, card) || /^data:/i.test(entry.value) ? entry.value : ''
      return { ...entry, value: await assets.media(path) }
    }
    if (entry.name === 'srcset' && !entry.value.startsWith('data:')) {
      const candidates = await Promise.all(entry.value.split(',').map(async (candidate) => {
        const [path, ...rest] = candidate.trim().split(/\s+/)
        const local = await assets.media(path)
        return local ? [local, ...rest].join(' ') : ''
      }))
      return { ...entry, value: candidates.filter(Boolean).join(', ') }
    }
    return entry
  }))
  return { ...node, attrs: attrs.filter(({ name, value }) => value !== '' || !['src', 'poster'].includes(name)) }
}

/** Materialize the static page over the authenticated connection before mounting it. */
export async function proxyDocument(source: string, pageUrl: string, card: string, nonce: string, read: ReadProxyAsset): Promise<{ html: string; url: string }> {
  const doc = parse(source, { scriptingEnabled: false })
  const root = doc.childNodes.find((node): node is Tree.Element => tree.isElementNode(node) && node.tagName === 'html')!
  const declared = attr(root, 'data-cookrew-proxy-url')
  const url = (declared && proxyTargetOf(proxyPath(card, declared), card)) || pageUrl
  const assets = new PageAssets(card, new URL(url).origin, read)
  const build = async (node: Tree.ChildNode): Promise<Tree.ChildNode[]> => {
    if (!tree.isElementNode(node)) return [node]
    const rewritten = await rewriteElement(node, assets, url, card)
    if (!rewritten) return []
    const children = (await Promise.all(rewritten.childNodes.map(build))).flat()
    if (node.tagName === 'noscript') return children
    if (node.tagName !== 'head') return [{ ...rewritten, childNodes: children }]
    return [{ ...rewritten, childNodes: [
      element('meta', [{ name: 'charset', value: 'utf-8' }]),
      element('meta', [{ name: 'http-equiv', value: 'Content-Security-Policy' }, { name: 'content', value: FRAME_CSP }]),
      element('script', [], PROXY_FRAME_SCRIPT),
      ...children
    ] }]
  }
  const configured = setAttr(setAttr(setAttr(root, 'data-cookrew-proxy-card', card), 'data-cookrew-proxy-url', url), 'data-cookrew-proxy-nonce', nonce)
  const frame = await build(configured)
  return { html: serialize({ ...doc, childNodes: doc.childNodes.flatMap((node) => node === root ? frame : [node]) }), url }
}
