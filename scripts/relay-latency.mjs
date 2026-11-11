#!/usr/bin/env node
/**
 * THE RELAY, TIMED FROM WHERE A PERSON SITS (latency 0.6.1).
 *
 * Read-only calls through `<api>/api/m/<machine>/<route>`, the way the console
 * and the desktop make them: one HTTP/2 connection (through the system's HTTP
 * proxy when HTTPS_PROXY is set, as Chrome does on the owner's Mac), the
 * account session in its header, the machine key this Mac holds as
 * `authorization`. Nothing here writes to a machine: GET and OPTIONS only.
 *
 *   node scripts/relay-latency.mjs --machine <id> [--api https://api.cookrew.dev]
 *        [--n 120] [--big api/workspace] [--sse api/events] [--sse-ms 30000]
 *        [--cold 8] [--only rtt,relay,burst,cold,big,sse]
 *
 * Secrets are read from ~/.cookrew/account.json (session) and
 * ~/.cookrew/machine-keys.json (the key for --machine) and never printed.
 * Prints one JSON object: every number in milliseconds unless named otherwise.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import http2 from 'node:http2'
import tls from 'node:tls'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i]
  if (!key.startsWith('--')) continue
  const next = process.argv[i + 1]
  args.set(key.slice(2), next !== undefined && !next.startsWith('--') ? (i += 1, next) : 'true')
}
const api = new URL(args.get('api') ?? 'https://api.cookrew.dev')
const machine = String(args.get('machine') ?? '').toLowerCase()
if (!/^[0-9a-f-]{36}$/.test(machine)) {
  console.error('usage: --machine <machine id>')
  process.exit(2)
}
const n = Number(args.get('n') ?? 120)
const coldN = Number(args.get('cold') ?? 8)
const only = new Set(String(args.get('only') ?? 'rtt,relay,burst,cold,big,sse').split(','))
const bigRoute = String(args.get('big') ?? 'api/workspace')
const sseRoute = String(args.get('sse') ?? 'api/events')
const sseMs = Number(args.get('sse-ms') ?? 30_000)
const smallRoute = String(args.get('small') ?? 'api/reach')
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? null

const home = homedir()
const session = JSON.parse(readFileSync(path.join(home, '.cookrew/account.json'), 'utf8')).session?.token
const key = JSON.parse(readFileSync(path.join(home, '.cookrew/machine-keys.json'), 'utf8'))[machine]?.token
if (typeof session !== 'string' || typeof key !== 'string') {
  console.error('no session or no machine key on this Mac for that machine')
  process.exit(2)
}

const now = () => performance.now()
const pct = (values, p) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))] * 10) / 10
}
const summary = (values) => ({ n: values.length, p50: pct(values, 50), p95: pct(values, 95), p99: pct(values, 99), max: pct(values, 100), min: pct(values, 0) })

/** A TLS socket to the API host, through an HTTP CONNECT proxy when one is set. */
async function tlsSocket() {
  const port = Number(api.port || 443)
  const started = now()
  let raw
  if (proxy) {
    const via = new URL(proxy)
    raw = await new Promise((resolve, reject) => {
      const request = http.request({ host: via.hostname, port: Number(via.port), method: 'CONNECT', path: `${api.hostname}:${port}` })
      request.on('connect', (response, socket) => (response.statusCode === 200 ? resolve(socket) : reject(new Error(`proxy said ${response.statusCode}`))))
      request.on('error', reject)
      request.end()
    })
  }
  const tunnelled = now()
  const socket = await new Promise((resolve, reject) => {
    const secure = tls.connect({ host: api.hostname, servername: api.hostname, port, ALPNProtocols: ['h2'], ...(raw ? { socket: raw } : {}) }, () => resolve(secure))
    secure.on('error', reject)
  })
  return { socket, ms: { tunnel: tunnelled - started, tls: now() - tunnelled, total: now() - started } }
}

async function connect() {
  const { socket, ms } = await tlsSocket()
  // Chrome's receive windows (6 MB a stream, 15 MB the connection): Node's default 64 KB would make
  // this script, not the path, the limit on a large reply at a long round trip.
  const client = http2.connect(api.origin, { createConnection: () => socket, settings: { initialWindowSize: 6 * 1024 * 1024 } })
  await new Promise((resolve, reject) => {
    client.once('connect', resolve)
    client.once('error', reject)
  })
  client.setLocalWindowSize(15 * 1024 * 1024)
  return { client, ms }
}

const relayPath = (route) => `/api/m/${machine}/${route.replace(/^\/+/, '')}`
const relayHeaders = (extra = {}) => ({
  'x-cookrew-session': session,
  authorization: `Bearer ${key}`,
  origin: 'https://console.cookrew.dev',
  ...extra
})

/** One request on a connection: time to head, to last byte, and how many bytes. */
function request(client, headers, { stopAfterMs = null, onChunk = null } = {}) {
  return new Promise((resolve, reject) => {
    const started = now()
    let head = null
    let bytes = 0
    let status = 0
    // A browser never writes the default port; the registry matches its host exactly.
    const stream = client.request({ ':authority': api.host, ...headers })
    let timer = null
    if (stopAfterMs !== null) timer = setTimeout(() => stream.close(http2.constants.NGHTTP2_CANCEL), stopAfterMs)
    stream.on('response', (h) => {
      head = now() - started
      status = Number(h[':status'])
    })
    stream.on('data', (chunk) => {
      bytes += chunk.byteLength
      onChunk?.(now() - started, chunk)
    })
    stream.on('close', () => {
      if (timer) clearTimeout(timer)
      resolve({ status, head, total: now() - started, bytes })
    })
    stream.on('error', (error) => {
      if (timer) clearTimeout(timer)
      if (head !== null) resolve({ status, head, total: now() - started, bytes })
      else reject(error)
    })
    stream.end()
  })
}

const preflight = (client, route) =>
  request(client, {
    ':method': 'OPTIONS',
    ':path': relayPath(route),
    origin: 'https://console.cookrew.dev',
    'access-control-request-method': 'GET',
    'access-control-request-headers': 'authorization,x-cookrew-session'
  })
const get = (client, route, extra = {}) => request(client, { ':method': 'GET', ':path': relayPath(route), ...relayHeaders(extra) })

const out = { at: new Date().toISOString(), api: api.origin, proxy: proxy !== null, machine, routes: { small: smallRoute, big: bigRoute, sse: sseRoute } }
const { client, ms: firstConnect } = await connect()
out.firstConnect = firstConnect

if (only.has('rtt')) {
  // The registry alone: a preflight is answered before any session or machine is read.
  const times = []
  for (let i = 0; i < Math.min(n, 60); i += 1) times.push((await preflight(client, smallRoute)).total)
  out.registryOnly = summary(times)
}

if (only.has('relay')) {
  const times = []
  const statuses = new Map()
  for (let i = 0; i < n; i += 1) {
    const one = await get(client, smallRoute)
    statuses.set(one.status, (statuses.get(one.status) ?? 0) + 1)
    times.push(one.total)
  }
  out.relaySmall = { ...summary(times), statuses: Object.fromEntries(statuses) }
}

if (only.has('decomp')) {
  // Where a relayed millisecond goes, interleaved so a drifting route hits each alike:
  //   preflight    the registry and the path to it, nothing read
  //   authOnly     + the session checked (a route the relay does not carry: 404 after the check)
  //   relay        + the machine's line, the machine, and the way back
  const rows = { preflight: [], authOnly: [], relay: [] }
  for (let i = 0; i < Math.min(n, 60); i += 1) {
    rows.preflight.push((await preflight(client, smallRoute)).total)
    rows.authOnly.push((await get(client, 'nope/x')).total)
    rows.relay.push((await get(client, smallRoute)).total)
  }
  out.decomp = Object.fromEntries(Object.entries(rows).map(([name, values]) => [name, summary(values)]))
}

if (only.has('burst')) {
  // What a page does on entering a machine: several reads at once on one connection.
  const rounds = []
  for (let round = 0; round < 5; round += 1) {
    const started = now()
    await Promise.all(Array.from({ length: 8 }, () => get(client, smallRoute)))
    rounds.push(now() - started)
  }
  out.burst8 = summary(rounds)
}

if (only.has('cold')) {
  const times = []
  const firstCall = []
  for (let i = 0; i < coldN; i += 1) {
    const started = now()
    const fresh = await connect()
    times.push(fresh.ms.total)
    await get(fresh.client, smallRoute)
    firstCall.push(now() - started)
    fresh.client.close()
  }
  out.coldConnect = summary(times)
  out.coldFirstCall = summary(firstCall)
}

if (only.has('big')) {
  const runs = []
  for (const encoding of ['identity', 'br, gzip']) {
    for (let i = 0; i < 3; i += 1) {
      const one = await get(client, bigRoute, { 'accept-encoding': encoding })
      runs.push({ encoding, status: one.status, bytes: one.bytes, head: Math.round(one.head), total: Math.round(one.total), kbps: Math.round(one.bytes / 1024 / ((one.total - one.head) / 1000)) })
    }
  }
  out.big = runs
}

if (only.has('sse')) {
  const gaps = []
  let last = null
  let firstByte = null
  const one = await request(
    client,
    { ':method': 'GET', ':path': relayPath(sseRoute), ...relayHeaders({ accept: 'text/event-stream' }) },
    {
      stopAfterMs: sseMs,
      onChunk: (at) => {
        if (firstByte === null) firstByte = at
        if (last !== null) gaps.push(at - last)
        last = at
      }
    }
  )
  out.sse = { status: one.status, head: one.head && Math.round(one.head), firstByte: firstByte && Math.round(firstByte), chunks: gaps.length + (firstByte === null ? 0 : 1), bytes: one.bytes, gaps: summary(gaps) }
}

client.close()
console.log(JSON.stringify(out, null, 2))
