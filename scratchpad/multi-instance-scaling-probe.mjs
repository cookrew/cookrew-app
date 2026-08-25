#!/usr/bin/env -S node_modules/.bin/vite-node

// Baseline for step 2 of the multi-instance refactor (marketplace §11).
//
// Step 2 scopes the PTY and browser runtimes per session, which means N
// workspaces hold live runtimes at once instead of one. That multiplies
// `attached` — the exact term behind wave C's blow-up, where cost was
// O(attached x panes) and two leaked flags took /api/activity from 190ms to
// 6.85s with herdr at 74% CPU (ef5e13c post-mortem).
//
// So this measures, BEFORE any scoping code is written:
//
//   1. What the app is holding right now (workspaces, panes, terminals).
//   2. The A x P curve: resolving K pane labels the UNBATCHED way (one
//      `herdr pane list` fork per label, the shape a1e0dd6 fixed and ef5e13c
//      reverted) against the BATCHED way (one snapshot, resolved in memory,
//      which is what beginAttachBatch does today). The ratio is the tax that
//      N resident sessions would multiply if a batch is ever skipped.
//   3. Live cost at the current ONE resident session: /api/activity and
//      /api/state latency, plus herdr server and Electron main CPU/RSS.
//
// Read-only. Nothing is written to app state, panes, sessions, tokens or logs;
// every herdr call is `pane list`, every HTTP call is a GET.
//
//   node_modules/.bin/vite-node scratchpad/multi-instance-scaling-probe.mjs

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const HOME = os.homedir()
const COOKREW_HOME = path.join(HOME, '.cookrew')
const HERDR_SESSION = process.env.HERDR_SESSION ?? 'cookrew'
const PORT = Number(process.env.COOKREW_PERF_PORT ?? 8639)
const SAMPLES = Number(process.env.COOKREW_PERF_SAMPLES ?? 12)
const CPU_SECONDS = Number(process.env.COOKREW_PERF_CPU_SECONDS ?? 15)
const CURVE_RUNS = Number(process.env.COOKREW_PERF_CURVE_RUNS ?? 3)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const round = (v, d = 1) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null)

function stats(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  return {
    n: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1])
  }
}

function execText(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...options })
}

function tryText(file, args, options = {}) {
  try {
    return execText(file, args, options)
  } catch {
    return ''
  }
}

// ---- 1. inventory ----------------------------------------------------------

function inventory() {
  const registry = JSON.parse(fs.readFileSync(path.join(COOKREW_HOME, 'registry.json'), 'utf8'))
  const workspaces = []
  let terminals = 0
  for (const meta of registry.workspaces ?? []) {
    const file = path.join(COOKREW_HOME, 'workspaces', meta.id, 'workspace.json')
    if (!fs.existsSync(file)) continue
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    const counts = { terminal: 0, note: 0, browser: 0 }
    for (const node of state.nodes ?? []) {
      if (node.kind in counts) counts[node.kind] += 1
    }
    terminals += counts.terminal
    workspaces.push({
      name: meta.name,
      focused: meta.id === registry.activeId,
      ...counts,
      stateKb: round(fs.statSync(file).size / 1024)
    })
  }
  return { workspaces, totalTerminals: terminals }
}

// ---- 2. the A x P curve ----------------------------------------------------

function readPanes() {
  const raw = execText('herdr', ['pane', 'list'], { env: { ...process.env, HERDR_SESSION } })
  const parsed = JSON.parse(raw)
  return parsed.result?.panes ?? parsed.panes ?? []
}

/**
 * Cost of resolving K pane labels, unbatched vs batched.
 *
 * UNBATCHED repeats herdr's global inventory once per label — the pre-a1e0dd6
 * shape, and the shape any per-session code that forgets its attach batch
 * would fall back into. BATCHED reads one snapshot and resolves in memory,
 * which is what beginAttachBatch()/attachSnapshot does today.
 *
 * The multiplier matters because step 2 makes K grow with resident sessions,
 * not just with the focused workspace's terminal count.
 */
function attachCurve(paneLabels) {
  const ks = [...new Set([1, 5, 10, 20, paneLabels.length])]
    .filter((k) => k > 0 && k <= paneLabels.length)
    .sort((a, b) => a - b)

  return ks.map((k) => {
    const wanted = paneLabels.slice(0, k)
    const unbatched = []
    const batched = []
    for (let run = 0; run < CURVE_RUNS; run += 1) {
      let started = performance.now()
      for (const label of wanted) readPanes().find((p) => p.label === label)
      unbatched.push(performance.now() - started)

      started = performance.now()
      const byLabel = new Map(readPanes().map((p) => [p.label, p]))
      for (const label of wanted) byLabel.get(label)
      batched.push(performance.now() - started)
    }
    const u = stats(unbatched)
    const b = stats(batched)
    return {
      labels: k,
      paneListForks: { unbatched: k, batched: 1 },
      unbatchedMs: u,
      batchedMs: b,
      multiplier: round((u?.p50 ?? 0) / (b?.p50 || 1), 1)
    }
  })
}

// ---- 3. live cost at ONE resident session ----------------------------------

function pairingToken() {
  const file = path.join(COOKREW_HOME, 'pairing-token.json')
  if (!fs.existsSync(file)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof raw === 'string' ? raw : (raw.token ?? null)
  } catch {
    return null
  }
}

function get(pathname, token) {
  return new Promise((resolve) => {
    const started = performance.now()
    const request = http.get(
      { host: '127.0.0.1', port: PORT, path: pathname, headers: token ? { authorization: `Bearer ${token}` } : {} },
      (response) => {
        response.resume()
        response.on('end', () => resolve({ ms: performance.now() - started, status: response.statusCode }))
      }
    )
    request.on('error', () => resolve({ ms: performance.now() - started, status: 0 }))
    request.setTimeout(15_000, () => {
      request.destroy()
      resolve({ ms: performance.now() - started, status: 0 })
    })
  })
}

async function routeLatency(token) {
  const out = {}
  for (const route of ['/api/state', '/api/activity', '/api/board']) {
    const durations = []
    let status = null
    for (let i = 0; i < SAMPLES; i += 1) {
      const result = await get(route, token)
      durations.push(result.ms)
      status = result.status
    }
    out[route] = { status, ms: stats(durations) }
  }
  return out
}

function processRows() {
  const raw = execText('ps', ['-ww', '-axo', 'pid=,%cpu=,rss=,command='])
  return raw.split('\n').flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/)
    return m ? [{ pid: Number(m[1]), cpu: Number(m[2]), rssMb: Number(m[3]) / 1024, command: m[4] }] : []
  })
}

function discover() {
  const rows = processRows()
  const find = (p) => rows.find(p)?.pid ?? null
  return {
    electronMain: find((r) => /Electron\.app\/Contents\/MacOS\/Electron \.$/.test(r.command)),
    herdrServer: find((r) => /^herdr server\b/.test(r.command))
  }
}

async function sampleCpu(pids) {
  const samples = Object.fromEntries(Object.keys(pids).map((k) => [k, []]))
  for (let tick = 0; tick < CPU_SECONDS; tick += 1) {
    const byPid = new Map(processRows().map((r) => [r.pid, r]))
    for (const [name, pid] of Object.entries(pids)) {
      const row = byPid.get(pid)
      if (row) samples[name].push(row)
    }
    if (tick + 1 < CPU_SECONDS) await sleep(1000)
  }
  return Object.fromEntries(
    Object.entries(samples).map(([name, rows]) => [
      name,
      { pid: pids[name], cpuPct: stats(rows.map((r) => r.cpu)), rssMb: stats(rows.map((r) => r.rssMb)) }
    ])
  )
}

// ---- run -------------------------------------------------------------------

const inv = inventory()
const panes = readPanes()
const labels = panes.map((p) => p.label).filter(Boolean)
const token = pairingToken()
const pids = discover()

console.error(`[probe] ${inv.workspaces.length} workspaces, ${inv.totalTerminals} terminals, ${panes.length} panes`)
console.error(`[probe] sampling CPU for ${CPU_SECONDS}s...`)

const [routes, processes] = await Promise.all([routeLatency(token), sampleCpu(pids)])
const curve = attachCurve(labels)

console.log(
  JSON.stringify(
    {
      at: new Date().toISOString(),
      note: 'BASELINE at one resident session, before step 2 runtime scoping',
      inventory: inv,
      herdr: { session: HERDR_SESSION, panes: panes.length },
      attachCurve: curve,
      routes,
      processes,
      tokenFound: token !== null
    },
    null,
    2
  )
)
