#!/usr/bin/env node
/**
 * The DOM probe: what the renderer MOUNTS and what it RE-RENDERS, measured in
 * a headless Chrome against the local companion page (the same React app the
 * desktop runs, served in remote mode by the app on 127.0.0.1:8639).
 *
 *   node scripts/perf-dom-probe.mjs                     # phone viewport, table
 *   node scripts/perf-dom-probe.mjs --viewport desktop  # 1440x900
 *   node scripts/perf-dom-probe.mjs --json
 *   node scripts/perf-dom-probe.mjs --serve out/renderer   # a build of THIS tree,
 *                                                          # api proxied to the app
 *   node scripts/perf-dom-probe.mjs --attach 9333        # read-only census of a
 *                                                        # live page (the desktop
 *                                                        # renderer relaunched with
 *                                                        # --remote-debugging-port)
 *
 * What it measures, and how honestly:
 *
 *   DOM      element counts from the page itself, split by what owns them
 *            (cards by kind, edges, minimap, offscreen browser hosts, overlays).
 *   FIBERS   mounted React component instances by name, walked from the root
 *            fiber — what is MOUNTED, whether or not it is on screen.
 *   COMMITS  a React DevTools hook shim installed before the bundle loads.
 *            React calls it on every commit (production builds included); the
 *            probe counts commits and, per commit, every fiber React rebuilt
 *            that carries the PerformedWork flag, by component name — the
 *            same descent rule React DevTools uses, so a subtree that bailed
 *            out is not counted for the flags its last render left behind. A pan is N real mouse
 *            moves through CDP Input, a zoom N wheel ticks, so the numbers are
 *            renders per REAL frame, not per synthetic state change.
 *   LAYERS   the compositing layer tree (CDP LayerTree) and the backing-store
 *            bytes its content layers imply at 4 bytes per pixel.
 *   MEMORY   Performance.getMetrics (JS heap, nodes, layout/style counts) and
 *            Memory.getDOMCounters (nodes INCLUDING detached ones).
 *
 * The pairing token is read from ~/.cookrew/pairing-token and rides the page
 * URL the way the phone's own pairing URL carries it. It is never printed.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CHROME_CANDIDATES = [
  process.env.COOKREW_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean)

export const VIEWPORTS = {
  phone: { width: 390, height: 844, mobile: true },
  desktop: { width: 1440, height: 900, mobile: false }
}

export function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

// ---------------------------------------------------------------------------
// Chrome and CDP.
// ---------------------------------------------------------------------------

export async function launchChrome({ width, height, chrome = findChrome() }) {
  if (!chrome) throw new Error('no Chrome binary found (set COOKREW_CHROME)')
  const port = await freePort()
  const profile = mkdtempSync(path.join(tmpdir(), 'cookrew-dom-probe-'))
  const child = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--hide-scrollbars',
      '--mute-audio',
      'about:blank'
    ],
    { stdio: 'ignore' }
  )
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) break
    } catch {
      // not up yet
    }
    await sleep(100)
  }
  return {
    port,
    /** Ends Chrome and removes its profile — after it has actually exited. */
    async kill() {
      const exited = new Promise((resolve) => {
        if (child.exitCode !== null) resolve(undefined)
        child.once('exit', () => resolve(undefined))
        setTimeout(resolve, 3000)
      })
      child.kill('SIGKILL')
      await exited
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
}

/** One CDP page session over the global WebSocket (Node 22+). */
export async function connectPage(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('CDP socket failed'))
  })
  let nextId = 1
  const pending = new Map()
  const listeners = new Map()
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result)
      return
    }
    for (const cb of listeners.get(message.method) ?? []) cb(message.params)
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const api = {
    send,
    on(method, cb) {
      if (!listeners.has(method)) listeners.set(method, new Set())
      listeners.get(method).add(cb)
      return () => listeners.get(method)?.delete(cb)
    },
    async evaluate(expression) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      })
      if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'evaluate failed')
      return result?.value
    },
    /** One animation frame of the page. */
    frame: () => api.evaluate('new Promise((r) => requestAnimationFrame(() => r(1)))'),
    close() {
      ws.close()
    }
  }
  return api
}

// ---------------------------------------------------------------------------
// The in-page instruments.
// ---------------------------------------------------------------------------

/**
 * The React DevTools hook shim. React looks for this global at bundle load
 * and reports every commit to it; PerformedWork (flag bit 1) marks the fibers
 * whose render function actually ran in that commit.
 */
export const HOOK_SCRIPT = `(() => {
  const PERFORMED_WORK = 1
  let recording = false
  let commits = 0
  let renders = {}
  const nameOf = (fiber) => {
    const t = fiber.type
    if (typeof t === 'function') return t.displayName || t.name || 'anonymous'
    if (t && typeof t === 'object') {
      const inner = t.type || t.render
      if (typeof inner === 'function') return inner.displayName || inner.name || 'anonymous'
    }
    return null
  }
  const walk = (root) => {
    const stack = [root]
    while (stack.length) {
      const fiber = stack.pop()
      if ((fiber.flags & PERFORMED_WORK) !== 0) {
        const name = nameOf(fiber)
        if (name !== null) renders[name] = (renders[name] || 0) + 1
      }
      if (fiber.sibling) stack.push(fiber.sibling)
      // Descend only into a child list React rebuilt in this commit. A
      // subtree that bailed out is SHARED with the alternate tree and still
      // carries the flags from the last time it did render, so walking it
      // would count that old render again on every commit (the React
      // DevTools descent rule).
      if (fiber.child && (!fiber.alternate || fiber.child !== fiber.alternate.child)) stack.push(fiber.child)
    }
  }
  const hook = {
    renderers: new Map(),
    supportsFiber: true,
    isDisabled: false,
    inject(renderer) { const id = hook.renderers.size + 1; hook.renderers.set(id, renderer); return id },
    onCommitFiberRoot(_id, root) { if (!recording) return; commits += 1; walk(root.current) },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
    on() {}, off() {}, emit() {}, sub() { return () => {} }
  }
  Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: hook, configurable: true })
  window.__crRenderCensus = {
    start() { commits = 0; renders = {}; recording = true },
    stop() { recording = false; return { commits, renders } }
  }
})()`

/** Element counts, split by owner. Cheap enough to run between frames. */
export const CENSUS = `(() => {
  const count = (sel) => document.querySelectorAll(sel).length
  const within = (sel) => [...document.querySelectorAll(sel)].reduce((s, el) => s + 1 + el.getElementsByTagName('*').length, 0)
  const kinds = {}
  for (const kind of ['terminal', 'note', 'browser']) {
    const cards = [...document.querySelectorAll('.react-flow__node-' + kind)]
    kinds[kind] = { cards: cards.length, elements: cards.reduce((s, el) => s + 1 + el.getElementsByTagName('*').length, 0) }
  }
  return {
    total: document.getElementsByTagName('*').length,
    cards: count('.react-flow__node'),
    kinds,
    edges: count('.react-flow__edge'),
    edgeElements: within('.react-flow__edges'),
    minimapNodes: count('.react-flow__minimap-node'),
    minimapElements: within('.react-flow__minimap'),
    offscreenBrowsers: count('.browser-offscreen'),
    offscreenBrowserElements: within('.browser-offscreen'),
    overlays: count('.terminal-lod, .browser-lod'),
    overlayElements: within('.terminal-lod, .browser-lod'),
    board: within('.roster-view, .roster-panel'),
    xtermRows: count('.xterm-rows > div'),
    images: document.images.length,
    canvases: count('canvas'),
    zoom: (document.querySelector('.react-flow__viewport') || {}).style?.transform || 'none'
  }
})()`

/** Mounted component instances by name, walked from the root fiber. */
export const FIBER_CENSUS = `(() => {
  const root = document.getElementById('root')
  const key = root && Object.keys(root).find((k) => k.startsWith('__reactContainer$'))
  if (!key) return null
  const counts = {}
  let total = 0
  const stack = [root[key]]
  while (stack.length) {
    const fiber = stack.pop()
    total += 1
    const t = fiber.type
    let name = null
    if (typeof t === 'function') name = t.displayName || t.name || 'anonymous'
    else if (t && typeof t === 'object' && typeof (t.type || t.render) === 'function') name = (t.type || t.render).displayName || (t.type || t.render).name || 'anonymous'
    if (name !== null) counts[name] = (counts[name] || 0) + 1
    if (fiber.sibling) stack.push(fiber.sibling)
    if (fiber.child) stack.push(fiber.child)
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 40)
  return { fibers: total, components: Object.fromEntries(top) }
})()`

/** A stage point that is pane, not card or chrome — where a drag pans. */
export const PANE_POINT = `(() => {
  const pane = document.querySelector('.react-flow__pane')
  if (!pane) return null
  const r = pane.getBoundingClientRect()
  for (let y = r.top + 60; y < r.bottom - 60; y += 30) {
    for (let x = r.left + 30; x < r.right - 30; x += 30) {
      const el = document.elementFromPoint(x, y)
      if (el && !el.closest('.react-flow__node, .react-flow__minimap, .react-flow__controls, .cr-dock, .cr-header, button, .terminal-lod, .browser-lod')) return { x, y }
    }
  }
  return null
})()`

// ---------------------------------------------------------------------------
// Measurements.
// ---------------------------------------------------------------------------

async function metrics(page) {
  const [{ metrics: list }, counters] = await Promise.all([
    page.send('Performance.getMetrics'),
    page.send('Memory.getDOMCounters')
  ])
  const byName = Object.fromEntries(list.map((m) => [m.name, m.value]))
  return {
    jsHeapUsedMb: byName.JSHeapUsedSize / 1048576,
    jsHeapTotalMb: byName.JSHeapTotalSize / 1048576,
    nodes: byName.Nodes,
    domNodesIncludingDetached: counters.nodes,
    listeners: counters.jsEventListeners,
    documents: counters.documents,
    layoutCount: byName.LayoutCount,
    recalcStyleCount: byName.RecalcStyleCount
  }
}

/** The compositing layer tree, from the latest LayerTree.layerTreeDidChange. */
function watchLayers(page) {
  let latest = null
  page.on('LayerTree.layerTreeDidChange', ({ layers }) => {
    latest = layers ?? null
  })
  return async () => {
    await page.send('LayerTree.enable').catch(() => undefined)
    // A no-op style write nudges a tree update out of a page that has gone quiet.
    await page.evaluate('(document.body.style.outlineOffset = "0px", 1)')
    await sleep(400)
    if (!latest) return { count: null, contentLayers: null, backingMb: null }
    const content = latest.filter((l) => l.drawsContent)
    const backing = content.reduce((s, l) => s + l.width * l.height * 4, 0)
    return { count: latest.length, contentLayers: content.length, backingMb: backing / 1048576 }
  }
}

export async function recordFrames(page, run) {
  await page.evaluate('window.__crRenderCensus.start()')
  const frames = await run()
  await page.frame()
  const census = await page.evaluate('window.__crRenderCensus.stop()')
  const topRenders = Object.fromEntries(
    Object.entries(census.renders)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 16)
  )
  return { frames, commits: census.commits, commitsPerFrame: census.commits / Math.max(1, frames), renders: topRenders }
}

export async function pan(page, point, frames, step = 6) {
  const base = { x: point.x, y: point.y, button: 'left', buttons: 1 }
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, clickCount: 1 })
  for (let i = 1; i <= frames; i += 1) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, x: point.x + i * step, y: point.y + i * step })
    await page.frame()
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, x: point.x + frames * step, y: point.y + frames * step })
  // Pan back, so a later measurement starts from the same view.
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, x: point.x + frames * step, y: point.y + frames * step, clickCount: 1 })
  for (let i = frames - 1; i >= 0; i -= 1) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, x: point.x + i * step, y: point.y + i * step })
    await page.frame()
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
  return frames * 2
}

export async function zoom(page, point, frames, delta = 40) {
  for (let i = 0; i < frames; i += 1) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: -delta })
    await page.frame()
  }
  for (let i = 0; i < frames; i += 1) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: delta })
    await page.frame()
  }
  return frames * 2
}

async function idle(page, ms) {
  const started = Date.now()
  let frames = 0
  while (Date.now() - started < ms) {
    await page.frame()
    frames += 1
  }
  return frames
}

const BOARD_CLICK = (view) => `(() => {
  const button = [...document.querySelectorAll('.cr-header button')].find((b) => ${
    view === 'agents' ? "/board/i.test(b.title || '')" : "/canvas/i.test(b.title || '') || b.getAttribute('aria-pressed') === 'false'"
  })
  if (!button) return false
  button.click()
  return true
})()`

export async function waitForCanvas(page, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const cards = await page.evaluate("document.querySelectorAll('.react-flow__node').length").catch(() => 0)
    if (cards > 0) {
      await sleep(2500) // thumbs, checkpoints and the first activity seed
      return cards
    }
    await sleep(250)
  }
  throw new Error('the canvas never showed a card')
}

// ---------------------------------------------------------------------------
// Serving a build of THIS tree against the running app (A/B measurements).
// ---------------------------------------------------------------------------

const REMOTE_BOOT = `<script>
window.COOKREW_SLUG = ''
window.COOKREW_BASE = ''
window.COOKREW_MOBILE = 1
document.addEventListener('DOMContentLoaded', () => { document.body.classList.add('cookrew-mobile') })
</script>`

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }

/**
 * Static renderer build at `/`, everything else piped to the app on `apiPort`.
 * `remote: false` serves the pages as plain HTML (no companion boot script) —
 * the demo-mode fixture in tests/perf wants the app with no backend at all.
 */
export async function serveBuild(dir, apiPort, { remote = true } = {}) {
  const root = path.resolve(dir)
  const page = (name) => {
    const html = readFileSync(path.join(root, name), 'utf8')
    return remote ? html.replace('<script type="module"', `${REMOTE_BOOT}<script type="module"`) : html
  }
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const html = url.pathname === '/' ? 'index.html' : url.pathname.endsWith('.html') ? url.pathname.slice(1) : null
    if (html !== null && existsSync(path.join(root, html))) {
      response.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' })
      response.end(page(html))
      return
    }
    const file = path.resolve(root, '.' + url.pathname)
    if (file.startsWith(root + path.sep) && existsSync(file) && MIME[path.extname(file)]) {
      response.writeHead(200, { 'content-type': MIME[path.extname(file)] })
      response.end(readFileSync(file))
      return
    }
    if (apiPort === null) {
      response.writeHead(404)
      response.end()
      return
    }
    const upstream = http.request(
      { host: '127.0.0.1', port: apiPort, method: request.method, path: request.url, headers: request.headers },
      (res) => {
        response.writeHead(res.statusCode ?? 502, res.headers)
        res.pipe(response)
      }
    )
    upstream.on('error', () => {
      response.writeHead(502)
      response.end()
    })
    request.pipe(upstream)
  })
  const port = await freePort()
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return { port, close: () => server.close() }
}

// ---------------------------------------------------------------------------
// The probe.
// ---------------------------------------------------------------------------

export function readToken(base = path.join(homedir(), '.cookrew')) {
  try {
    return readFileSync(path.join(base, 'pairing-token'), 'utf8').trim()
  } catch {
    return null
  }
}

async function workspaceShape(apiPort, token) {
  try {
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/workspace`, { headers: { authorization: `Bearer ${token}` } })
    if (!res.ok) return null
    const state = await res.json()
    const byKind = {}
    for (const node of state.nodes ?? []) byKind[node.kind] = (byKind[node.kind] ?? 0) + 1
    return { name: state.name, nodes: state.nodes?.length ?? 0, byKind, connections: state.connections?.length ?? 0 }
  } catch {
    return null
  }
}

/**
 * Load the companion in a fresh headless Chrome and measure it at rest, under
 * a pan, under a zoom, idle, and across a board open/close.
 */
export async function probeCompanion({ viewport = 'phone', apiPort = 8639, serve = null, frames = 30, gestures = true, token = readToken() } = {}) {
  if (!token) throw new Error('no pairing token')
  const size = VIEWPORTS[viewport] ?? VIEWPORTS.phone
  const served = serve ? await serveBuild(serve, apiPort) : null
  const origin = served ? `http://127.0.0.1:${served.port}/` : `http://127.0.0.1:${apiPort}/?renderer=built`
  const url = `${origin}${origin.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
  const chrome = await launchChrome(size)
  try {
    const page = await connectPage(chrome.port)
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Performance.enable')
    await page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: size.mobile ? 3 : 2, mobile: size.mobile })
    if (size.mobile) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true })
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK_SCRIPT })
    const layers = watchLayers(page)
    await page.send('Page.navigate', { url })
    await waitForCanvas(page)
    const workspace = await workspaceShape(apiPort, token)
    const result = {
      viewport,
      size: { width: size.width, height: size.height },
      source: served ? path.resolve(serve) : 'app build (?renderer=built)',
      workspace,
      rest: { dom: await page.evaluate(CENSUS), fiber: await page.evaluate(FIBER_CENSUS), layers: await layers(), metrics: await metrics(page) }
    }
    if (gestures) {
      const point = await page.evaluate(PANE_POINT)
      result.idle = await recordFrames(page, () => idle(page, 3000))
      if (point) {
        result.pan = await recordFrames(page, () => pan(page, point, frames))
        result.zoom = await recordFrames(page, () => zoom(page, point, frames))
      } else {
        result.pan = null
        result.zoom = null
      }
      // The board: open, measure; close, collect, measure — what it leaves behind.
      const opened = await page.evaluate(BOARD_CLICK('agents'))
      if (opened) {
        await sleep(2000)
        result.board = { open: { dom: await page.evaluate(CENSUS), layers: await layers(), metrics: await metrics(page) } }
        await page.evaluate(BOARD_CLICK('canvas'))
        await sleep(1500)
        await page.send('HeapProfiler.collectGarbage').catch(() => undefined)
        await sleep(500)
        result.board.closed = { dom: await page.evaluate(CENSUS), fiber: await page.evaluate(FIBER_CENSUS), layers: await layers(), metrics: await metrics(page) }
      }
    }
    page.close()
    return result
  } finally {
    await chrome.kill()
    served?.close()
  }
}

/** Read-only census of a page already running with remote debugging on. */
export async function probeAttached(port) {
  const page = await connectPage(port)
  await page.send('Performance.enable')
  const layers = watchLayers(page)
  const result = { attached: port, rest: { dom: await page.evaluate(CENSUS), fiber: await page.evaluate(FIBER_CENSUS), layers: await layers(), metrics: await metrics(page) } }
  await page.send('LayerTree.disable').catch(() => undefined)
  page.close()
  return result
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

const fmt = (n, digits = 1) => (n === null || n === undefined ? '—' : typeof n === 'number' ? n.toFixed(digits) : String(n))

function renderRest(label, rest) {
  const d = rest.dom
  const m = rest.metrics
  const lines = [
    `${label}: ${d.total} elements, ${d.cards} cards (${Object.entries(d.kinds).map(([k, v]) => `${k} ${v.cards}/${v.elements}`).join(', ')}), ` +
      `${d.edges} edges/${d.edgeElements}, minimap ${d.minimapNodes}/${d.minimapElements}, offscreen browsers ${d.offscreenBrowsers}/${d.offscreenBrowserElements}, overlays ${d.overlays}/${d.overlayElements}, board ${d.board}`,
    `  heap ${fmt(m.jsHeapUsedMb)} MB, nodes ${m.nodes} (incl. detached ${m.domNodesIncludingDetached}), listeners ${m.listeners}, layers ${fmt(rest.layers.count, 0)} (${fmt(rest.layers.contentLayers, 0)} content, ${fmt(rest.layers.backingMb)} MB backing)`
  ]
  if (rest.fiber) {
    lines.push(`  fibers ${rest.fiber.fibers}: ${Object.entries(rest.fiber.components).slice(0, 12).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  }
  return lines.join('\n')
}

function renderGesture(label, g) {
  if (!g) return `${label}: no pane point found`
  return `${label}: ${g.frames} frames, ${g.commits} commits (${fmt(g.commitsPerFrame, 2)}/frame); renders: ${Object.entries(g.renders).map(([k, v]) => `${k} ${v}`).join(', ')}`
}

export function renderReport(result) {
  const out = []
  if (result.workspace) out.push(`workspace ${result.workspace.name}: ${result.workspace.nodes} nodes (${Object.entries(result.workspace.byKind).map(([k, v]) => `${k} ${v}`).join(', ')}), ${result.workspace.connections} cables`)
  out.push(renderRest(result.attached ? `attached :${result.attached}` : `${result.viewport} ${result.size.width}x${result.size.height} at rest`, result.rest))
  if (result.idle) out.push(renderGesture('idle 3 s', result.idle))
  if (result.pan !== undefined) out.push(renderGesture('pan', result.pan))
  if (result.zoom !== undefined) out.push(renderGesture('zoom', result.zoom))
  if (result.board) {
    out.push(renderRest('board open', result.board.open))
    out.push(renderRest('board closed (after GC)', result.board.closed))
  }
  return out.join('\n')
}

function parseArgs(argv) {
  const value = (name, fallback) => {
    const i = argv.indexOf(name)
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
  }
  return {
    json: argv.includes('--json'),
    gestures: !argv.includes('--no-gestures'),
    viewport: value('--viewport', 'phone'),
    serve: value('--serve', null),
    attach: value('--attach', null),
    frames: Number(value('--frames', 30)) || 30,
    apiPort: Number(value('--port', 8639)) || 8639
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const opts = parseArgs(process.argv.slice(2))
  const run = opts.attach ? probeAttached(Number(opts.attach)) : probeCompanion(opts)
  run.then(
    (result) => {
      process.stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderReport(result)}\n`)
    },
    (error) => {
      console.error('dom probe failed:', error)
      process.exit(2)
    }
  )
}
