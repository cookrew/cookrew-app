import http from 'node:http'
import https from 'node:https'
import type net from 'node:net'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { MOBILE_PORT, MOBILE_HTTPS_PORT } from './mobile-ports'
import {
  nodeIdOfRoute,
  nodeInScope,
  resolveScopedRoute,
  scopedRouteSupported
} from './mobile-slug-route'
import { agentStatus } from './herdr-agent-status'
import { endpointCertHosts, mobileEndpoints, type MobileEndpoint } from './mobile-endpoints'
import { loadOrCreatePairingToken, rotatePairingToken } from './pairing-token'
import type { VersionPinRecord } from '../shared/version-pin'
import { readTailnet, type CertHosts, type TailnetIdentity } from './tailscale'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { powerSaveBlocker } from 'electron'
import type { WorkspaceStore } from './store'
import type { RecoverResult, RestoreResult, WorkspaceState } from '../shared/model'
import type { PtyManager } from './pty'
import type { VoiceEngine } from './voice'
import type { TurnTracker } from './turn-tracker'
import type { EventLog } from './event-log'
import type { AgentRegistry } from './agent-registry'
import type { TraceReader } from './trace'
import type { BoardSources } from './board-index'
import type { DispatchService } from './dispatch'
import type { ThumbFrame } from './browser-thumb-cache'
import { X509Certificate } from 'node:crypto'
import { askTerminal, ownerSubmit } from './ask'
import {
  DeliveryError,
  deliverAndConfirm,
  replyText,
  terminalDeliveryDeps
} from './ask-delivery'
import { ASK_HTTP_STATUS, ASK_REMEDY } from '../shared/ask-outcome'
import { ensureCert, missingHosts, sansOf } from './cert'
import { enrichStateWithGit, handleMobileApi, MobileApiDeps, MobileOps } from './mobile-api'
import { readJson, respondJson } from './mobile-http'
import { handleCallRoutes, type CallEndpointDeps } from './call-endpoints'
import { createTlsPortGate, httpsRedirectTarget } from './tls-port-gate'
import { sendBody } from './http-compress'
import { rendererSourceFor, staleBuildNotice } from './renderer-choice'
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
  /** Attach-free dispatch engine (v4 §3); absent = the routes answer 503. */
  dispatch?: DispatchService
  /**
   * TurnTracker.hasArmedDispatch, threaded to handleMobileApi: the /input
   * and /ask producers refuse 409 while a dispatch stamp is armed on the
   * terminal, so HTTP producers are serialized against in-flight dispatches.
   */
  hasArmedDispatch?: (terminalId: string) => boolean
  acquireTerminalView?: (terminalId: string) => boolean
  releaseTerminalView?: (terminalId: string) => void
  subscribeTerminal?: (terminalId: string) => void
  unsubscribeTerminal?: (terminalId: string) => void
  /**
   * Answer a request whose slug names a SERVED CREW rather than a live
   * workspace (share-on-save). Returns true when the route was handled;
   * false falls through to the 404. Absent = nothing is served.
   */
  servedSlug?: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    slug: string
  ) => Promise<boolean>
  /** Version pins (§10) for the rail's third marker class; absent = []. */
  listPins?: (terminalId: string) => readonly VersionPinRecord[]
  recoverAgent: (id: string) => RecoverResult
  restoreCheckpoint: (id: string, checkpointIndex: number) => Promise<RestoreResult>
  undoRestore: (id: string) => Promise<RestoreResult>
  ops: MobileOps
  presets: readonly { name: string; command: string }[]
  /** Persist a phone-uploaded attachment; returns its absolute path. */
  saveAttachment: (name: string, data: Buffer) => string
  /** Latest card frame for a browser, whichever owner produced it. */
  browserThumb: (browserId: string) => ThumbFrame | undefined
  /** Whether browser nodes are backed by the node-owned headless runtime. */
  interactiveBrowserEnabled: () => boolean
  /**
   * Whether workspace sessions are multi-instance. Gates slug routing: off,
   * /<slug>/... is not a route and every path keeps its existing meaning.
   */
  multiInstance: () => boolean
  /**
   * The internet gate (§9 · ④). ABSENT means no agent in this app is callable
   * over the internet and the routes do not exist — a 404, not a 501, because
   * "nothing is exported" is a true statement about this app rather than a
   * missing implementation. Nothing else in this server consults it, and it
   * consults nothing else in this server.
   */
  calls?: CallEndpointDeps
  /**
   * A phone polled /thumb. Awaited, because with headless browsers this is
   * what TAKES the picture (the desktop renderer no longer owns the page);
   * with legacy webviews it just relays the keep-capturing heartbeat.
   */
  browserThumbRequested?: (browserId: string) => void | Promise<void>
  /**
   * Override the read-only (wall) token (tests / a caller that owns token
   * lifecycle); a fresh one is minted per run otherwise.
   */
  wallToken?: string
  /** Built renderer bundle — the full desktop canvas UI served to phones. */
  rendererDir: string
  /** electron-vite renderer URL; proxied to phones in development. */
  rendererDevUrl?: string
  /**
   * Renderer sources, used only to date the built bundle against them so a
   * phone served the build can be told it is behind. Absent = no notice.
   */
  rendererSrcDir?: string
  /** Override the pairing token (tests); a fresh one is minted per run. */
  pairingToken?: string
  /**
   * WebSocket 'upgrade' handler for the interactive-browser stream
   * (/api/browser/:id/stream). Attached to both the HTTP and HTTPS servers so
   * phones get ws:// on localhost and wss:// on the LAN.
   */
  onUpgrade?: (request: http.IncomingMessage, socket: import('node:stream').Duplex) => void
  /**
   * Version pins for one terminal.
   *
   * NOT PART OF THE PAYMENT WORK — index.ts already passed this and the type
   * never declared it, so `npm run typecheck` was red on the base commit for
   * everyone (TS2353 plus an implicit-any on the parameter it could not infer).
   * Declared here rather than routed around, because gate A7 is a clean
   * typecheck and a red baseline makes every later break invisible.
   */
  listPins?: (terminalId: string) => import('../shared/version-pin').VersionPinRecord[]
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
  const cert = ensureCert(advertisedCertHosts())
  if (cert) {
    certSans = sansOf(new X509Certificate(cert.cert).subjectAltName)
    const secure = https.createServer({ key: cert.key, cert: cert.cert }, requestHandler)
    attachUpgrade(secure)
    // The TLS server does not bind the port itself — the gate does, and hands
    // it the connections that are actually TLS. See tls-port-gate.ts: a phone
    // that types the URL without `https://` otherwise gets a blank page and
    // zero bytes back, which is indistinguishable from the app being down.
    const gate = createTlsPortGate({ secure, plain: httpsRedirector() })
    gate.on('listening', () => {
      httpsReady = true
    })
    listenWithRetry(gate, MOBILE_HTTPS_PORT)
    watchTailnetCert(secure)
  }
}

/**
 * Answers plaintext requests on the TLS port with a redirect to the same URL
 * over https — including the `?token=` the pairing URL carries, so a mistyped
 * scheme costs a round trip rather than a re-pair.
 */
function httpsRedirector(): http.Server {
  return http.createServer((request, response) => {
    const location = httpsRedirectTarget({
      hostHeader: request.headers.host,
      target: request.url,
      localAddress: request.socket.localAddress,
      advertisedHosts: mobileEndpointList().map((endpoint) => endpoint.host),
      port: MOBILE_HTTPS_PORT
    })
    if (!location) {
      respondJson(response, 400, { error: 'This port speaks HTTPS — reconnect with https://' })
      return
    }
    // Temporary and uncached: this is a courtesy for a mistyped scheme, not a
    // fact about the port that a browser should remember.
    response.writeHead(307, { location, 'cache-control': 'no-store' })
    response.end()
  })
}

/**
 * Every host we hand out, as a cert requirement. One source for both, so the
 * cert can never fail to cover a URL the desktop just printed.
 */
function advertisedCertHosts(): CertHosts {
  return endpointCertHosts(
    mobileEndpoints({
      addresses: localAddresses(),
      tailnet: refreshTailnet(),
      // Neither affects which HOSTS are advertised, only how they are spelled.
      secure: false,
      token: null
    })
  )
}

/**
 * How often to ask whether the tailnet has appeared. Tailscale is a launch
 * agent and routinely finishes coming up after the app does; a minute is far
 * below the "pick up the phone and it fails" timescale and costs one short
 * `tailscale status` fork.
 */
const TAILNET_WATCH_MS = 60_000

/**
 * Re-issue the cert IN PLACE when the tailnet turns up after startup.
 *
 * The old code read Tailscale exactly once, at boot. Start Cookrew before
 * Tailscale finishes connecting — the ordinary case, since both are launch
 * agents — and the cert had no tailnet SAN for the rest of the run, while the
 * URL list (which re-reads on a 15s TTL) cheerfully advertised the tailnet
 * address anyway. The phone got a name mismatch on the only endpoint that
 * works off the LAN, and Wi-Fi looked like the only thing that ever worked.
 *
 * `setSecureContext` swaps the cert on the RUNNING listener: new handshakes
 * get the new cert and every open SSE stream survives, so a phone that is
 * already connected is not knocked off to fix one that is not yet.
 */
function watchTailnetCert(secure: https.Server): void {
  const timer = setInterval(() => {
    // Past the TTL deliberately: this IS the poll for "has Tailscale come up".
    tailnetCache.readAt = 0
    const hosts = advertisedCertHosts()
    const missing = missingHosts(certSans, hosts)
    if (missing.length === 0) return
    const reissued = ensureCert(hosts)
    if (!reissued) return
    certSans = sansOf(new X509Certificate(reissued.cert).subjectAltName)
    secure.setSecureContext({ key: reissued.key, cert: reissued.cert })
    console.error(`Mobile cert reissued for ${missing.join(', ')} — no restart needed`)
  }, TAILNET_WATCH_MS)
  timer.unref()
}

/**
 * Bind both address families with one socket. `::` with ipv6Only off accepts
 * IPv4 as well (as ::ffff:… mapped peers), and nothing here reads the peer
 * address, so the mapping is invisible to every route.
 *
 * `0.0.0.0` alone was IPv4-only, which made the tailnet IPv6 URL — advertised
 * by mobileEndpoints and covered by the cert — answer ECONNREFUSED. That is
 * the worst kind of endpoint: printed, trusted, and dead. It matters most on
 * exactly the network the user is complaining about, since a phone on a
 * v6-only carrier reaches the v6 address first.
 */
function listenWithRetry(server: net.Server, port: number): void {
  let retries = 0
  let dualStack = true
  const bind = (): void => {
    if (dualStack) server.listen({ port, host: '::', ipv6Only: false })
    else server.listen({ port, host: '0.0.0.0' })
  }
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
      setTimeout(bind, 3000)
    } else if (dualStack) {
      // A host with IPv6 disabled outright. Fall back rather than leaving the
      // companion unreachable on both families.
      dualStack = false
      console.error(`Mobile port :${port} could not bind IPv6 (${error.code}) — IPv4 only`)
      bind()
    } else {
      console.error(`Mobile server error on :${port}:`, error)
    }
  })
  bind()
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
/**
 * Boot script injected into the renderer index served to phones.
 *
 * `slug` is the workspace this client is FOR (marketplace §11 step 3). The
 * bundle issues root-absolute /api/... requests, so without it a client loaded
 * at /playground would read and write the FOCUSED canvas under a URL naming a
 * different workspace — which is why / and /index.html were refused under a
 * slug until this existed. remote-api.ts prefixes every request with it.
 *
 * Encoded, not interpolated raw: a slug reaches this from a URL path, and a
 * value containing `</script>` would break out of the tag. JSON.stringify
 * alone is NOT enough — it escapes quotes and backslashes but leaves `<` and
 * `/` untouched, so the closing tag survives it. `<` is escaped to \u003c as
 * well, which no JS parser cares about and no HTML parser can mistake for a
 * tag.
 *
 * The route splitter already allow-lists the minted slug shape, so this is the
 * second of two locks rather than the only one — but a lock that only works
 * because of the other lock is not a second lock.
 */
export const remoteBoot = (slug: string | null): string => `<script>
window.COOKREW_SLUG = ${JSON.stringify(slug ?? '').replace(/</g, '\\u003c')}
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

/**
 * A banner the phone can read, drawn before any script runs.
 *
 * The build served to a tailnet peer may be older than the source. Saying so
 * on the DESKTOP would be useless — the person looking at the stale UI is
 * holding a phone. It sits above the app and is dismissible.
 */
function staleBanner(notice: string | null): string {
  if (!notice) return ''
  return (
    '<div id="cookrew-stale" style="position:fixed;inset:0 0 auto 0;z-index:99999;' +
    'background:#4a3a12;color:#f5e6c8;font:12px/1.5 -apple-system,sans-serif;' +
    'padding:8px 12px" onclick="this.remove()">' +
    notice.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;')) +
    '</div>'
  )
}

/** Newest mtime under a directory tree, or null when it cannot be read. */
function newestMtime(dir: string, depth = 4): Date | null {
  let newest: Date | null = null
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name)
      const at = entry.isDirectory()
        ? depth > 0
          ? newestMtime(child, depth - 1)
          : null
        : statSync(child).mtime
      if (at && (!newest || at > newest)) newest = at
    }
  } catch {
    return newest
  }
  return newest
}

/** Whether the built bundle exists, and how far behind the source it is. */
function builtRenderer(deps: MobileServerDeps): { index: string; notice: string | null } | null {
  const index = path.join(deps.rendererDir, 'index.html')
  if (!existsSync(index)) return null
  // Only meaningful while a dev server is running; a packaged app has no
  // source tree to be behind.
  const notice = deps.rendererDevUrl
    ? staleBuildNotice(statSync(index).mtime, newestMtime(deps.rendererSrcDir ?? ''))
    : null
  return { index, notice }
}

/** Serve the built renderer index with the remote-mode marker injected. */
function serveRendererIndex(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  deps: MobileServerDeps,
  slug: string | null
): boolean {
  const built = builtRenderer(deps)
  if (!built) return false
  const html = readFileSync(built.index, 'utf8').replace(
    '<head>',
    `<head>${remoteBoot(slug)}${staleBanner(built.notice)}`
  )
  // no-cache: assets are hash-named, but a cached index.html would keep
  // phones pinned to a stale bundle across app updates.
  sendBody(
    response,
    200,
    { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    Buffer.from(html),
    request.headers['accept-encoding']
  )
  return true
}

/** Static assets of the renderer bundle, with a path-traversal guard. */
function serveRendererAsset(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  deps: MobileServerDeps,
  pathname: string
): boolean {
  const root = path.resolve(deps.rendererDir)
  const file = path.resolve(root, '.' + pathname)
  if (!file.startsWith(root + path.sep) || !existsSync(file)) return false
  const mime = STATIC_MIME[path.extname(file).toLowerCase()]
  if (!mime) return false
  // Bundle assets carry a content hash in the name, so the answer can never
  // change under that URL — let the phone keep it instead of re-fetching a
  // megabyte of JavaScript over a relay on every reload.
  const immutable = pathname.startsWith('/assets/')
  sendBody(
    response,
    200,
    {
      'content-type': mime,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
    },
    readFileSync(file),
    request.headers['accept-encoding'],
    // Safe to cache the compressed copy only because the name IS the content
    // hash — brotli on the 1.6 MB bundle costs 25 ms of main-process time,
    // which is a visible stall if it happens per request.
    immutable ? { cacheKey: pathname } : {}
  )
  return true
}

/** Serve the current Vite renderer through the phone's companion origin. */
async function serveRendererDev(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  deps: MobileServerDeps,
  url: URL,
  injectRemoteBoot = false,
  slug: string | null = null
): Promise<boolean> {
  if (!deps.rendererDevUrl) return false
  const resource = await fetchRendererDevResource(
    deps.rendererDevUrl,
    url.pathname,
    url.search
  )
  if (!resource) return false
  const body = injectRemoteBoot
    ? Buffer.from(resource.body.toString('utf8').replace('<head>', `<head>${remoteBoot(slug)}`))
    : resource.body
  sendBody(
    response,
    200,
    { 'content-type': resource.contentType, 'cache-control': 'no-cache' },
    body,
    request.headers['accept-encoding']
  )
  return true
}

/**
 * Where THIS client's renderer comes from. A tailnet peer gets the build; the
 * LAN and loopback keep Vite's live graph. See renderer-choice.ts — the whole
 * reason is that 159 dependent requests do not survive a DERP relay.
 */
function rendererSource(request: http.IncomingMessage, deps: MobileServerDeps): 'dev' | 'built' {
  return rendererSourceFor({
    remoteAddress: request.socket.remoteAddress,
    devAvailable: !!deps.rendererDevUrl,
    builtAvailable: existsSync(path.join(deps.rendererDir, 'index.html'))
  })
}

async function handle(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  deps: MobileServerDeps
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`)

  // Step 3: /<slug>/... addresses ONE workspace session. The path is rewritten
  // to what the existing handlers expect, and `scope` carries which session
  // they are answering for. Unslugged paths keep their meaning exactly — bound
  // to the focused session — because every paired phone has a bookmark to /.
  //
  // An unknown slug is 404, never a fall back to focus: silently serving a
  // different workspace than the URL names is the confusion slugs exist to end.
  //
  // GATED. Flag off, a slug is not a route at all and the path is served
  // exactly as it always was — the whole surface, unchanged, for every paired
  // phone. Flag on, a slug scopes the request to one workspace session.
  const route = deps.multiInstance()
    ? resolveScopedRoute(url.pathname, (slug) => deps.store.bySlug(slug)?.id)
    : ({ kind: 'unscoped', pathname: url.pathname } as const)
  if (route.kind === 'unknown-slug') {
    // A slug no live workspace holds may name a SERVED CREW (share-on-save):
    // the one place a stranger's sign-in, 402 and ask are answered. The
    // adapter owns its own gate; a live workspace always wins the slug above,
    // so a served crew can never shadow the owner's own canvas.
    if (deps.servedSlug && (await deps.servedSlug(request, response, url, route.slug))) return
    respondJson(response, 404, { error: `No workspace at /${route.slug}` })
    return
  }
  const scope = route.kind === 'scoped' ? route.workspaceId : null
  /** The slug this client was loaded at; '' at the unslugged root. */
  const servedSlug = route.kind === 'scoped' ? route.slug : null
  url.pathname = route.pathname

  if (scope !== null) {
    // FAIL CLOSED. Most of mobile-api still answers for the focused session
    // whatever the path says, so a slug may only reach the routes proven to
    // honour it. A wrong answer that looks right is worse than a refusal the
    // caller can see — see scopedRouteSupported.
    if (!scopedRouteSupported(url.pathname)) {
      respondJson(response, 501, {
        error: 'This route is not workspace-scoped yet — use the unslugged path',
        route: url.pathname
      })
      return
    }
    // One check for every scoped node route, so a new one cannot forget it.
    const nodeId = nodeIdOfRoute(url.pathname)
    if (nodeId !== null && !nodeInScope(scope, deps.store.ownerOf(nodeId))) {
      // 404, not 403: a scoped URL must not confirm that nodes exist outside it.
      respondJson(response, 404, { error: 'Not in this workspace' })
      return
    }
  }
  /**
   * THE INTERNET GATE (§9, §11 · ④), mounted per workspace session.
   *
   * FIRST, and deliberately ahead of handleMobileApi. Two reasons, and both
   * would be bugs if this sat below it:
   *
   *  1. The pairing gate (C1) is the LAN tier's credential. An internet caller
   *     holds a call credential and no pairing token, so a call route behind C1
   *     would demand the very thing §9 exists to replace — "the internet tier
   *     swaps pairing token → passkey token", not "in addition to".
   *  2. C1 lets everything through when no pairing token is configured. A route
   *     below it would inherit that escape. Mounted here, it cannot: the only
   *     thing that opens this route is a credential this gate verified.
   *
   * So the two gates are independent, and this one never asks what the other
   * decided, never reads the pairing token, and never looks at which listener
   * the bytes arrived on — the mobile listener binds 0.0.0.0, so the LAN and
   * the internet are the same socket and a listener tells you nothing.
   *
   * `scope === null` is the whole guard for unslugged paths: an exported agent
   * is addressable because the WORKSPACE is, so a call that named no workspace
   * has no focused-session reading. It falls through to the 404 at the bottom.
   */
  if (deps.calls && scope !== null) {
    if (await handleCallRoutes(request, response, url, deps.calls, scope)) return
  }
  /** The workspace this request is answering for. */
  const scopedId = scope ?? deps.store.focusedId
  const scopedState = (): WorkspaceState => deps.store.workspaceState(scopedId)
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
    // A tailnet peer is served the build instead — the live graph is 159
    // dependent requests, which a relayed link never finishes.
    if (rendererSource(request, deps) === 'dev') {
      if (await serveRendererDev(request, response, deps, url, true, servedSlug)) return
    }
    if (!serveRendererIndex(request, response, deps, servedSlug)) rendererMissing()
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
    // The resolved workspace travels WITH the request into the API layer,
    // rather than each handler re-deriving it (or, as before, not deriving it
    // at all and answering for focus).
    scope,
    // Trace-perf T1: the phone card's latest checkpoint, off the TraceReader
    // this server already holds — tail-read, no PTY.
    latestCheckpoint: (terminalId: string) => deps.traces.latestCheckpoint(terminalId),
    pairingToken: activePairingToken ?? deps.pairingToken,
    wallToken: activeWallToken ?? deps.wallToken
  }
  if (await handleMobileApi(request, response, url, authed as MobileApiDeps)) return

  // MOVED BELOW THE DELEGATION, and that is the whole change to it.
  //
  // It used to answer ABOVE handleMobileApi, which meant it was the one /api
  // route that never reached the C1 choke point at all — not "open because
  // reads were open", but structurally out of the gate's reach. It leaks
  // little on its own (a feature flag), and that is exactly why it is worth
  // moving rather than gating in place: a second copy of the auth check here
  // is a second thing to keep in step, and one gate in one place is the
  // property that made the read hole findable in the first place.
  if (request.method === 'GET' && url.pathname === '/api/browser/capabilities') {
    respondJson(response, 200, { interactive: deps.interactiveBrowserEnabled() })
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/state') {
    // Activities are tracked globally by terminal id, so an unfiltered map
    // leaks every OTHER workspace's agents into a scoped canvas — the node
    // list is scoped but the activity map was not, which is the same
    // wrong-answer-looks-right shape the scope check exists to stop.
    const scopedNodeIds = new Set(scopedState().nodes.map((node) => node.id))
    const activities = Object.fromEntries(
      deps.turns
        .list()
        .filter((activity) => scope === null || scopedNodeIds.has(activity.terminalId))
        .map((activity) => [activity.terminalId, activity])
    )
    // Git-enriched like /api/workspace (same coalescing cache), so the lite
    // client's git chips light up too — terminals carry node.git.
    const enriched = await enrichStateWithGit(scopedState(), deps.ops.gitInfo)
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
    // Heartbeat first, and AWAITED — this is what produces the frame when the
    // headless runtime owns the page, and what restarts the desktop's legacy
    // capture when it does not. Either way, asking is what makes a picture
    // exist, so reading the cache before it would answer 404 forever.
    await deps.browserThumbRequested?.(thumbMatch[1])
    const thumb = deps.browserThumb(thumbMatch[1])
    if (!thumb) {
      respondJson(response, 404, { error: 'No thumbnail yet' })
      return
    }
    response.writeHead(200, {
      // The type the frame really is: png from a webview capture, jpeg from a
      // headless screenshot. Mislabelling leaves the phone decoding a lie.
      'content-type': thumb.type,
      'cache-control': 'no-store'
    })
    response.end(thumb.data)
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
    // Producer serialization: mobile-api's 409 while a dispatch stamp is
    // armed ran BEFORE this handler, but it is a fast-path refusal only, not
    // load-bearing (Sol r5 P0-1) — a dispatch can arm in the await gaps
    // between that check and the writes below. The invariant is enforced at
    // the submit sites (Sol r7 P0-2): /input routes through ownerSubmit — THE
    // lease-holding submit primitive, one owner holder across paste and CR —
    // and /ask through askTerminal's own acquisition. Either refusal (a
    // dispatch mid-delivery, another owner submission, a contaminated input
    // box) is surfaced as a 409 the phone can show, never a silent byte drop.
    if (inputMatch[2] === 'input') {
      const verdict = await ownerSubmit(session, `${text}\r`)
      if (verdict.ok) respondJson(response, 200, { ok: true })
      else respondJson(response, 409, { error: verdict.reason })
    } else {
      try {
        // ONE CONTRACT, EVERY CALLER: the phone runs the SAME verified path as
        // the CLI. This route used to return the bare reply, so a dropped
        // brief came back as 200 with an empty string — and the phone is
        // exactly where an owner is least able to tell that from a slow agent.
        const { reply, submitRetries } = await deliverAndConfirm({
          terminalId: inputMatch[1],
          agentName: deps.store.node(inputMatch[1])?.name ?? inputMatch[1],
          prompt: text,
          deliver: () => askTerminal(session, text, { timeoutMs: 120000 }),
          observe: terminalDeliveryDeps(deps.turns, (data) => session.write(data))
        })
        respondJson(response, 200, { ok: true, reply: replyText(reply, submitRetries) })
      } catch (error) {
        if (error instanceof DeliveryError) {
          // The outcome and its remedy ride the BODY, and a caller MUST NOT
          // switch on the status alone: `unsubmitted` and `dropped` are both
          // 502 while their remedies are OPPOSITE — one wants a bare carriage
          // return, the other wants the whole brief resent, and each corrupts
          // the input box when applied to the other. HTTP's vocabulary is too
          // small to carry that distinction; `outcome` is the fact.
          respondJson(response, ASK_HTTP_STATUS[error.outcome], {
            error: error.message,
            outcome: error.outcome,
            remedy: ASK_REMEDY[error.outcome]
          })
          return
        }
        respondJson(response, 409, {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/say') {
    const body = await readJson<{ text?: string }>(request)
    await deps.voice.speak(body.text ?? '')
    respondJson(response, 200, { ok: true })
    return
  }

  // Whichever source served this client's index must serve its assets too:
  // a bundle index asking for /src/main.tsx, or the reverse, loads nothing.
  if (request.method === 'GET' && rendererSource(request, deps) === 'dev') {
    if (await serveRendererDev(request, response, deps, url)) return
  }
  if (request.method === 'GET' && serveRendererAsset(request, response, deps, url.pathname)) return

  respondJson(response, 404, { error: 'Not found' })
}
