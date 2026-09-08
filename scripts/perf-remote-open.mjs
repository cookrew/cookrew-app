#!/usr/bin/env node
/**
 * What a phone pays to OPEN a canvas: the boot waterfall, recorded from a
 * headless Chrome through the CDP Network domain.
 *
 *   node scripts/perf-remote-open.mjs --target lan                # the local companion
 *   node scripts/perf-remote-open.mjs --target lan --latency 200  # + 200 ms per round trip
 *   node scripts/perf-remote-open.mjs --target relay --profile ~/.cookrew/qa/chrome-courier
 *   node scripts/perf-remote-open.mjs --url https://... [--profile DIR] [--settle 15] [--zoom 6] [--json]
 *
 * What it records, all from the request stream and an observer injected
 * before the first script runs:
 *
 *   requests / bytes      every request until the settle window ends; bytes
 *                         are WIRE bytes (encodedDataLength: compressed, with
 *                         headers), the number a relay actually carries.
 *   depth                 the critical-path depth of the waterfall — a request
 *                         is one level deeper than the deepest request that
 *                         had FINISHED before it started.
 *   first paint           PerformancePaintTiming first-contentful-paint.
 *   first card            a MutationObserver's first sight of a canvas node.
 *   interactive           the later of first card and the end of the last BOOT
 *                         request — every request that is not the event
 *                         stream or a thumb poll and began within two seconds
 *                         of first card. A defined proxy, not Lighthouse's.
 *   afterwards            what keeps requesting after that, per minute, by
 *                         path shape — the cost of a canvas that is just open.
 *
 * `--target relay` uses a Chrome profile that has signed in to cookrew.dev
 * once; the profile IS the credential (a non-extractable WebCrypto key) and
 * this never copies, lists or prints anything from it. `--target lan` reads
 * the pairing token from ~/.cookrew and never prints it either.
 *
 * `--latency` adds a fixed round-trip to every request through Chrome's own
 * network emulation — a stand-in for the relay's ~200 ms per exchange when
 * the relay itself cannot be reached.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectCdp, launchChrome, pageTarget } from './perf-cdp.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function parseArgs(argv) {
  const value = (name, fallback) => {
    const i = argv.indexOf(name)
    const next = i >= 0 ? argv[i + 1] : undefined
    return next !== undefined && !next.startsWith('--') ? next : fallback
  }
  return {
    target: value('--target', null),
    url: value('--url', null),
    profile: value('--profile', null),
    base: value('--base', path.join(homedir(), '.cookrew')),
    port: Number(value('--port', 8639)) || 8639,
    latencyMs: Number(value('--latency', 0)) || 0,
    settleS: Number(value('--settle', 15)) || 15,
    zoom: Number(value('--zoom', 0)) || 0,
    json: argv.includes('--json'),
    /** Print the initiator stack of every request whose URL contains this. */
    why: value('--why', null),
    keepBrowser: argv.includes('--keep-browser'),
    dev: argv.includes('--dev')
  }
}

function lanUrl(base, port, renderer) {
  const token = readFileSync(path.join(base, 'pairing-token'), 'utf8').trim()
  // The built bundle, as every non-loopback peer gets it (renderer-choice.ts);
  // `--dev` asks for Vite's graph, whose initiator stacks name real files.
  return `http://127.0.0.1:${port}/?renderer=${renderer}&token=${encodeURIComponent(token)}`
}

/** The OPEN link on /me — the same anchor the owner taps. */
async function relayUrlFromMe(cdp) {
  await cdp.send('Page.navigate', { url: 'https://cookrew.dev/me' })
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const a = [...document.querySelectorAll('a[href]')].find((el) => /\\/relay\\/@[^/]+\\/desktop\\//.test(el.getAttribute('href')))
        return a ? new URL(a.getAttribute('href'), location.href).href : null
      })()`,
      returnByValue: true
    })
    if (typeof result.value === 'string') return result.value
    await sleep(250)
  }
  throw new Error('no OPEN link on https://cookrew.dev/me — is the profile signed in and a desktop online?')
}

/** `/api/browser/abc123/thumb?v=1` → `/api/browser/:id/thumb`. */
export function pathShape(url) {
  let pathname
  try {
    pathname = new URL(url).pathname
  } catch {
    return url
  }
  return pathname
    .replace(/^\/relay\/@[^/]+\/desktop\/[^/]+/, '/relay/…')
    .replace(/\/assets\/[^/]+$/, '/assets/*')
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, '/:id')
    .replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, '/:id')
}

const isStream = (url) => /\/api\/events(\?|$)|\/api\/terminal\/[^/]+\/stream(\?|$)/.test(url)
const isThumb = (url) => /\/api\/browser\/[^/]+\/thumb/.test(url)

/**
 * Critical-path depth: the longest chain of requests where each began only
 * after the previous had finished. Level 1 is the document.
 */
export function waterfallDepth(requests) {
  const done = requests.filter((r) => r.start !== null && r.end !== null).sort((a, b) => a.start - b.start)
  const levels = new Map()
  for (const r of done) {
    let deepest = 0
    for (const q of done) {
      if (q === r) continue
      if (q.end <= r.start) deepest = Math.max(deepest, levels.get(q) ?? 0)
    }
    levels.set(r, deepest + 1)
  }
  return Math.max(0, ...levels.values())
}

/** The summary the eval and the plan note both read. Pure, so it is testable. */
export function summarise({ requests, navStart, marks, settleS }) {
  const rel = (t) => (t === null || t === undefined ? null : Math.round((t - navStart) * 1000))
  const firstCard = marks.firstCard ?? null
  const boot = requests.filter(
    (r) => !isStream(r.url) && !isThumb(r.url) && (firstCard === null || r.start <= navStart + firstCard / 1000 + 2)
  )
  const bootEnd = Math.max(...boot.map((r) => r.end ?? r.start))
  const interactive = firstCard === null ? null : Math.max(firstCard, rel(bootEnd))
  const beforeFirstCard = requests.filter((r) => firstCard !== null && rel(r.start) <= firstCard)
  const bytesOf = (list) => list.reduce((sum, r) => sum + (r.bytes ?? 0), 0)
  const after = requests.filter((r) => interactive !== null && rel(r.start) > interactive)
  const perShape = new Map()
  for (const r of after) {
    const shape = pathShape(r.url)
    const row = perShape.get(shape) ?? { shape, count: 0, bytes: 0 }
    perShape.set(shape, { ...row, count: row.count + 1, bytes: row.bytes + (r.bytes ?? 0) })
  }
  const settleMin = Math.max(1e-6, (settleS - (interactive ?? 0) / 1000) / 60)
  const thirdParty = requests.filter((r) => {
    try {
      return new URL(r.url).host !== new URL(requests[0].url).host
    } catch {
      return false
    }
  })
  const bootShapes = new Map()
  for (const r of boot) {
    const shape = pathShape(r.url)
    const row = bootShapes.get(shape) ?? { shape, count: 0, bytes: 0, ms: 0 }
    bootShapes.set(shape, { ...row, count: row.count + 1, bytes: row.bytes + (r.bytes ?? 0), ms: Math.max(row.ms, r.end && r.start ? Math.round((r.end - r.start) * 1000) : 0) })
  }
  return {
    requests: requests.length,
    bytes: bytesOf(requests),
    boot: {
      requests: boot.length,
      bytes: bytesOf(boot),
      depth: waterfallDepth(boot),
      shapes: [...bootShapes.values()].sort((a, b) => b.count - a.count || b.bytes - a.bytes)
    },
    beforeFirstCard: { requests: beforeFirstCard.length, bytes: bytesOf(beforeFirstCard) },
    thirdParty: { requests: thirdParty.length, hosts: [...new Set(thirdParty.map((r) => new URL(r.url).host))] },
    firstPaintMs: marks.fcp ?? null,
    domContentLoadedMs: marks.dcl ?? null,
    firstCardMs: firstCard,
    interactiveMs: interactive,
    afterwards: {
      requests: after.length,
      bytes: bytesOf(after),
      perMinute: Math.round(after.length / settleMin),
      shapes: [...perShape.values()].sort((a, b) => b.count - a.count)
    },
    biggest: [...requests]
      .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
      .slice(0, 12)
      .map((r) => ({ shape: pathShape(r.url), bytes: r.bytes, ms: r.end && r.start ? Math.round((r.end - r.start) * 1000) : null, encoding: r.encoding, cache: r.cacheControl, status: r.status })),
    waterfall: [...requests]
      .sort((a, b) => a.start - b.start)
      .slice(0, 60)
      .map((r) => ({ at: rel(r.start), ms: r.end && r.start ? Math.round((r.end - r.start) * 1000) : null, bytes: r.bytes, status: r.status, shape: pathShape(r.url), type: r.type }))
  }
}

const OBSERVER = `(() => {
  const marks = { firstCard: null, fcp: null, dcl: null, load: null }
  window.__courier = marks
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (entry.name === 'first-contentful-paint') marks.fcp = Math.round(entry.startTime)
    }).observe({ type: 'paint', buffered: true })
  } catch {}
  document.addEventListener('DOMContentLoaded', () => { marks.dcl = Math.round(performance.now()) })
  window.addEventListener('load', () => { marks.load = Math.round(performance.now()) })
  const seen = () => {
    if (marks.firstCard !== null) return
    if (document.querySelector('.react-flow__node')) { marks.firstCard = Math.round(performance.now()); observer.disconnect() }
  }
  const observer = new MutationObserver(seen)
  document.addEventListener('DOMContentLoaded', () => { observer.observe(document.documentElement, { childList: true, subtree: true }); seen() })
})()`

export async function recordOpen(opts) {
  const ownProfile = opts.profile === null
  const profile = opts.profile ?? mkdtempSync(path.join(tmpdir(), 'courier-chrome-'))
  const chrome = await launchChrome({ userDataDir: profile })
  const requests = new Map()
  let navStart = null
  try {
    const cdp = await connectCdp(await pageTarget(chrome.port))
    await cdp.send('Network.enable', { maxTotalBufferSize: 64 * 1024 * 1024 })
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 500, height: 900, deviceScaleFactor: 2, mobile: true })
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: false })
    if (opts.latencyMs > 0) {
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: opts.latencyMs, downloadThroughput: -1, uploadThroughput: -1 })
    }
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: OBSERVER })
    cdp.on('Network.requestWillBeSent', (p) => {
      // A data: URL is decoded in place; nothing crosses a wire for it.
      if (p.request.url.startsWith('data:')) return
      if (p.redirectResponse && requests.has(p.requestId)) {
        // A redirect is a finished exchange; the follow-up gets its own row.
        const prior = requests.get(p.requestId)
        requests.set(`${p.requestId}:r`, { ...prior, end: p.timestamp, status: p.redirectResponse.status, bytes: p.redirectResponse.encodedDataLength })
      }
      requests.set(p.requestId, { url: p.request.url, type: p.type, start: p.timestamp, end: null, bytes: null, status: null, encoding: null, cacheControl: null })
      if (opts.why && p.request.url.includes(opts.why)) {
        const frames = (p.initiator?.stack?.callFrames ?? []).slice(0, 6).map((f) => `${f.functionName || '?'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber}`)
        process.stderr.write(`why ${pathShape(p.request.url)} ← ${frames.join(' ← ') || p.initiator?.type}\n`)
      }
      if (navStart === null && p.type === 'Document') navStart = p.timestamp
    })
    cdp.on('Network.responseReceived', (p) => {
      const row = requests.get(p.requestId)
      if (!row) return
      const headers = Object.fromEntries(Object.entries(p.response.headers).map(([k, v]) => [k.toLowerCase(), v]))
      requests.set(p.requestId, { ...row, status: p.response.status, encoding: headers['content-encoding'] ?? null, cacheControl: headers['cache-control'] ?? null, fromCache: p.response.fromDiskCache || p.response.fromMemoryCache || false })
    })
    // A stream never finishes; its bytes arrive chunk by chunk and are the
    // only record of what the event stream cost while the page sat open.
    cdp.on('Network.dataReceived', (p) => {
      const row = requests.get(p.requestId)
      if (row) requests.set(p.requestId, { ...row, streamed: (row.streamed ?? 0) + p.encodedDataLength })
    })
    cdp.on('Network.loadingFinished', (p) => {
      const row = requests.get(p.requestId)
      if (row) requests.set(p.requestId, { ...row, end: p.timestamp, bytes: p.encodedDataLength })
    })
    cdp.on('Network.loadingFailed', (p) => {
      const row = requests.get(p.requestId)
      if (row) requests.set(p.requestId, { ...row, end: p.timestamp, status: row.status ?? 0, failed: p.errorText })
    })

    let url = opts.url
    if (!url && opts.target === 'lan') url = lanUrl(opts.base, opts.port, opts.dev ? 'dev' : 'built')
    if (!url && opts.target === 'relay') url = await relayUrlFromMe(cdp)
    if (!url) throw new Error('give --target lan|relay or --url')
    // The /me hop above must not count; the canvas starts here.
    requests.clear()
    navStart = null
    await cdp.send('Page.navigate', { url })
    const started = Date.now()
    while (Date.now() - started < opts.settleS * 1000) {
      await sleep(250)
      if (opts.zoom > 0) {
        const { result } = await cdp.send('Runtime.evaluate', { expression: 'window.__courier && window.__courier.firstCard', returnByValue: true })
        if (typeof result.value === 'number') {
          // Six notches of pinch at the middle: zoom past mini so thumbs poll.
          for (let i = 0; i < opts.zoom; i += 1) {
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 250, y: 450, deltaX: 0, deltaY: -120, modifiers: 2 })
            await sleep(80)
          }
          opts = { ...opts, zoom: 0 }
        }
      }
    }
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__courier || {})', returnByValue: true })
    const marks = JSON.parse(result.value || '{}')
    const list = [...requests.values()].filter((r) => r.start !== null)
    // The stream never ends: give it the settle window as its end so depth
    // and bytes count what actually crossed.
    const now = Math.max(...list.map((r) => r.end ?? r.start))
    const closed = list.map((r) => (r.end === null ? { ...r, end: now, bytes: r.bytes ?? r.streamed ?? 0 } : r))
    cdp.close()
    return { url: url.replace(/token=[^&]+/, 'token=…'), summary: summarise({ requests: closed, navStart, marks, settleS: opts.settleS }), latencyMs: opts.latencyMs }
  } finally {
    if (!opts.keepBrowser) chrome.child.kill('SIGKILL')
    if (ownProfile) rmSync(profile, { recursive: true, force: true })
  }
}

const fmtKb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`

export function renderOpen(report) {
  const s = report.summary
  const lines = [
    `remote open ${report.url}${report.latencyMs ? ` (+${report.latencyMs} ms RTT)` : ''}`,
    `  first paint ${s.firstPaintMs ?? '—'} ms · first card ${s.firstCardMs ?? '—'} ms · interactive ${s.interactiveMs ?? '—'} ms`,
    `  boot: ${s.boot.requests} requests, ${fmtKb(s.boot.bytes)}, depth ${s.boot.depth}; before first card ${s.beforeFirstCard.requests} requests / ${fmtKb(s.beforeFirstCard.bytes)}`,
    ...s.boot.shapes.map((row) => `    ${String(row.count).padStart(3)}× ${row.shape} ${fmtKb(row.bytes)} (slowest ${row.ms} ms)`),
    `  third-party: ${s.thirdParty.requests} requests${s.thirdParty.hosts.length ? ` (${s.thirdParty.hosts.join(', ')})` : ''}`,
    `  afterwards: ${s.afterwards.requests} requests (${s.afterwards.perMinute}/min), ${fmtKb(s.afterwards.bytes)}`,
    ...s.afterwards.shapes.slice(0, 6).map((row) => `    ${row.count}× ${row.shape} ${fmtKb(row.bytes)}`),
    '  biggest:',
    ...s.biggest.slice(0, 8).map((r) => `    ${fmtKb(r.bytes ?? 0).padStart(8)} ${String(r.ms ?? '—').padStart(6)} ms ${r.status} ${r.encoding ?? 'identity'} ${r.shape}  [${r.cache ?? ''}]`),
    '  waterfall:',
    ...s.waterfall.slice(0, 30).map((r) => `    +${String(r.at).padStart(6)} ${String(r.ms ?? '—').padStart(6)} ms ${fmtKb(r.bytes ?? 0).padStart(8)} ${r.status ?? '?'} ${r.shape}`)
  ]
  return lines.join('\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const opts = parseArgs(process.argv.slice(2))
  recordOpen(opts).then(
    (report) => {
      process.stdout.write(opts.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderOpen(report)}\n`)
    },
    (error) => {
      console.error('remote open failed:', error.message)
      process.exit(2)
    }
  )
}
