#!/usr/bin/env -S node_modules/.bin/vite-node

// On-demand tail-latency regression gate for main-process operations.
// No live Cookrew app is needed: every run uses isolated temp directories.
//
// Run:
//   node_modules/.bin/vite-node scratchpad/perf-eval-gate.mjs
//
// Re-baseline after an intentional performance change:
//   COOKREW_PERF_SAMPLES=50 node_modules/.bin/vite-node \
//     scratchpad/perf-eval-gate.mjs --measure-only
// Run that three times on an otherwise idle machine. Update BASELINES with
// the worst observed P50/P95, then set THRESHOLDS with at least 2x headroom
// while keeping the legacy numbers below the limits. Never loosen the O(1)
// structural assertions to accommodate a wall-clock regression.

import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const SAMPLES = Number(process.env.COOKREW_PERF_SAMPLES ?? 30)
const MEASURE_ONLY = process.argv.includes('--measure-only')
const BURST_SIZE = 30

if (!Number.isInteger(SAMPLES) || SAMPLES < 20 || SAMPLES > 500) {
  console.error('COOKREW_PERF_SAMPLES must be an integer from 20 to 500')
  process.exit(2)
}

// Quiet-machine measurements on 2026-08-14, Apple Silicon/APFS. Optimized
// values are the WORST P50/P95 from three 50-sample calibration runs.
// The pre-batch values are retained here so a threshold change must still
// distinguish the old O(n^2) implementation from the optimized path.
const BASELINES = {
  paste10: { before: { p50: 3.74, p95: 7.04 }, after: { p50: 0.34, p95: 0.69 } },
  paste30: { before: { p50: 17.57, p95: 22.98 }, after: { p50: 0.31, p95: 0.49 } },
  eventBurst30: { after: { p50: 0.25, p95: 0.42 } }
}

// At least 2x the worst calibrated value, rounded up for scheduler/FS headroom;
// still below every measured legacy paste P50/P95. Structural assertions also
// require zero event writes during append and exactly one write during flush.
const THRESHOLDS = {
  paste10: { p50: 1, p95: 2 },
  paste30: { p50: 1, p95: 2 },
  eventBurst30: { p50: 1, p95: 2 }
}

const realReadFileSync = fs.readFileSync
const realWriteFileSync = fs.writeFileSync
const realAppendFileSync = fs.appendFileSync
let measuringPaste = false
let workspaceReads = 0
let workspaceWrites = 0
let measuringEvents = false
let eventWrites = 0

function isWorkspaceJson(file) {
  return typeof file === 'string' && file.endsWith(`${path.sep}workspace.json`)
}

fs.readFileSync = function countedRead(file, ...args) {
  if (measuringPaste && isWorkspaceJson(file)) workspaceReads += 1
  return realReadFileSync.call(this, file, ...args)
}
fs.writeFileSync = function countedWrite(file, data, ...args) {
  if (measuringPaste && isWorkspaceJson(file)) workspaceWrites += 1
  return realWriteFileSync.call(this, file, data, ...args)
}
fs.appendFileSync = function countedAppend(file, data, ...args) {
  if (measuringEvents) eventWrites += 1
  return realAppendFileSync.call(this, file, data, ...args)
}
syncBuiltinESMExports()

const [{ WorkspaceStore }, { TeamStore, copyTeam }, { EventLog }, { latencyStats }] =
  await Promise.all([
    import('../src/main/store.ts'),
    import('../src/main/teams.ts'),
    import('../src/main/event-log.ts'),
    import('../src/shared/stats.ts')
  ])

function browser(i) {
  return {
    kind: 'browser',
    id: `source-${i}`,
    name: `Page ${i}`,
    url: `https://example.com/${i}`,
    position: { x: (i % 6) * 420, y: Math.floor(i / 6) * 320 },
    size: { width: 400, height: 300 }
  }
}

function event(i) {
  return {
    type: 'terminal.created',
    entityId: `terminal-${i}`,
    entityName: `Agent ${i}`,
    workspaceId: 'perf-workspace',
    workspaceName: 'Perf Eval',
    actor: 'user',
    timestamp: 1_800_000_000_000 + i
  }
}

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function removeRoot(root) {
  fs.rmSync(root, { recursive: true, force: true })
}

async function pasteOnce(n) {
  const root = tempRoot(`cookrew-perf-paste-${n}-`)
  try {
    const store = new WorkspaceStore(root)
    const nodes = Array.from({ length: n }, (_, i) => store.addNode(browser(i)))
    for (let i = 1; i < nodes.length; i += 1) store.connect(nodes[i - 1].id, nodes[i].id)
    const target = store.createWorkspace('Target', '/tmp')
    store.flush()

    const events = []
    store.on('op', (observed) => {
      if (measuringPaste) events.push(observed.type)
    })
    const deps = {
      store,
      turns: { history: () => [] },
      roles: { get: () => undefined },
      teams: new TeamStore(path.join(root, 'teams')),
      ptys: { get: () => undefined },
      switchWorkspace: () => undefined,
      git: {
        gitInfo: async () => ({
          isRepo: false,
          root: null,
          branch: null,
          dirty: false,
          ahead: 0,
          behind: 0
        }),
        addWorktree: async () => ({ ok: false, error: 'disabled' })
      },
      worktreeRoot: path.join(root, 'worktrees')
    }

    workspaceReads = 0
    workspaceWrites = 0
    measuringPaste = true
    const started = performance.now()
    const result = await copyTeam(deps, {
      nodeIds: nodes.map((node) => node.id),
      intoWorkspaceId: target.id
    })
    store.recordEvent('team.copied', result.workspaceId, result.workspaceName, `${n} nodes`)
    const elapsed = performance.now() - started
    measuringPaste = false

    const targetState = store.workspaceState(target.id)
    const structural = {
      nodes: targetState.nodes.length,
      cables: targetState.connections.length,
      reads: workspaceReads,
      writes: workspaceWrites,
      events: events.length
    }
    return { elapsed, structural }
  } finally {
    measuringPaste = false
    removeRoot(root)
  }
}

function eventBurstOnce() {
  const root = tempRoot('cookrew-perf-events-')
  const file = path.join(root, 'events.jsonl')
  try {
    const log = new EventLog(file, { flushMs: 60_000 })
    eventWrites = 0
    measuringEvents = true
    const started = performance.now()
    for (let i = 0; i < BURST_SIZE; i += 1) log.append(event(i))
    const writesBeforeFlush = eventWrites
    log.flush()
    const elapsed = performance.now() - started
    measuringEvents = false
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').length
    return {
      elapsed,
      structural: { writesBeforeFlush, writesTotal: eventWrites, lines }
    }
  } finally {
    measuringEvents = false
    removeRoot(root)
  }
}

async function measure(name, run) {
  await run() // warm module/JIT/filesystem paths; excluded from the sample set
  const durations = []
  const structurals = []
  for (let i = 0; i < SAMPLES; i += 1) {
    const result = await run()
    durations.push(result.elapsed)
    structurals.push(result.structural)
  }
  const stats = latencyStats(durations)
  if (!stats) throw new Error(`${name}: no latency samples`)
  return { name, stats, structurals }
}

function fixed(value) {
  return value.toFixed(2)
}

function checkLatency(result, threshold) {
  const checks = [
    ['P50', result.stats.p50, threshold.p50],
    ['P95', result.stats.p95, threshold.p95]
  ]
  let ok = true
  for (const [label, measured, limit] of checks) {
    const pass = measured <= limit
    ok &&= pass
    console.log(
      `  ${label} ${fixed(measured)} ms <= ${fixed(limit)} ms  ${pass ? 'PASS' : 'FAIL'}`
    )
  }
  return ok
}

function checkStructure(label, values, expected) {
  const pass = values.every((actual) => actual === expected)
  const observed = [...new Set(values)].join(', ')
  console.log(`  ${label} ${observed} == ${expected}  ${pass ? 'PASS' : 'FAIL'}`)
  return pass
}

const paste10 = await measure('team paste n=10', () => pasteOnce(10))
const paste30 = await measure('team paste n=30', () => pasteOnce(30))
const eventBurst = await measure(`event-log burst n=${BURST_SIZE}`, () => eventBurstOnce())

let passed = true
for (const [result, threshold, n] of [
  [paste10, THRESHOLDS.paste10, 10],
  [paste30, THRESHOLDS.paste30, 30]
]) {
  console.log(`${result.name} (${result.stats.count} samples)`)
  passed = checkLatency(result, threshold) && passed
  passed = checkStructure('workspace reads', result.structurals.map((s) => s.reads), 2) && passed
  passed = checkStructure('workspace writes', result.structurals.map((s) => s.writes), 1) && passed
  passed = checkStructure('grouped op events', result.structurals.map((s) => s.events), 1) && passed
  passed = checkStructure('copied nodes', result.structurals.map((s) => s.nodes), n) && passed
  passed = checkStructure('copied cables', result.structurals.map((s) => s.cables), n - 1) && passed
}

console.log(`${eventBurst.name} (${eventBurst.stats.count} samples)`)
passed = checkLatency(eventBurst, THRESHOLDS.eventBurst30) && passed
passed = checkStructure(
  'writes during append',
  eventBurst.structurals.map((s) => s.writesBeforeFlush),
  0
) && passed
passed = checkStructure(
  'batched flush writes',
  eventBurst.structurals.map((s) => s.writesTotal),
  1
) && passed
passed = checkStructure(
  'persisted lines',
  eventBurst.structurals.map((s) => s.lines),
  BURST_SIZE
) && passed

if (MEASURE_ONLY) {
  console.log('\nMEASURE ONLY: thresholds were reported but do not affect the exit code.')
  console.log(`Current committed baselines: ${JSON.stringify(BASELINES)}`)
  process.exit(0)
}

console.log(`\nPERF EVAL GATE: ${passed ? 'PASS' : 'FAIL'}`)
process.exit(passed ? 0 : 1)
