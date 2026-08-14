#!/usr/bin/env -S node_modules/.bin/vite-node

// Isolated attribution probe for the synchronous workspace-switch reattach path.
// It owns a timestamped herdr session and inert long-running "agents" only.
// No live Cookrew pane or server is read, attached, stopped, or modified.

import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import os from 'node:os'
import path from 'node:path'

const N = Number(process.env.COOKREW_SWITCH_TERMINALS ?? 10)
const RUNS = Number(process.env.COOKREW_SWITCH_RUNS ?? 8)
const AMBIGUOUS = process.env.COOKREW_SWITCH_AMBIGUOUS === '1'
const REAL_PTY = process.env.COOKREW_SWITCH_REAL_PTY === '1'
const session = `cookrewsw${process.pid}`
const root = path.join(os.tmpdir(), session)
const configPath = path.join(root, 'cookrew.herdr.toml')
const cliDir = path.join(root, 'cli')
const env = { ...process.env, HERDR_SESSION: session, HERDR_CONFIG_PATH: configPath }
const pty = REAL_PTY ? createRequire(import.meta.url)('node-pty') : null

if (!Number.isInteger(N) || N < 1 || N > 50 || !Number.isInteger(RUNS) || RUNS < 1 || RUNS > 50) {
  console.error('COOKREW_SWITCH_TERMINALS=1..50 and COOKREW_SWITCH_RUNS=1..50')
  process.exit(2)
}

rmSync(root, { recursive: true, force: true })
mkdirSync(cliDir, { recursive: true })
writeFileSync(
  configPath,
  [
    'onboarding = false',
    '[ui]',
    'sidebar_start_collapsed = true',
    'sidebar_collapsed_mode = "hidden"',
    'hide_tab_bar_when_single_tab = true',
    'pane_borders = false',
    'pane_scrollbars = false',
    'pane_gaps = false',
    'host_cursor = "native"'
  ].join('\n')
)

// Herdr recognizes the process as a Claude pane, while the payload performs no
// network or model work. The executable name is also the exact token the husk
// guard expects in the pane root argv.
const inertAgent = path.join(cliDir, 'claude')
writeFileSync(inertAgent, '#!/bin/sh\nwhile :; do sleep 3600; done\n')
chmodSync(inertAgent, 0o755)

const { HerdrHostMultiplexer } = await import('../src/main/herdr-host-multiplexer.ts')
const { latencyStats } = await import('../src/shared/stats.ts')

const calls = []
let phase = 'setup'
const timed = (kind, file, args, fn) => {
  const started = performance.now()
  try {
    return fn()
  } finally {
    calls.push({ phase, kind, command: `${path.basename(file)} ${args.slice(0, 2).join(' ')}`, ms: performance.now() - started })
  }
}
const runner = {
  run: (file, args) => timed('run', file, args, () =>
    execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env })
  ),
  runQuiet: (file, args) => timed('quiet', file, args, () => {
    try {
      execFileSync(file, args, { stdio: 'ignore', env })
    } catch {
      // Matches the production best-effort runner contract.
    }
  }),
  probe: (file, args) => timed('probe', file, args, () => {
    try {
      return spawnSync(file, args, { stdio: 'ignore', env }).status === 0
    } catch {
      return false
    }
  })
}

const mux = new HerdrHostMultiplexer({ session, configPath, runner })
const spec = (i) => ({
  sessionName: `cookrew_sw${i}`,
  command: inertAgent,
  shell: '/bin/zsh',
  terminalId: `switch-${i}`,
  socketPath: path.join(root, 'cookrew.sock'),
  cliDir,
  path: `${cliDir}:${process.env.PATH ?? ''}`,
  cwd: root,
  card: {
    title: `Agent ${i}`,
    agent: 'claude',
    terminalId: `switch-${i}`,
    workspace: 'probe',
    cwd: root
  }
})

// A safe reproduction of the historical tail: the pane remains alive and
// attachable as the inert "claude", while the node now expects "codex". The
// husk guard correctly refuses to type into that ambiguous root, but before
// batching it spends a fresh settle window on every terminal, serially.
const warmSpec = (i) => AMBIGUOUS ? { ...spec(i), command: 'codex' } : spec(i)

function summarize(label, samples) {
  const stats = latencyStats(samples)
  console.log(`${label}: n=${stats?.count} p50=${stats?.p50.toFixed(2)}ms p95=${stats?.p95.toFixed(2)}ms max=${stats?.max.toFixed(2)}ms`)
}

function statusRefresh() {
  // Production refresh synchronously resolves the socket and lists every pane
  // before opening its asynchronous subscription socket.
  execFileSync('herdr', ['session', 'list', '--json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env
  })
  execFileSync('herdr', ['pane', 'list'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env
  })
}

const warmTotals = []
const refreshTotals = []
const coalescedRefreshTotals = []
const ptyDetachTotals = []
let exactRoots = true
try {
  phase = 'cold'
  for (let i = 0; i < N; i += 1) {
    mux.ensureSession(spec(i))
    mux.attachSpawn(spec(i))
  }

  // Give the inert roots time to replace their boot shells before warm checks.
  await new Promise((resolve) => setTimeout(resolve, 750))
  const rootsBefore = REAL_PTY
    ? Array.from({ length: N }, (_, i) => mux.panePid(spec(i).sessionName))
    : []

  for (let run = 0; run < RUNS; run += 1) {
    const clients = []
    phase = `warm-${run}`
    const started = performance.now()
    mux.beginAttachBatch?.()
    try {
      for (let i = 0; i < N; i += 1) {
        mux.ensureSession(warmSpec(i))
        const spawnSpec = mux.attachSpawn(warmSpec(i))
        if (pty) {
          const client = pty.spawn(spawnSpec.file, spawnSpec.args, {
            name: 'xterm-256color',
            cols: 100,
            rows: 30,
            cwd: root,
            env: { ...env, ...spawnSpec.env }
          })
          client.onData(() => undefined)
          clients.push(client)
        }
      }
    } finally {
      mux.endAttachBatch?.()
    }
    warmTotals.push(performance.now() - started)

    if (pty) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      const detachStarted = performance.now()
      for (const client of clients) client.kill()
      ptyDetachTotals.push(performance.now() - detachStarted)
      await new Promise((resolve) => setTimeout(resolve, 50))
      const rootsAfter = Array.from({ length: N }, (_, i) => mux.panePid(spec(i).sessionName))
      exactRoots = exactRoots && rootsAfter.every((pid, i) => pid === rootsBefore[i])
    }

    phase = `refresh-${run}`
    const refreshStarted = performance.now()
    for (let i = 0; i < N; i += 1) statusRefresh()
    refreshTotals.push(performance.now() - refreshStarted)

    const coalescedStarted = performance.now()
    statusRefresh()
    coalescedRefreshTotals.push(performance.now() - coalescedStarted)
  }

  const warmCalls = calls.filter((call) => call.phase.startsWith('warm-'))
  const grouped = new Map()
  for (const call of warmCalls) {
    const entry = grouped.get(call.command) ?? { count: 0, ms: 0, samples: [] }
    entry.count += 1
    entry.ms += call.ms
    entry.samples.push(call.ms)
    grouped.set(call.command, entry)
  }

  console.log(`\nISOLATED SESSION ${session}: ${N} ${AMBIGUOUS ? 'ambiguous' : 'warm'} terminals x ${RUNS} runs`)
  summarize('warm ensureSession+attachSpawn total', warmTotals)
  summarize('legacy per-spawn status refresh total', refreshTotals)
  summarize('coalesced status refresh total', coalescedRefreshTotals)
  if (pty) {
    summarize('real node-pty client detach total', ptyDetachTotals)
    console.log(`exact pane root PID preserved across every attach/detach: ${exactRoots ? 'YES' : 'NO'}`)
  }
  console.log('\nWarm command attribution (all runs):')
  for (const [command, entry] of [...grouped].sort((a, b) => b[1].ms - a[1].ms)) {
    const stats = latencyStats(entry.samples)
    console.log(`${command.padEnd(29)} calls=${String(entry.count).padStart(4)} total=${entry.ms.toFixed(2).padStart(9)}ms p50=${stats?.p50.toFixed(2).padStart(7)}ms p95=${stats?.p95.toFixed(2).padStart(7)}ms`)
  }
} finally {
  phase = 'cleanup'
  for (let i = 0; i < N; i += 1) mux.killSession(spec(i).sessionName)
  // Leave the isolated server alone: it owns no panes after cleanup and exits
  // naturally without any server-control command crossing this agent's lane.
}
