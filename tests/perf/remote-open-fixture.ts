import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import type net from 'node:net'
import path from 'node:path'
import type { BrowserNodeData, GitInfo, NoteNodeData, TerminalNodeData, WorkspaceState } from '../../src/shared/model'
import { GIT, WORKSPACES, answerJson, fleetSnapshot } from './remote-open-answers'

/**
 * A FIXTURE COMPANION: what a phone's boot talks to, without the app.
 *
 * It serves the BUILT renderer (out/renderer) as mobile-server does — the
 * index with the remote boot marker injected, every other file of the bundle
 * (hashed assets immutable, the web-root icons and manifest no-cache) — and
 * answers every API route the boot asks for from a canvas shaped like the
 * owner's (32 terminals with git embedded, 51 notes, 93 browsers), in the
 * shapes the real handlers send (remote-open-answers.ts). Both streams are
 * real SSE: /api/events as before, /api/fleet/stream opening on the snapshot
 * the real fleet builder makes for this canvas.
 *
 * What it records is every request, which is the whole point: the gate counts
 * them. A request it has no answer for is recorded as `known: false`, so a
 * route the boot grew is a failure to model, not a quiet 404 that changes
 * what the boot does next. Nothing here times anything.
 */

export interface FixtureRequest {
  readonly method: string
  readonly path: string
  readonly at: number
  /** The status the fixture answered with; null while it has not answered. */
  readonly status: number | null
  /** False when no route here answers it: the fixture fell through to a 404. */
  readonly known: boolean
  /** When its connection closed; null while it is still open (a held stream). */
  readonly closedAt: number | null
}

export interface FixtureCompanion {
  readonly origin: string
  readonly requests: readonly FixtureRequest[]
  close(): Promise<void>
}

/** The owner's canvas in shape: three bands, so the overview fit sees them all. */
export function fixtureWorkspace(
  counts = { terminals: 32, notes: 51, browsers: 93 }
): WorkspaceState & { dirsGit: Record<string, GitInfo> } {
  const terminals: TerminalNodeData[] = Array.from({ length: counts.terminals }, (_, i) => ({
    kind: 'terminal',
    id: `t${i}`,
    name: `Agent ${i}`,
    preset: 'Claude',
    command: 'claude',
    cwd: '/tmp/fixture',
    orch: i === 0,
    role: null,
    git: GIT,
    position: { x: (i % 8) * 460, y: Math.floor(i / 8) * 340 },
    size: { width: 420, height: 300 }
  }))
  const notes: NoteNodeData[] = Array.from({ length: counts.notes }, (_, i) => ({
    kind: 'note',
    id: `n${i}`,
    name: `Note ${i}`,
    customName: null,
    content: `# Note ${i}\n\n${'lorem ipsum '.repeat(120)}`,
    locked: false,
    position: { x: (i % 9) * 400, y: 1600 + Math.floor(i / 9) * 320 },
    size: { width: 360, height: 280 }
  }))
  const browsers: BrowserNodeData[] = Array.from({ length: counts.browsers }, (_, i) => ({
    kind: 'browser',
    id: `b${i}`,
    name: `Browser ${i}`,
    url: `https://example.invalid/${i}`,
    position: { x: (i % 12) * 380, y: 3600 + Math.floor(i / 12) * 300 },
    size: { width: 340, height: 260 }
  }))
  return {
    name: 'Fixture',
    dir: '/tmp/fixture',
    dirs: ['/tmp/fixture'],
    nodes: [...terminals, ...notes, ...browsers],
    connections: [],
    dirsGit: { '/tmp/fixture': GIT }
  }
}

/** mobile-server.ts · STATIC_MIME, the types it serves a bundle file as. */
const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}

/** The marker mobile-server injects (remoteBoot), minus the viewport tweak. */
const BOOT = `<script>
window.COOKREW_SLUG = ""
window.COOKREW_MOBILE = 1
document.addEventListener('DOMContentLoaded', () => { document.body.classList.add('cookrew-mobile') })
</script>`

/** The built renderer under test; COOKREW_RENDERER_DIR points the gate at another build. */
export function rendererDir(): string {
  return process.env.COOKREW_RENDERER_DIR ?? path.resolve(__dirname, '../../out/renderer')
}

export function builtRendererPresent(): boolean {
  return existsSync(path.join(rendererDir(), 'index.html'))
}

/** mobile-server.ts · serveRendererAsset: any non-page file of the bundle, never outside it. */
function serveBundleFile(root: string, pathname: string, response: http.ServerResponse): boolean {
  const file = path.resolve(root, `.${pathname}`)
  const mime = MIME[path.extname(file).toLowerCase()]
  if (!mime || !file.startsWith(root + path.sep) || !existsSync(file)) return false
  const immutable = pathname.startsWith('/assets/')
  response.writeHead(200, { 'content-type': mime, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' })
  response.end(readFileSync(file))
  return true
}

/** An SSE response held open, with a heartbeat, until the page lets go. */
function openSse(request: http.IncomingMessage, response: http.ServerResponse, frames: string[], heartbeat: string, everyMs: number): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  for (const frame of frames) response.write(frame)
  const timer = setInterval(() => response.write(heartbeat), everyMs)
  request.on('close', () => clearInterval(timer))
}

export async function startFixtureCompanion(): Promise<FixtureCompanion> {
  const root = path.resolve(rendererDir())
  const state = fixtureWorkspace()
  const fleet = `data: ${JSON.stringify({ type: 'snapshot', snapshot: fleetSnapshot(state) })}\n\n`
  const requests: FixtureRequest[] = []
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.local')
    const method = request.method ?? 'GET'
    const at = requests.length
    requests.push({ method, path: `${url.pathname}${url.search}`, at: Date.now(), status: null, known: true, closedAt: null })
    response.on('close', () => {
      requests[at] = { ...requests[at], closedAt: Date.now() }
    })
    const writeHead = response.writeHead.bind(response)
    response.writeHead = ((status: number, ...rest: unknown[]) => {
      requests[at] = { ...requests[at], status }
      return (writeHead as (...a: unknown[]) => http.ServerResponse)(status, ...rest)
    }) as typeof response.writeHead
    const p = url.pathname
    if (method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = readFileSync(path.join(root, 'index.html'), 'utf8').replace('<head>', `<head>${BOOT}`)
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(html)
      return
    }
    if (method === 'GET' && !p.startsWith('/api/') && serveBundleFile(root, p, response)) return
    if (method === 'GET' && p === '/api/events') {
      // A boot nonce skips the opening snapshot (the companion spends it once).
      const opening = url.searchParams.get('boot') ? [] : [`event: workspace\ndata: ${JSON.stringify(state)}\n\n`]
      openSse(request, response, [':ok\n\n', ...opening, `event: workspaces\ndata: ${JSON.stringify(WORKSPACES)}\n\n`], ':hb\n\n', 5000)
      return
    }
    // fleet/routes.ts · openStream: unnamed data frames, the snapshot first.
    if (method === 'GET' && p === '/api/fleet/stream') {
      openSse(request, response, [fleet], ':\n\n', 15_000)
      return
    }
    const answer = answerJson(method, url, state)
    if (answer) {
      response.writeHead(answer.status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(answer.body === null ? undefined : JSON.stringify(answer.body))
      return
    }
    requests[at] = { ...requests[at], known: false }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: `fixture has no ${method} ${p}` }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
