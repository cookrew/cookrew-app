#!/usr/bin/env node
/**
 * The live-machine perf eval: storage, memory and latency of the Cookrew
 * that is actually running on this machine, judged against budgets, with
 * history kept so a RISING number is caught before it is a large one.
 *
 *   node scripts/perf-eval.mjs            # table + exit 1 on any FAIL
 *   node scripts/perf-eval.mjs --json     # the same, as one JSON document
 *   node scripts/perf-eval.mjs --no-probe # skip the HTTP latency probe
 *   node scripts/perf-eval.mjs --no-dom   # skip the headless-Chrome DOM probe
 *
 * Four sections, each honest about its instrument:
 *
 *   STORAGE  walks ~/.cookrew and buckets every byte (team sidecars, served
 *            sessions, turns, events, backup residue …). Finds sidecar files
 *            no team names. Growth is the least-squares slope over the
 *            trailing week of history, in MB/day.
 *   MEMORY   samples RSS of the app's own processes (main, renderer, gpu,
 *            utility) through ps — nothing is injected into the app. Rising
 *            is the slope over the trailing three hours FOR THE SAME PID, in
 *            MB/hour; a restart starts a new line. The main row also carries
 *            the app's own event-loop delay (GET /api/health: p50/p95/p98/max
 *            over its last minute, plus ELU and per-loop tick maxima), so a
 *            stall can be told apart from a loaded machine.
 *   LATENCY  two sources. The event log's own durations (turn.completed,
 *            workspace.switched, terminal.booted) over the trailing day, and
 *            an HTTP probe of the companion API on localhost — N samples per
 *            route, p50/p95/p98, bearer token read from ~/.cookrew and never
 *            printed.
 *   DOM      the companion page — the same React app the desktop runs — in a
 *            headless Chrome at the phone viewport: elements at rest, React
 *            commits and card renders per real pan frame, compositing layers,
 *            and what the board leaves mounted after it closes. See
 *            scripts/perf-dom-probe.mjs. Skipped, and says so, without Chrome
 *            or a running app.
 *
 * History lives in ~/.cookrew/perf-history/*.jsonl. `npm run perf:install`
 * schedules this hourly through launchd; see scripts/perf-eval-install.mjs.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus, homedir, loadavg } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUCKET_POLICY,
  SERVED_GRACE_MS,
  bucketStorage,
  fmtMb,
  fmtMs,
  judge,
  latencyFromEvents,
  loopFromHealth,
  orphanSidecars,
  parsePsTable,
  percentiles,
  pickAppProcesses,
  renderBuckets,
  renderSection,
  servedSessions,
  slopePerHour,
  worstOf
} from './perf-eval-lib.mjs'
import { BUDGETS } from './perf-budgets.mjs'
import { findChrome, probeCompanion } from './perf-dom-probe.mjs'

const MB = 1024 * 1024
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

// ---------------------------------------------------------------------------
// Options and history.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flag = (name) => argv.includes(name)
  const value = (name, fallback) => {
    const i = argv.indexOf(name)
    const next = i >= 0 ? argv[i + 1] : undefined
    return next !== undefined && !next.startsWith('--') ? next : fallback
  }
  const base = value('--base', path.join(homedir(), '.cookrew'))
  return {
    json: flag('--json'),
    probe: !flag('--no-probe'),
    dom: !flag('--no-dom'),
    base,
    history: value('--history', path.join(base, 'perf-history')),
    samples: Math.max(3, Math.min(100, Number(value('--samples', 12)) || 12)),
    port: Number(value('--port', 8639)) || 8639
  }
}

/** History kept per file. Older records are dropped on the next append. */
const HISTORY_KEEP_MS = 30 * DAY

function appendHistory(dir, name, record) {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.jsonl`)
  appendFileSync(file, `${JSON.stringify(record)}\n`)
  // Rewrite without the expired tail. The file is a few KB per day, so the
  // read is cheap; what it buys is a history that cannot grow without bound
  // inside the very store this eval judges for growing without bound.
  const kept = readHistory(dir, name, record.t - HISTORY_KEEP_MS)
  writeFileSync(file, kept.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

function readHistory(dir, name, since) {
  const file = path.join(dir, `${name}.jsonl`)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((r) => r && r.t >= since)
}

// ---------------------------------------------------------------------------
// STORAGE
// ---------------------------------------------------------------------------

/** Every file under root, and — into `dirs`, when given — every directory with its mtime. */
function walkFiles(root, dirs = null) {
  const out = []
  const visit = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (dirs) {
          try {
            dirs.push({ path: path.relative(root, full).split(path.sep).join('/'), mtimeMs: statSync(full).mtimeMs })
          } catch {
            // Removed between readdir and stat. Skip.
          }
        }
        visit(full)
      } else if (entry.isFile()) {
        try {
          const stat = statSync(full)
          out.push({ path: path.relative(root, full).split(path.sep).join('/'), bytes: stat.size, mtimeMs: stat.mtimeMs })
        } catch {
          // Removed between readdir and stat — the store is live. Skip.
        }
      }
    }
  }
  visit(root)
  return out
}

function readTeamSidecars(base) {
  const dir = path.join(base, 'teams')
  if (!existsSync(dir)) return { teams: [], sidecars: [] }
  const teams = []
  const sidecars = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      try {
        const parsed = JSON.parse(readFileSync(path.join(dir, entry.name), 'utf8'))
        teams.push({ slug: entry.name.slice(0, -'.json'.length), sessions: parsed.sessions ?? {} })
      } catch {
        // An unreadable team names nothing — and, conservatively, its sidecar
        // is then reported as orphan, which is the direction to err in a
        // report (never in a deletion).
      }
    } else if (entry.isDirectory() && entry.name.endsWith('-sessions')) {
      const slug = entry.name.slice(0, -'-sessions'.length)
      const files = readdirSync(path.join(dir, entry.name), { withFileTypes: true })
        .filter((f) => f.isFile())
        .map((f) => ({ name: f.name, bytes: statSync(path.join(dir, entry.name, f.name)).size }))
      sidecars.push({ slug, files })
    }
  }
  return { teams, sidecars }
}

function evalStorage(opts, now) {
  const dirs = []
  const files = walkFiles(opts.base, dirs)
  const { buckets, total: everything } = bucketStorage(files)
  // The eval's own history and log live under base; judging them would make
  // the tool count its own output as the store's growth.
  const total = everything - (buckets['perf-history'] ?? 0)
  const { teams, sidecars } = readTeamSidecars(opts.base)
  const orphans = orphanSidecars(teams, sidecars)
  const orphanBytes = orphans.reduce((s, o) => s + o.bytes, 0)
  const served = servedSessions(files, now, dirs)
  const servedPastGrace = served.filter((s) => s.ageMs > SERVED_GRACE_MS)
  const servedPastGraceBytes = servedPastGrace.reduce((s, r) => s + r.bytes, 0)
  appendHistory(opts.history, 'storage', { t: now, total, buckets, orphanBytes, servedPastGraceBytes })
  const week = readHistory(opts.history, 'storage', now - 7 * DAY).map((r) => ({ t: r.t, value: r.total / MB }))
  const slope = slopePerHour(week)
  const growthMbPerDay = slope === null ? null : slope * 24
  const checks = [
    { name: 'total', value: total / MB, unit: 'MB', verdict: judge(total / MB, BUDGETS.storage.totalMb) },
    {
      name: 'growth',
      value: growthMbPerDay,
      unit: 'MB/day',
      verdict: judge(growthMbPerDay, BUDGETS.storage.growthMbPerDay),
      note: growthMbPerDay === null ? `${week.length} sample(s) — needs 3 over 30 min` : ''
    },
    {
      name: 'orphan sidecars',
      value: orphanBytes / MB,
      unit: 'MB',
      verdict: judge(orphanBytes / MB, BUDGETS.storage.orphanSidecarMb),
      note: orphans.length ? `${orphans.length} file(s): ${[...new Set(orphans.map((o) => o.slug))].join(', ')}` : ''
    },
    {
      // Sandboxes older than the sweep's grace that are still on disk: what
      // the NEXT boot sweep would reclaim (an upper bound — an open session
      // is kept whatever its age, and the eval cannot see which are open).
      // The sweep runs only at boot, so on a machine that stays up this
      // climbs until a restart; the budget warns at a size, not at any.
      name: 'served sessions past grace',
      value: servedPastGraceBytes / MB,
      unit: 'MB',
      verdict: judge(servedPastGraceBytes / MB, BUDGETS.storage.servedPastGraceMb),
      note: servedPastGrace.length
        ? `${servedPastGrace.length} of ${served.length} sandbox(es) older than 30 d — the next boot sweep reclaims those not open`
        : `${served.length} sandbox(es), none past grace — ${BUCKET_POLICY['served-sessions']}`
    },
    {
      name: 'backup residue',
      value: (buckets.backups ?? 0) / MB,
      unit: 'MB',
      verdict: judge((buckets.backups ?? 0) / MB, BUDGETS.storage.backupsMb),
      note: buckets.backups ? `*.bak-* / lineage-*: ${BUCKET_POLICY.backups}` : ''
    }
  ]
  // Only the two aggregates leave this function. A per-sandbox row is keyed
  // <service>/<account>-<ordinal>, and this report lands in
  // ~/.cookrew/perf-history/last-report.json and on stdout under --json —
  // both readable by a served caller's agent (Seatbelt denies sessions/, not
  // perf-history/). Listing every caller's account id there would be the
  // cross-tenant leak the sibling deny in session-sandbox.ts exists to stop.
  const servedSummary = { sandboxes: served.length, pastGrace: servedPastGrace.length, pastGraceBytes: servedPastGraceBytes }
  return { total, buckets, orphans, served: servedSummary, growthMbPerDay, checks, verdict: worstOf(checks.map((c) => c.verdict)) }
}

// ---------------------------------------------------------------------------
// MEMORY
// ---------------------------------------------------------------------------

async function evalMemory(opts, now) {
  let table = ''
  try {
    table = execFileSync('ps', ['-Ao', 'pid,ppid,rss,etime,args'], { encoding: 'utf8', maxBuffer: 64 * MB })
  } catch (error) {
    return { processes: [], checks: [], verdict: 'ok', note: `ps failed: ${error.message}` }
  }
  const processes = pickAppProcesses(parsePsTable(table))
  const health = processes.length ? await probeHealth(opts) : { loop: null, note: '' }
  for (const p of processes) {
    const loop = p.role === 'main' && health.loop ? { loop: health.loop } : {}
    appendHistory(opts.history, 'memory', { t: now, ...p, ...loop })
  }
  const recent = readHistory(opts.history, 'memory', now - 3 * HOUR)
  const load = loadPerCore()
  const capped = (verdict) => (load > LOADED_PER_CORE && verdict === 'fail' ? 'warn' : verdict)
  const checks = []
  for (const p of processes) {
    const budget = BUDGETS.memory.rssMb[p.role]
    checks.push({ name: `${p.role} rss (pid ${p.pid})`, value: p.rssMb, unit: 'MB', verdict: judge(p.rssMb, budget) })
    if (p.role === 'main') checks.push(loopCheck(p, health, load, capped))
    const line = recent.filter((r) => r.pid === p.pid).map((r) => ({ t: r.t, value: r.rssMb }))
    const slope = slopePerHour(line)
    checks.push({
      name: `${p.role} rising (pid ${p.pid})`,
      value: slope,
      unit: 'MB/h',
      verdict: judge(slope, BUDGETS.memory.risingMbPerHour),
      note: slope === null ? `${line.length} sample(s) — needs 3 over 30 min` : ''
    })
  }
  if (processes.length === 0) checks.push({ name: 'app', value: null, unit: '', verdict: 'ok', note: 'not running' })
  return { processes, loop: health.loop, checks, verdict: worstOf(checks.map((c) => c.verdict)) }
}

/**
 * The main process's own event loop, read from GET /api/health. Absent on a
 * build without the route (404), an unpaired store, or a --no-probe run —
 * reported as a note, never as a failure, because a missing instrument is
 * not a slow app.
 */
async function probeHealth(opts) {
  if (!opts.probe) return { loop: null, note: 'probe skipped' }
  const token = readToken(opts.base)
  if (!token) return { loop: null, note: 'no pairing token' }
  try {
    const res = await fetch(`http://127.0.0.1:${opts.port}/api/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (res.status === 404) return { loop: null, note: 'no /api/health in this build' }
    if (res.status !== 200) return { loop: null, note: `health answered ${res.status}` }
    const loop = loopFromHealth(await res.json())
    return loop ? { loop, note: '' } : { loop: null, note: 'health body unrecognised' }
  } catch {
    return { loop: null, note: 'app not answering' }
  }
}

function loopCheck(p, health, load, capped) {
  const name = `main loop delay (pid ${p.pid})`
  if (!health.loop) return { name, value: null, unit: '', verdict: 'ok', note: health.note }
  const { loop } = health
  const verdict = judge(loop.p95, BUDGETS.memory.loopDelayP95Ms)
  const worstLoop = Object.entries(loop.loops).sort((a, b) => b[1].max - a[1].max)[0]
  const elu = loop.elu === null ? '' : ` busy ${Math.round(loop.elu * 100)}%`
  const held = worstLoop ? ` · ${worstLoop[0]} max ${fmtMs(worstLoop[1].max)}` : ''
  const shaped = load > LOADED_PER_CORE && verdict !== 'ok' ? ` (load ${load.toFixed(1)}/core — capped at WARN)` : ''
  return {
    name,
    value: loop.p95,
    unit: 'ms p95',
    verdict: capped(verdict),
    note:
      `${loop.window} n=${loop.samples} p50=${fmtMs(loop.p50)} p98=${fmtMs(loop.p98)} ` +
      `max=${fmtMs(loop.max)}${elu}${held}${shaped}`
  }
}

// ---------------------------------------------------------------------------
// LATENCY
// ---------------------------------------------------------------------------

function eventLogLines(base) {
  if (!existsSync(base)) return []
  return readdirSync(base)
    .filter((f) => /^events(\.\d+)?\.jsonl$/.test(f))
    .flatMap((f) => readFileSync(path.join(base, f), 'utf8').split('\n'))
}

function readToken(base) {
  try {
    return readFileSync(path.join(base, 'pairing-token'), 'utf8').trim()
  } catch {
    return null
  }
}

/** Per-request cap. 10 s × (samples + 1) × routes stays well inside the hourly slot and the lock. */
const REQUEST_TIMEOUT_MS = 10_000
/** Between samples, so the probe measures the app and not its own queue. */
const PACE_MS = 100

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchOnce(url, token) {
  const started = performance.now()
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    const body = await res.arrayBuffer()
    return { ms: performance.now() - started, status: res.status, bytes: body.byteLength }
  } catch {
    return { ms: performance.now() - started, status: 0, bytes: 0 }
  }
}

/**
 * One route: a discarded warm-up (the first hit pays the git-enrich cache and
 * the route's own lazy work), then `samples` paced requests. Errors are
 * counted, never averaged in — a timeout is not a latency.
 */
async function probeRoute(url, token, samples) {
  await fetchOnce(url, token)
  const times = []
  let worstStatus = 200
  let errors = 0
  let bytes = 0
  for (let i = 0; i < samples; i += 1) {
    await sleep(PACE_MS)
    const hit = await fetchOnce(url, token)
    if (hit.status === 0) {
      errors += 1
      continue
    }
    if (hit.status !== 200) worstStatus = hit.status
    bytes = hit.bytes
    times.push(hit.ms)
  }
  return { status: worstStatus, errors, bytes, stats: percentiles(times) }
}

/**
 * Above this one-minute load per core, an API p95 says more about the
 * machine than the app: at load 25-40/core (a full agent fleet on the
 * owner's box) a 2 KB route answered in 19 ms at p50 and 3 s at p95. The
 * number is still reported and kept in history; the verdict is capped at
 * WARN so the hourly job does not cry regression at a busy afternoon.
 */
const LOADED_PER_CORE = 4

const loadPerCore = () => loadavg()[0] / Math.max(1, cpus().length)

async function evalLatency(opts, now) {
  const checks = []
  const load = loadPerCore()
  const underLoad = load > LOADED_PER_CORE
  const capped = (verdict) => (underLoad && verdict === 'fail' ? 'warn' : verdict)
  // Named only on a row the load may have shaped; a clean row stays clean.
  const withLoad = (verdict) => (underLoad && verdict !== 'ok' ? ` (load ${load.toFixed(1)}/core — capped at WARN)` : '')
  const events = latencyFromEvents(eventLogLines(opts.base), now - DAY)
  for (const [type, stats] of Object.entries(events)) {
    const budget = BUDGETS.latency.events[type]?.p95
    checks.push({
      name: `event ${type}`,
      value: stats.p95,
      unit: 'ms p95',
      verdict: judge(stats.p95, budget),
      note: `n=${stats.count} p50=${fmtMs(stats.p50)} p98=${fmtMs(stats.p98)}${budget ? '' : ' (reported only)'}`
    })
  }
  const api = {}
  const token = readToken(opts.base)
  if (opts.probe && token) {
    const routes = Object.entries(BUDGETS.latency.api)
    for (const [index, [route, budget]] of routes.entries()) {
      const result = await probeRoute(`http://127.0.0.1:${opts.port}${route}`, token, opts.samples)
      if (result.stats === null) {
        // Every sample failed. On the FIRST route that means nobody is
        // listening; later it is that route's own problem, and the rest
        // still get probed.
        if (index === 0) {
          checks.push({ name: `api ${route}`, value: null, unit: '', verdict: 'ok', note: 'unreachable — app not running?' })
          break
        }
        checks.push({ name: `api ${route}`, value: null, unit: '', verdict: capped('fail'), note: `${result.errors} of ${opts.samples} requests failed${withLoad('fail')}` })
        continue
      }
      api[route] = result
      const broken = result.status !== 200 || result.errors > 0
      const verdict = broken ? 'fail' : judge(result.stats.p95, budget.p95)
      checks.push({
        name: `api ${route}`,
        value: result.stats.p95,
        unit: 'ms p95',
        verdict: capped(verdict),
        note: `${result.status} ${fmtMb(result.bytes)} n=${result.stats.count}${result.errors ? ` errors=${result.errors}` : ''} p50=${fmtMs(result.stats.p50)} p98=${fmtMs(result.stats.p98)}${withLoad(verdict)}`
      })
    }
  } else if (opts.probe) {
    checks.push({ name: 'api', value: null, unit: '', verdict: 'ok', note: 'no pairing token — probe skipped' })
  }
  appendHistory(opts.history, 'latency', {
    t: now,
    loadPerCore: load,
    events,
    api: Object.fromEntries(Object.entries(api).map(([r, v]) => [r, v.stats]))
  })
  return { events, api, loadPerCore: load, checks, verdict: worstOf(checks.map((c) => c.verdict)) }
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const skippedDom = (note) => ({
  checks: [{ name: 'dom', value: null, unit: '', verdict: 'ok', note }],
  verdict: 'ok'
})

/**
 * A pan is 30 real mouse moves out and 30 back; the counts are per frame of
 * that gesture, so they do not depend on how fast this machine is — a loaded
 * box pans in fewer frames per second, not in more renders per frame.
 */
async function evalDom(opts, now) {
  if (!opts.dom) return skippedDom('skipped (--no-dom)')
  if (!findChrome()) return skippedDom('no Chrome — probe skipped (COOKREW_CHROME to name one)')
  const token = readToken(opts.base)
  if (!token) return skippedDom('no pairing token — probe skipped')
  try {
    const res = await fetch(`http://127.0.0.1:${opts.port}/api/workspaces`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!res.ok) return skippedDom(`app answered ${res.status} — probe skipped`)
  } catch {
    return skippedDom('unreachable — app not running?')
  }
  let result
  try {
    result = await probeCompanion({ viewport: 'phone', apiPort: opts.port, frames: 30, token })
  } catch (error) {
    return { checks: [{ name: 'dom', value: null, unit: '', verdict: 'warn', note: `probe failed: ${error.message}` }], verdict: 'warn' }
  }
  const pan = result.pan
  const cardRendersPerFrame = pan ? (pan.renders.NodeWrapper ?? 0) / Math.max(1, pan.frames) : null
  const residue = result.board ? result.board.closed.dom.total - result.rest.dom.total : null
  const record = {
    t: now,
    viewport: result.viewport,
    nodes: result.workspace?.nodes ?? null,
    elements: result.rest.dom.total,
    cards: result.rest.dom.cards,
    layers: result.rest.layers.count,
    heapMb: result.rest.metrics.jsHeapUsedMb,
    commitsPerPanFrame: pan?.commitsPerFrame ?? null,
    cardRendersPerPanFrame: cardRendersPerFrame,
    boardResidueElements: residue
  }
  appendHistory(opts.history, 'dom', record)
  const shape = result.workspace ? `${result.workspace.nodes} nodes, ${result.rest.dom.cards} cards on stage` : ''
  const checks = [
    { name: 'elements at rest', value: record.elements, unit: '', verdict: judge(record.elements, BUDGETS.dom.elements), note: shape },
    {
      name: 'card renders per pan frame',
      value: cardRendersPerFrame,
      unit: '/frame',
      verdict: judge(cardRendersPerFrame, BUDGETS.dom.cardRendersPerPanFrame),
      note: pan ? `${pan.renders.NodeWrapper ?? 0} over ${pan.frames} frames` : 'no pane point — pan skipped'
    },
    {
      name: 'commits per pan frame',
      value: pan?.commitsPerFrame ?? null,
      unit: '/frame',
      verdict: judge(pan?.commitsPerFrame ?? null, BUDGETS.dom.commitsPerPanFrame),
      note: pan ? `${pan.commits} commits; idle ${result.idle?.commits ?? 0} in 3 s` : ''
    },
    { name: 'compositing layers', value: record.layers, unit: '', verdict: judge(record.layers, BUDGETS.dom.layers), note: result.rest.layers.backingMb === null ? 'layer tree not reported' : `${fmtMb(result.rest.layers.backingMb * MB)} backing` },
    {
      name: 'board residue',
      value: residue,
      unit: 'elements',
      verdict: judge(residue, BUDGETS.dom.boardResidueElements),
      note: result.board ? `${result.board.open.dom.total} open → ${result.board.closed.dom.total} closed` : 'board not found'
    }
  ]
  return { record, checks, verdict: worstOf(checks.map((c) => c.verdict)) }
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

/**
 * One run at a time. mkdir is atomic, so the directory is the lock; a lock
 * older than the longest possible run is a crash's leftover and is taken.
 */
const LOCK_STALE_MS = 45 * 60 * 1000

function acquireLock(dir) {
  const lock = path.join(dir, '.lock')
  mkdirSync(dir, { recursive: true })
  const take = () => {
    mkdirSync(lock)
    return () => rmSync(lock, { recursive: true, force: true })
  }
  try {
    return take()
  } catch {
    const age = Date.now() - statSync(lock).mtimeMs
    if (age < LOCK_STALE_MS) return null
    rmSync(lock, { recursive: true, force: true })
    return take()
  }
}

export async function run(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  const release = acquireLock(opts.history)
  if (!release) {
    process.stdout.write(`perf eval already running (lock in ${opts.history}) — skipped\n`)
    return 0
  }
  try {
    return await runLocked(opts)
  } finally {
    release()
  }
}

async function runLocked(opts) {
  const now = Date.now()
  const storage = evalStorage(opts, now)
  const memory = await evalMemory(opts, now)
  const latency = await evalLatency(opts, now)
  const dom = await evalDom(opts, now)
  const verdict = worstOf([storage.verdict, memory.verdict, latency.verdict, dom.verdict])
  const report = { at: new Date(now).toISOString(), verdict, storage, memory, latency, dom }
  mkdirSync(opts.history, { recursive: true })
  writeFileSync(path.join(opts.history, 'last-report.json'), JSON.stringify(report, null, 2))
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(
      [
        `cookrew perf eval ${report.at} — ${verdict.toUpperCase()} (load ${latency.loadPerCore.toFixed(1)}/core)`,
        '',
        renderSection('STORAGE', storage),
        renderBuckets(storage.buckets),
        '',
        renderSection('MEMORY', memory),
        '',
        renderSection('LATENCY', latency),
        '',
        renderSection('DOM', dom),
        '',
        `history: ${opts.history}`
      ].join('\n') + '\n'
    )
  }
  return verdict === 'fail' ? 1 : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().then(
    (code) => process.exit(code),
    (error) => {
      console.error('perf eval failed:', error)
      process.exit(2)
    }
  )
}
