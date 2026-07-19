import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { networkInterfaces } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import type { WorkspaceStore } from './store'
import type { PtyManager } from './pty'
import type { VoiceEngine } from './voice'
import type { TurnTracker } from './turn-tracker'
import { askTerminal } from './ask'
import { ensureCert } from './cert'
import { handleMobileApi, MobileApiDeps, MobileOps } from './mobile-api'
import { readJson, respondJson } from './mobile-http'

export const MOBILE_PORT = 8639
export const MOBILE_HTTPS_PORT = 8643

let httpsReady = false

export interface MobileServerDeps {
  store: WorkspaceStore
  ptys: PtyManager
  voice: VoiceEngine
  turns: TurnTracker
  ops: MobileOps
  presets: readonly { name: string; command: string }[]
  /** Persist a phone-uploaded attachment; returns its absolute path. */
  saveAttachment: (name: string, data: Buffer) => string
  /** Latest capturePage() frame for a browser, pushed from the renderer. */
  browserThumb: (browserId: string) => Buffer | undefined
  /** Legacy lightweight client (kept at /lite for voice-first use). */
  clientHtmlPath: string
  /** Built renderer bundle — the full desktop canvas UI served to phones. */
  rendererDir: string
}

/**
 * Mobile companion: a small LAN HTTP server the phone's browser connects to.
 * It serves the SAME renderer bundle as the desktop window; remote-api.ts in
 * the renderer swaps IPC for this server's HTTP/SSE endpoints, so the phone
 * gets the full canvas experience (browsers fall back to iframes — only the
 * desktop has real Chromium webviews). The pre-canvas lightweight client
 * stays available at /lite.
 */
export function startMobileServer(deps: MobileServerDeps): void {
  const requestHandler = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    void handle(request, response, deps).catch((error: Error) => {
      respondJson(response, 500, { error: error.message })
    })
  }

  // Plain HTTP: fine for the Mac's own localhost (a secure context) and as a
  // no-mic fallback on the LAN.
  listenWithRetry(http.createServer(requestHandler), MOBILE_PORT)

  // HTTPS with a self-signed cert: the only way phones on the LAN get a
  // secure context, which the Web Speech / mic APIs require.
  const cert = ensureCert(lanIps())
  if (cert) {
    const secure = https.createServer({ key: cert.key, cert: cert.cert }, requestHandler)
    secure.on('listening', () => {
      httpsReady = true
    })
    listenWithRetry(secure, MOBILE_HTTPS_PORT)
  }
}

function listenWithRetry(server: http.Server | https.Server, port: number): void {
  let retries = 0
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && retries < 10) {
      retries += 1
      setTimeout(() => server.listen(port, '0.0.0.0'), 3000)
    } else {
      console.error(`Mobile server error on :${port}:`, error)
    }
  })
  server.listen(port, '0.0.0.0')
}

function lanIps(): string[] {
  const ips: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address)
    }
  }
  return ips
}

export function mobileUrls(): string[] {
  const ips = lanIps()
  if (ips.length === 0) {
    return httpsReady
      ? [`https://localhost:${MOBILE_HTTPS_PORT}`, `http://localhost:${MOBILE_PORT}`]
      : [`http://localhost:${MOBILE_PORT}`]
  }
  // Prefer HTTPS (mic-capable) when available; keep HTTP as a fallback line.
  const scheme = httpsReady ? 'https' : 'http'
  const port = httpsReady ? MOBILE_HTTPS_PORT : MOBILE_PORT
  return ips.map((ip) => `${scheme}://${ip}:${port}`)
}

/**
 * Marker injected into the served renderer HTML: api.ts sees it and swaps
 * the IPC bridge for remote-api.ts. Also pins the viewport so browser
 * pinch-zoom doesn't fight the canvas's own pinch gesture.
 */
const REMOTE_BOOT = `<script>
window.COOKREW_MOBILE = 1
document.addEventListener('DOMContentLoaded', () => {
  document.body.classList.add('cookrew-mobile')
  const viewport = document.querySelector('meta[name="viewport"]')
  if (viewport) viewport.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
})
</script>`

const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}

/** Serve the built renderer index with the remote-mode marker injected. */
function serveRendererIndex(response: http.ServerResponse, deps: MobileServerDeps): boolean {
  const indexPath = path.join(deps.rendererDir, 'index.html')
  if (!existsSync(indexPath)) return false
  const html = readFileSync(indexPath, 'utf8').replace('<head>', `<head>${REMOTE_BOOT}`)
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(html)
  return true
}

/** Static assets of the renderer bundle, with a path-traversal guard. */
function serveRendererAsset(
  response: http.ServerResponse,
  deps: MobileServerDeps,
  pathname: string
): boolean {
  const root = path.resolve(deps.rendererDir)
  const file = path.resolve(root, '.' + pathname)
  if (!file.startsWith(root + path.sep) || !existsSync(file)) return false
  const mime = STATIC_MIME[path.extname(file).toLowerCase()]
  if (!mime) return false
  response.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' })
  response.end(readFileSync(file))
  return true
}

async function handle(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  deps: MobileServerDeps
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
  const legacyHtml = (): void => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(readFileSync(deps.clientHtmlPath, 'utf8'))
  }

  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    // Full canvas UI when a renderer build exists; legacy client otherwise
    // (dev checkouts before the first `npm run build`).
    if (!serveRendererIndex(response, deps)) legacyHtml()
    return
  }

  if (request.method === 'GET' && url.pathname === '/lite') {
    legacyHtml()
    return
  }

  // Renderer bundle + full remote API (consumed by remote-api.ts).
  if (await handleMobileApi(request, response, url, deps as MobileApiDeps)) return

  if (request.method === 'GET' && url.pathname === '/api/state') {
    const activities = Object.fromEntries(
      deps.turns.list().map((activity) => [activity.terminalId, activity])
    )
    respondJson(response, 200, {
      workspace: deps.store.state.name,
      // The full canvas — the mobile client mirrors the desktop layout, so
      // every node ships with its position/size, not just terminals.
      nodes: deps.store.state.nodes.map((node) =>
        node.kind === 'terminal' ? { ...node, running: deps.ptys.get(node.id) !== undefined } : node
      ),
      activities,
      voiceEnabled: deps.voice.enabled
    })
    return
  }

  const outputMatch = url.pathname.match(/^\/api\/terminal\/([^/]+)\/output$/)
  if (request.method === 'GET' && outputMatch) {
    const session = deps.ptys.get(outputMatch[1])
    if (!session) {
      respondJson(response, 404, { error: 'Terminal not running' })
      return
    }
    respondJson(response, 200, {
      // Full scrollback, not just the viewport — the phone's fullscreen view
      // is scrollable, so history has to travel with the payload.
      output: session.fullText(),
      busy: session.idleFor() < 2000,
      // Screen geometry so the phone can scale the full view to fit: lines
      // are at most `cols` chars, so font-size = screenWidth / cols.
      cols: session.cols,
      rows: session.rows
    })
    return
  }

  const thumbMatch = url.pathname.match(/^\/api\/browser\/([^/]+)\/thumb$/)
  if (request.method === 'GET' && thumbMatch) {
    const thumb = deps.browserThumb(thumbMatch[1])
    if (!thumb) {
      respondJson(response, 404, { error: 'No thumbnail yet' })
      return
    }
    response.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    })
    response.end(thumb)
    return
  }

  const inputMatch = url.pathname.match(/^\/api\/terminal\/([^/]+)\/(input|ask)$/)
  if (request.method === 'POST' && inputMatch) {
    const session = deps.ptys.get(inputMatch[1])
    if (!session) {
      respondJson(response, 404, { error: 'Terminal not running' })
      return
    }
    const body = await readJson<{ text?: string }>(request)
    const text = (body.text ?? '').trim()
    if (!text) {
      respondJson(response, 400, { error: 'Missing text' })
      return
    }
    if (inputMatch[2] === 'input') {
      session.write(text)
      session.write('\r')
      respondJson(response, 200, { ok: true })
    } else {
      const reply = await askTerminal(session, text, { timeoutMs: 120000 })
      respondJson(response, 200, { ok: true, reply })
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/say') {
    const body = await readJson<{ text?: string }>(request)
    await deps.voice.speak(body.text ?? '')
    respondJson(response, 200, { ok: true })
    return
  }

  // Anything else that looks like a file: try the renderer bundle's assets.
  if (request.method === 'GET' && serveRendererAsset(response, deps, url.pathname)) return

  respondJson(response, 404, { error: 'Not found' })
}
