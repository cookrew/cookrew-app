import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { MOBILE_PORT, MOBILE_HTTPS_PORT } from './mobile-ports'
import { mobileEndpoints, type MobileEndpoint } from './mobile-endpoints'
import { loadOrCreatePairingToken, rotatePairingToken } from './pairing-token'
import { readTailnet, tailnetCertHosts, type TailnetIdentity } from './tailscale'
import { existsSync, readFileSync } from 'node:fs'
import { powerSaveBlocker } from 'electron'
import type { WorkspaceStore } from './store'
import type { RecoverResult, RestoreResult } from '../shared/model'
import type { PtyManager } from './pty'
import type { VoiceEngine } from './voice'
import type { TurnTracker } from './turn-tracker'
import type { EventLog } from './event-log'
import type { AgentRegistry } from './agent-registry'
import type { TraceReader } from './trace'
import type { BoardSources } from './board-index'
import { X509Certificate } from 'node:crypto'
import { askTerminal } from './ask'
import { ensureCert, missingHosts, sansOf } from './cert'
import { enrichStateWithGit, handleMobileApi, MobileApiDeps, MobileOps } from './mobile-api'
import { readJson, respondJson } from './mobile-http'
import { fetchRendererDevResource } from './renderer-dev-proxy'

// Re-exported so existing importers keep their import path; the constants
// themselves live in an Electron-free module so pure code can use them.
export { MOBILE_PORT, MOBILE_HTTPS_PORT } from './mobile-ports'

let httpsReady = false

/**
 * The active pairing token (C1), minted per app run by startMobileServer and
 * surfaced to the phone via the `?token=` query on mobileUrls(). Null before
 * the server starts (mobileUrls then returns tokenless loopback URLs).
 */
let activePairingToken: string | null = null

/**
 * The active WALL token (TV wall, P8). Separate from the pairing token on
 * purpose: the wall URL is pasted into a Home Assistant script and lives on a
 * always-on TV, so it must be revocable and scopeable WITHOUT invalidating
 * every paired phone. Minted per run like the pairing token unless the caller
 * injects one (`deps.wallToken`).
 */
let activeWallToken: string | null = null

/** SAN list of the cert actually in use; empty until HTTPS starts. */
let certSans: string[] = []

/** Active power-save-blocker id, boxed so tests can reset it. */
const powerBlockerId: { current: number | null } = { current: null }

export interface MobileServerDeps {
  store: WorkspaceStore
  ptys: PtyManager
  voice: VoiceEngine
  turns: TurnTracker
  /** Observability event log + agent roster (mobile query endpoints). */
  events: EventLog
  agents: AgentRegistry
  traces: TraceReader
  /** Activity Board data plane; absent = /api/board answers 503. */
  board?: BoardSources
  recoverAgent: (id: string) => RecoverResult
  restoreCheckpoint: (id: string, checkpointIndex: number) => Promise<RestoreResult>
  undoRestore: (id: string) => Promise<RestoreResult>
  ops: MobileOps
  presets: readonly { name: string; command: string }[]
  /** Persist a phone-uploaded attachment; returns its absolute path. */
  saveAttachment: (name: string, data: Buffer) => string
  /** Latest legacy flag-off capturePage() frame, pushed from the renderer. */
  browserThumb: (browserId: string) => Buffer | undefined
  /** Whether browser nodes are backed by the node-owned headless runtime. */
  interactiveBrowserEnabled: () => boolean
  /**
   * A flag-off phone polled /thumb. The desktop uses this heartbeat to keep its
   * legacy webview capture fresh while hidden.
   */
  browserThumbRequested?: (browserId: string) => void
  /**
   * Override the read-only (wall) token (tests / a caller that owns token
   * lifecycle); a fresh one is minted per run otherwise.
   */
  wallToken?: string
  /** Built renderer bundle — the full desktop canvas UI served to phones. */
  rendererDir: string
  /** electron-vite renderer URL; proxied to phones in development. */
  rendererDevUrl?: string
  /** Override the pairing token (tests); a fresh one is minted per run. */
  pairingToken?: string
  /**
   * WebSocket 'upgrade' handler for the interactive-browser stream
   * (/api/browser/:id/stream). Attached to both the HTTP and HTTPS servers so
   * phones get ws:// on localhost and wss:// on the LAN.
   */
  onUpgrade?: (request: http.IncomingMessage, socket: import('node:stream').Duplex) => void
}

/**
 * Mobile companion: a small LAN HTTP server the phone's browser connects to.
 * It serves the SAME renderer bundle as the desktop window; remote-api.ts in
 * the renderer swaps IPC for this server's HTTP/SSE endpoints, so the phone
 * gets the full canvas experience. With interactive browsing enabled, browser
 * nodes render the same node-owned headless stream on phone and desktop;
 * flag-off retains the legacy certification fallback. The phone and the
 * desktop now share ONE renderer — there is no separate lightweight client.
 */
export function startMobileServer(deps: MobileServerDeps): void {
  // Phones poll this server while the Mac's display is off; without a power
  // assertion macOS App-Naps the process and idle-sleeps the system, killing
  // every mobile session. Held for the app's lifetime (the server has no stop
  // path) and cleared by process exit.
  if (!powerBlockerId.current) {
    powerBlockerId.current = powerSaveBlocker.start('prevent-app-suspension')
  }

  // C1: resolve the pairing token BEFORE any route can run — every mutating
  // route on this server requires it (see handleMobileApi's gate). The
  // fallback is the PERSISTED token: a per-run UUID silently unpaired every
  // phone on each restart, and the renderer swallowed the resulting 401s.
  activePairingToken = deps.pairingToken ?? loadOrCreatePairingToken()
  activeWallToken = deps.wallToken ?? randomUUID()

  const requestHandler = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    void handle(request, response, deps).catch((error: Error) => {
      respondJson(response, 500, { error: error.message })
    })
  }

  const attachUpgrade = (server: http.Server | https.Server): void => {
    if (deps.onUpgrade) server.on('upgrade', (request, socket) => deps.onUpgrade?.(request, socket))
  }

  // Plain HTTP: fine for the Mac's own localhost (a secure context) and as a
  // no-mic fallback on the LAN.
  const plain = http.createServer(requestHandler)
  attachUpgrade(plain)
  listenWithRetry(plain, MOBILE_PORT)

  // HTTPS with a self-signed cert: the only way phones on the LAN get a
  // secure context, which the Web Speech / mic APIs require. The tailnet
  // address and MagicDNS name go in the SAN list too — without them the one
  // endpoint that works away from home is the one the phone refuses to load.
  const tailnet = refreshTailnet()
  const tailnetHosts = tailnetCertHosts(tailnet)
  const cert = ensureCert({
    ips: [...new Set([...localAddresses(), ...tailnetHosts.ips])],
    dnsNames: tailnetHosts.dnsNames
  })
  if (cert) {
    certSans = sansOf(new X509Certificate(cert.cert).subjectAltName)
    const secure = https.createServer({ key: cert.key, cert: cert.cert }, requestHandler)
    secure.on('listening', () => {
      httpsReady = true
    })
    attachUpgrade(secure)
    listenWithRetry(secure, MOBILE_HTTPS_PORT)
  }
}

function listenWithRetry(server: http.Server | https.Server, port: number): void {
  let retries = 0
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      // Another (usually outgoing) app instance still holds the port — keep
      // trying so this instance takes over whenever it frees up. A capped
      // retry left the mobile server permanently dead after 30s of overlap,
      // with phones unable to connect until the app was relaunched.
      retries += 1
      if (retries % 10 === 1) {
        console.error(`Mobile port :${port} in use — retrying every 3s (attempt ${retries})`)
      }
      setTimeout(() => server.listen(port, '0.0.0.0'), 3000)
    } else {
      console.error(`Mobile server error on :${port}:`, error)
    }
  })
  server.listen(port, '0.0.0.0')
}

function localAddresses(): string[] {
  const ips: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address)
    }
  }
  return ips
}

/**
 * Tailscale can come up long after the app did, so the identity is re-read on
 * demand rather than pinned at startup — but not on every call: `tailscale
 * status` forks a process, and `cookrew mobile` is not the only caller.
 */
const tailnetCache: { value: TailnetIdentity | null; readAt: number } = { value: null, readAt: 0 }
const TAILNET_TTL_MS = 15_000

function refreshTailnet(): TailnetIdentity | null {
  const now = Date.now()
  if (now - tailnetCache.readAt < TAILNET_TTL_MS) return tailnetCache.value
  tailnetCache.value = readTailnet()
  tailnetCache.readAt = now
  return tailnetCache.value
}

/**
 * Every address the phone could use, classified and ordered — tailnet first,
 * then the LAN. The pairing token rides each URL as ?token= (C1): the desktop
 * shows the URL, the phone lifts the token into storage and sends it back as
 * a bearer header on mutating routes.
 */
export function mobileEndpointList(): MobileEndpoint[] {
  return mobileEndpoints({
    addresses: localAddresses(),
    tailnet: refreshTailnet(),
    secure: httpsReady,
    token: activePairingToken
  })
}

export function mobileUrls(): string[] {
  return mobileEndpointList().map((endpoint) => endpoint.url)
}

/**
 * Revoke the pairing token and adopt the new one IN THE RUNNING SERVER.
 *
 * Rotating the file alone would be worse than not rotating at all: the
 * process keeps authorizing the old token, so every device that was supposed
 * to be revoked still works, while the freshly-printed URL is rejected until
 * the next restart. The write and the swap belong together.
 */
export function rotateActivePairingToken(): string {
  activePairingToken = rotatePairingToken()
  return activePairingToken
}

/**
 * Hosts the running HTTPS cert does NOT cover. Non-empty means those endpoints
 * fail with a name mismatch the user cannot wave away — worth saying out loud
 * rather than letting them debug it on a phone. Empty when HTTPS is off (the
 * cert is then irrelevant) or when the cert covers everything.
 */
export function uncoveredCertHosts(): string[] {
  if (!httpsReady || certSans.length === 0) return []
  return missingHosts(certSans, {
    ips: mobileEndpointList().map((endpoint) => endpoint.host),
    dnsNames: []
  })
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
  if (viewport) viewport.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, interactive-widget=resizes-content')
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
  // no-cache: assets are hash-named, but a cached index.html would keep
  // phones pinned to a stale bundle across app updates.
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
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

/** Serve the current Vite renderer through the phone's companion origin. */
async function serveRendererDev(
  response: http.ServerResponse,
  deps: MobileServerDeps,
  url: URL,
  injectRemoteBoot = false
): Promise<boolean> {
  if (!deps.rendererDevUrl) return false
  const resource = await fetchRendererDevResource(
    deps.rendererDevUrl,
    url.pathname,
    url.search
  )
  if (!resource) return false
  const body = injectRemoteBoot
    ? Buffer.from(resource.body.toString('utf8').replace('<head>', `<head>${REMOTE_BOOT}`))
    : resource.body
  response.writeHead(200, {
    'content-type': resource.contentType,
    'cache-control': 'no-cache'
  })
  response.end(body)
  return true
}

async function handle(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  deps: MobileServerDeps
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
  /**
   * The renderer bundle is the phone client. When it is missing, say so
   * plainly rather than serving something else that looks like the app — a
   * silent fallback to a different UI is how /lite survived long after
   * anything pointed at it.
   */
  const rendererMissing = (): void => {
    response.writeHead(503, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Cookrew — not built</title>' +
        '<body style="font:16px/1.6 -apple-system,sans-serif;padding:32px;background:#faf8f4;color:#2d2a20">' +
        '<h1 style="font-size:18px">Renderer not built</h1>' +
        '<p>The phone client is the renderer bundle. Run <code>npm run build</code> ' +
        '(or start the dev server) and reload.</p>'
    )
  }

  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    // Dev uses Vite's current transforms; packaged/preview builds use out/.
    if (await serveRendererDev(response, deps, url, true)) return
    if (!serveRendererIndex(response, deps)) rendererMissing()
    return
  }


  if (request.method === 'GET' && url.pathname === '/api/browser/capabilities') {
    respondJson(response, 200, { interactive: deps.interactiveBrowserEnabled() })
    return
  }

  // Renderer bundle + full remote API (consumed by remote-api.ts).
  // Hand the API the RESOLVED credentials, not the caller's optional ones.
  //
  // handleMobileApi's C1 gate reads `deps.pairingToken` and, by design, lets
  // everything through when it is absent (the loopback-embedder escape, pinned
  // in tests/mobile-auth.test.ts). index.ts simply never passed one — so this
  // 0.0.0.0 listener selected that escape and every mutating route (terminal
  // input, workspace switch, recover, restore, uploads) was open on the LAN.
  //
  // startMobileServer always mints a token, so injecting it here means the gate
  // can no longer be disabled by a caller forgetting a field. The escape now
  // requires deliberately constructing MobileApiDeps without one, which only an
  // in-process embedder can do.
  const authed = {
    ...deps,
    pairingToken: activePairingToken ?? deps.pairingToken,
    wallToken: activeWallToken ?? deps.wallToken
  }
  if (await handleMobileApi(request, response, url, authed as MobileApiDeps)) return

  if (request.method === 'GET' && url.pathname === '/api/state') {
    const activities = Object.fromEntries(
      deps.turns.list().map((activity) => [activity.terminalId, activity])
    )
    // Git-enriched like /api/workspace (same coalescing cache), so the lite
    // client's git chips light up too — terminals carry node.git.
    const enriched = await enrichStateWithGit(deps.store.state, deps.ops.gitInfo)
    respondJson(response, 200, {
      workspace: enriched.name,
      // The full canvas — the mobile client mirrors the desktop layout, so
      // every node ships with its position/size, not just terminals.
      nodes: enriched.nodes.map((node) =>
        node.kind === 'terminal' ? { ...node, running: deps.ptys.get(node.id) !== undefined } : node
      ),
      dirsGit: enriched.dirsGit,
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
      // ASKED, not inferred, when the multiplexer models agents: herdr
      // reports working/idle directly, and 2s of silence mid tool-call is
      // not idleness. The heuristic stays for backends that cannot say.
      busy: agentStatus(session.sessionName) === 'working' || session.idleFor() < 2000,
      // Screen geometry so the phone can scale the full view to fit: lines
      // are at most `cols` chars, so font-size = screenWidth / cols.
      cols: session.cols,
      rows: session.rows
    })
    return
  }

  const thumbMatch = url.pathname.match(/^\/api\/browser\/([^/]+)\/thumb$/)
  if (request.method === 'GET' && thumbMatch) {
    // Heartbeat first — even a 404 (no frame yet) means a phone is watching,
    // which is exactly when the desktop must (re)start capturing this browser.
    deps.browserThumbRequested?.(thumbMatch[1])
    const thumb = deps.browserThumb(thumbMatch[1])
    if (!thumb) {
      respondJson(response, 404, { error: 'No thumbnail yet' })
      return
    }
    response.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'no-store'
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

  // Dev module graph first, then packaged renderer assets.
  if (request.method === 'GET' && (await serveRendererDev(response, deps, url))) return
  if (request.method === 'GET' && serveRendererAsset(response, deps, url.pathname)) return

  respondJson(response, 404, { error: 'Not found' })
}
