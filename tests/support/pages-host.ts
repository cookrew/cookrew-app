import { existsSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import { createServer as netServer, type AddressInfo } from 'node:net'
import path from 'node:path'

/**
 * A STAND-IN FOR THE CONSOLE'S STATIC HOST, for a suite that loads the built
 * console in a real browser. It does what Cloudflare Pages does with a
 * directory of files, and nothing the directory does not ask for:
 *
 *   flat files          an address that names a file is that file
 *   one page            with no 404.html beside it, every address that is no
 *                       file is answered with index.html, status 200
 *   `_headers`          every block whose pattern matches the address adds its
 *                       headers; a header two matching blocks set is joined
 *                       with a comma (which is why the build never sets
 *                       Cache-Control under `/*`)
 *   the host's default  an answer no block gave a Cache-Control is asked for
 *                       again every time
 *
 * The files starting with `_` are the host's own and are never served.
 *
 * It can be taken off the network and put back on the SAME port (`stop`,
 * `start`), and handed another directory (`deploy`): a suite needs both, to
 * see a page paint from its worker's cache and to see a newer build found.
 */

export interface PagesRequest {
  readonly path: string
  readonly status: number
  readonly at: number
}

export interface PagesHost {
  /** `http://console.localhost:<port>`: a browser resolves it to loopback and treats it as a secure context. */
  readonly origin: string
  readonly port: number
  readonly requests: readonly PagesRequest[]
  /** Serve another directory from the next request on. */
  deploy(dir: string): void
  /** Off the network: connections refused, as a host that is down. */
  stop(): Promise<void>
  /** Back on the same port. */
  start(): Promise<void>
  close(): Promise<void>
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml'
}

/** What the host sends an answer no block gave a Cache-Control. */
export const PAGES_DEFAULT_CACHE = 'public, max-age=0, must-revalidate'

export interface HeaderBlock {
  readonly pattern: string
  readonly headers: readonly (readonly [string, string])[]
}

/** `_headers` as blocks: a line that starts at the margin is a pattern, the indented lines under it its headers. */
export function parseHeadersFile(text: string): HeaderBlock[] {
  const blocks: { pattern: string; headers: [string, string][] }[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (!/^\s/.test(line)) {
      blocks.push({ pattern: line.trim(), headers: [] })
      continue
    }
    const at = line.indexOf(':')
    const block = blocks.at(-1)
    if (at === -1 || block === undefined) continue
    block.headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()])
  }
  return blocks
}

/** A pattern is an exact path; `*` in it stands for anything, slashes included. */
const matches = (pattern: string, pathname: string): boolean => {
  if (!pattern.includes('*')) return pattern === pathname
  const source = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${source}$`).test(pathname)
}

/** The headers the blocks give one address, joined the way the host joins them. */
export function headersFor(blocks: readonly HeaderBlock[], pathname: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const block of blocks) {
    if (!matches(block.pattern, pathname)) continue
    for (const [name, value] of block.headers) {
      const key = name.toLowerCase()
      out[key] = out[key] === undefined ? value : `${out[key]}, ${value}`
    }
  }
  return out
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = netServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })

export async function startPagesHost(dir: string): Promise<PagesHost> {
  let root = path.resolve(dir)
  let blocks: HeaderBlock[] = []
  const requests: PagesRequest[] = []
  const read = (): void => {
    const file = path.join(root, '_headers')
    blocks = existsSync(file) ? parseHeadersFile(readFileSync(file, 'utf8')) : []
  }
  read()

  const fileFor = (pathname: string): string | null => {
    // The host's own files are not the page's.
    if (pathname.split('/').some((segment) => segment.startsWith('_') || segment === '..')) return null
    const tries = pathname.endsWith('/') ? [path.join(root, pathname, 'index.html')] : [path.join(root, pathname), path.join(root, `${pathname}.html`), path.join(root, pathname, 'index.html')]
    return tries.find((file) => file.startsWith(root) && existsSync(file) && statSync(file).isFile()) ?? null
  }

  const answer = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    let pathname = '/'
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://host.invalid').pathname)
    } catch {
      pathname = '/'
    }
    const send = (status: number, file: string | null): void => {
      requests.push({ path: pathname, status, at: Date.now() })
      const headers = { 'cache-control': PAGES_DEFAULT_CACHE, ...headersFor(blocks, pathname) }
      if (file === null) {
        response.writeHead(status, headers)
        response.end()
        return
      }
      response.writeHead(status, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', ...headers })
      response.end(request.method === 'HEAD' ? undefined : readFileSync(file))
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(405, null)
    const file = fileFor(pathname)
    if (file !== null) return send(200, file)
    const notFound = path.join(root, '404.html')
    if (existsSync(notFound)) return send(404, notFound)
    // One page: every address that is no file is the page.
    send(200, path.join(root, 'index.html'))
  }

  const port = await freePort()
  let server: http.Server | null = null
  const start = async (): Promise<void> => {
    if (server !== null) return
    const next = http.createServer(answer)
    await new Promise<void>((resolve, reject) => {
      next.once('error', reject)
      next.listen(port, '127.0.0.1', () => resolve())
    })
    server = next
  }
  const stop = async (): Promise<void> => {
    const held = server
    server = null
    if (held === null) return
    await new Promise<void>((resolve) => {
      held.closeAllConnections()
      held.close(() => resolve())
    })
  }
  await start()

  return {
    origin: `http://console.localhost:${port}`,
    port,
    requests,
    deploy: (next) => {
      root = path.resolve(next)
      read()
    },
    stop,
    start,
    close: stop
  }
}
