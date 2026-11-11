#!/usr/bin/env node
/**
 * THE CONSOLE, TIMED IN A REAL BROWSER THAT IS ALREADY SIGNED IN (latency 0.6.1).
 *
 * Attaches to a Chrome that holds a console sign-in (a canvas browser card:
 * its DevToolsActivePort), opens a NEW tab in that profile, and for each width
 * opens a machine the way a person does, by its address, timing:
 *
 *   paint      navigation start -> the machine's level drawn (`--ready` selector)
 *   requests   every request the page made, by origin, with the preflights
 *              counted on their own and the distinct relay URLs
 *   probe      when the page asked for a direct path (rtc offer, hellos, the
 *              registry's verify) and when it stopped asking
 *   steady     what one quiet minute inside the machine costs, in requests and
 *              preflights
 *
 * The page does what it does by itself; this script types nothing and presses
 * nothing. The tab it opened is closed at the end.
 *
 *   node scripts/console-open-timing.mjs --port <cdp port> --machine <id>
 *        [--console https://console.cookrew.dev] [--ws <workspace id>]
 *        [--steady-ms 60000] [--widths 412,1440] [--runs 2]
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { connectCdp } = await import(path.join(here, 'perf-cdp.mjs'))

const args = new Map()
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i]
  if (!key.startsWith('--')) continue
  const next = process.argv[i + 1]
  args.set(key.slice(2), next !== undefined && !next.startsWith('--') ? (i += 1, next) : 'true')
}
const port = Number(args.get('port'))
const machine = String(args.get('machine') ?? '')
const consoleOrigin = String(args.get('console') ?? 'https://console.cookrew.dev')
const workspace = args.get('ws') ?? null
const steadyMs = Number(args.get('steady-ms') ?? 60_000)
const widths = String(args.get('widths') ?? '412,1440').split(',').map(Number)
const runs = Number(args.get('runs') ?? 2)
const ready = String(args.get('ready') ?? '.zv-door, .zv-av')
if (!port || !/^[0-9a-f-]{36}$/.test(machine)) {
  console.error('usage: --port <cdp port> --machine <machine id>')
  process.exit(2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const json = async (url, method = 'GET') => (await fetch(url, { method })).json()

const opened = await json(`http://127.0.0.1:${port}/json/new?about:blank`, 'PUT')
const cdp = await connectCdp(opened.webSocketDebuggerUrl)
const close = async () => {
  cdp.close()
  await fetch(`http://127.0.0.1:${port}/json/close/${opened.id}`).catch(() => undefined)
}

const seen = new Map()
let order = 0
cdp.on('Network.requestWillBeSent', (event) => {
  const prior = seen.get(event.requestId)
  // A redirect reuses the id; keep the first.
  if (prior) return
  seen.set(event.requestId, {
    n: order++,
    url: event.request.url,
    method: event.request.method,
    type: event.type ?? '',
    initiator: event.initiator?.type ?? '',
    t0: event.timestamp * 1000,
    head: null,
    end: null,
    status: 0,
    bytes: 0,
    fromCache: false,
    sw: false,
    protocol: '',
    remote: ''
  })
})
cdp.on('Network.responseReceived', (event) => {
  const row = seen.get(event.requestId)
  if (!row) return
  row.head = event.timestamp * 1000
  row.status = event.response.status
  row.fromCache = Boolean(event.response.fromDiskCache || event.response.fromPrefetchCache)
  row.sw = Boolean(event.response.fromServiceWorker)
  row.protocol = event.response.protocol ?? ''
  row.remote = event.response.remoteIPAddress ?? ''
  row.timing = event.response.timing ?? null
})
cdp.on('Network.loadingFinished', (event) => {
  const row = seen.get(event.requestId)
  if (!row) return
  row.end = event.timestamp * 1000
  row.bytes = event.encodedDataLength
})
cdp.on('Network.loadingFailed', (event) => {
  const row = seen.get(event.requestId)
  if (!row) return
  row.end = event.timestamp * 1000
  row.failed = event.errorText
})
await cdp.send('Network.enable')
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')

/** When the expression first held, in the page's clock relative to navigation start; null on timeout. */
const until = async (expression, ms) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const answer = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }).catch(() => null)
    if (answer?.result?.value) return answer.result.value
    await sleep(40)
  }
  return null
}

const relayPrefix = (url) => /^https:\/\/api\.[^/]+\/api\/m\//.test(url)
const classify = (row) => {
  const u = new URL(row.url)
  if (row.method === 'OPTIONS' || row.type === 'Preflight') return 'preflight'
  if (relayPrefix(row.url)) return 'relay'
  if (u.hostname.startsWith('api.')) return 'registry'
  if (u.origin === consoleOrigin) return 'console'
  if (u.hostname.endsWith('.d.cookrew.dev')) return 'direct'
  return 'other'
}
const summarise = (rows, from) => {
  const by = {}
  for (const row of rows) by[classify(row)] = (by[classify(row)] ?? 0) + 1
  const relay = rows.filter((row) => classify(row) === 'relay')
  const routes = relay.map((row) => new URL(row.url).pathname.replace(/^\/api\/m\/[^/]+/, '') + new URL(row.url).search)
  return {
    by,
    distinctRelayUrls: new Set(relay.map((row) => row.url)).size,
    relayRoutes: [...new Set(routes.map((route) => route.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ':id').replace(/=\d{6,}/g, '=:n')))].sort(),
    timeline: rows
      .filter((row) => classify(row) !== 'console' || row.n < 3)
      .map((row) => ({
        kind: classify(row),
        method: row.method,
        what: (() => {
          const u = new URL(row.url)
          return (u.hostname.startsWith('api.') ? '' : u.hostname + ' ') + u.pathname.replace(/^\/api\/m\/[^/]+/, 'M').replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ':id') + (u.search.length > 40 ? u.search.slice(0, 40) + '…' : u.search)
        })(),
        start: Math.round(row.t0 - from),
        head: row.head === null ? null : Math.round(row.head - from),
        end: row.end === null ? null : Math.round(row.end - from),
        status: row.status,
        ...(row.failed ? { failed: row.failed } : {}),
        ...(row.sw ? { sw: true } : {}),
        ...(row.protocol ? { proto: row.protocol } : {}),
        ...(row.timing && row.timing.connectStart >= 0 ? { connect: Math.round(row.timing.connectEnd - row.timing.connectStart), proxy: Math.round(Math.max(0, row.timing.proxyEnd - row.timing.proxyStart)) } : {})
      }))
  }
}

const results = []
for (const width of widths) {
  const mobile = width < 700
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: mobile ? 915 : 900, deviceScaleFactor: mobile ? 2.625 : 1, mobile })
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile })
  for (let run = 0; run < runs; run += 1) {
    // Somewhere else first, so the machine's address is a real navigation.
    await cdp.send('Page.navigate', { url: 'about:blank' })
    await sleep(500)
    seen.clear()
    order = 0
    const target = workspace ? `${consoleOrigin}/d/${machine}/w/${workspace}` : `${consoleOrigin}/d/${machine}`
    const wall = Date.now()
    await cdp.send('Page.navigate', { url: target })
    const nav = [...seen.values()].find((row) => row.type === 'Document')
    const navAt = nav?.t0 ?? wall
    const painted = await until(`(() => { const hit = document.querySelector(${JSON.stringify(ready)}); return hit ? performance.now() : 0 })()`, 60_000)
    const badgeAt = Date.now()
    // The probe: wait until the page has asked everything it will ask about a nearer path (or 30 s).
    await sleep(Math.max(0, 30_000 - (Date.now() - wall)))
    const badge = await cdp.send('Runtime.evaluate', { expression: `(document.querySelector('[data-path], .cr-path-badge, .path-badge') || {}).innerText || ''`, returnByValue: true }).catch(() => null)
    const boot = [...seen.values()]
    const bootSummary = summarise(boot, navAt)
    const probeRows = bootSummary.timeline.filter((row) => /rtc\/offer|\/api\/reach|\/api\/hello|verify-hello|path-report|path\/report/.test(row.what))
    // A quiet minute inside the machine.
    const steadyFrom = boot.length
    const steadyStart = Date.now()
    await sleep(steadyMs)
    const steady = [...seen.values()].slice(steadyFrom)
    const steadySummary = summarise(steady, navAt)
    results.push({
      width,
      run,
      target: target.replace(machine, ':machine').replace(workspace ?? '\u0000', ':ws'),
      paintMs: painted === null ? null : Math.round(painted),
      paintWallMs: painted === null ? null : badgeAt - wall,
      badge: badge?.result?.value ?? '',
      boot: { by: bootSummary.by, distinctRelayUrls: bootSummary.distinctRelayUrls, relayRoutes: bootSummary.relayRoutes },
      probe: probeRows,
      timeline: bootSummary.timeline,
      steady: { ms: Date.now() - steadyStart, by: steadySummary.by, distinctRelayUrls: steadySummary.distinctRelayUrls, relayRoutes: steadySummary.relayRoutes }
    })
    console.error(`width ${width} run ${run}: paint ${results.at(-1).paintMs} ms, boot ${JSON.stringify(bootSummary.by)}, steady ${JSON.stringify(steadySummary.by)}`)
  }
}
await close()
console.log(JSON.stringify({ at: new Date().toISOString(), machine: ':machine', results }, null, 1))
