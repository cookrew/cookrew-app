import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import type net from 'node:net'
import path from 'node:path'
import type { BrowserNodeData, GitInfo, NoteNodeData, TerminalNodeData, WorkspaceState } from '../../src/shared/model'

/**
 * A FIXTURE COMPANION: what a phone's boot talks to, without the app.
 *
 * It serves the BUILT renderer (out/renderer) exactly as mobile-server does —
 * the index with the remote boot marker injected, the hashed assets — and
 * answers every API route the boot asks for from a canvas shaped like the
 * owner's (32 terminals with git embedded, 51 notes, 93 browsers). What it
 * records is every request path, which is the whole point: the gate counts
 * them. Nothing here times anything.
 */

export interface FixtureRequest {
  readonly path: string
  readonly at: number
}

export interface FixtureCompanion {
  readonly origin: string
  readonly requests: readonly FixtureRequest[]
  close(): Promise<void>
}

const GIT: GitInfo = {
  isRepo: true,
  root: '/tmp/fixture',
  branch: 'main',
  dirty: false,
  ahead: 0,
  behind: 0
} as unknown as GitInfo

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

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
}

/** The marker mobile-server injects (remoteBoot), minus the viewport tweak. */
const BOOT = `<script>
window.COOKREW_SLUG = ""
window.COOKREW_BASE = ""
window.COOKREW_MOBILE = 1
document.addEventListener('DOMContentLoaded', () => { document.body.classList.add('cookrew-mobile') })
</script>`

const json = (response: http.ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** The built renderer under test; COOKREW_RENDERER_DIR points the gate at another build. */
export function rendererDir(): string {
  return process.env.COOKREW_RENDERER_DIR ?? path.resolve(__dirname, '../../out/renderer')
}

export function builtRendererPresent(): boolean {
  return existsSync(path.join(rendererDir(), 'index.html'))
}

export async function startFixtureCompanion(): Promise<FixtureCompanion> {
  const root = rendererDir()
  const state = fixtureWorkspace()
  const requests: FixtureRequest[] = []
  const workspaces = { workspaces: [{ id: 'w1', name: 'Fixture', dir: '/tmp/fixture', dirs: ['/tmp/fixture'], icon: '🍳' }], activeId: 'w1' }
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.local')
    requests.push({ path: `${url.pathname}${url.search}`, at: Date.now() })
    const p = url.pathname
    if (p === '/' || p === '/index.html') {
      const html = readFileSync(path.join(root, 'index.html'), 'utf8').replace('<head>', `<head>${BOOT}`)
      response.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' })
      response.end(html)
      return
    }
    if (p.startsWith('/assets/')) {
      const file = path.resolve(root, `.${p}`)
      if (file.startsWith(root) && existsSync(file)) {
        response.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
        response.end(readFileSync(file))
        return
      }
    }
    if (p === '/api/auth/status') return json(response, 200, { scope: 'pairing', required: true })
    if (p === '/api/workspace') return json(response, 200, state)
    if (p === '/api/workspaces') return json(response, 200, workspaces)
    if (p === '/api/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      response.write(':ok\n\n')
      if (url.searchParams.get('boot') !== 'pull') {
        response.write(`event: workspace\ndata: ${JSON.stringify(state)}\n\n`)
      }
      response.write(`event: workspaces\ndata: ${JSON.stringify(workspaces)}\n\n`)
      const heartbeat = setInterval(() => response.write(':hb\n\n'), 5000)
      request.on('close', () => clearInterval(heartbeat))
      return
    }
    if (p === '/api/activity' || p === '/api/presets' || p === '/api/roles' || p === '/api/teams') return json(response, 200, [])
    if (p === '/api/account') return json(response, 404, { error: 'no account on this desktop' })
    if (p === '/api/browser/capabilities') return json(response, 200, { interactive: false })
    if (p === '/api/git') return json(response, 200, GIT)
    if (p === '/api/browser/thumbs') return json(response, 200, { frames: [] })
    if (/^\/api\/browser\/[^/]+\/thumb$/.test(p)) return json(response, 404, { error: 'No thumbnail yet' })
    if (/^\/api\/terminal\/[^/]+\/stream\/open$/.test(p)) return json(response, 200, { blocks: [], total: 0, missing: [], tail: null })
    if (request.method === 'POST' && p === '/api/beacon') {
      response.writeHead(204)
      response.end()
      return
    }
    json(response, 404, { error: `fixture has no ${p}` })
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
