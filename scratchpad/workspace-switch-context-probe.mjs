#!/usr/bin/env -S node_modules/.bin/vite-node

// Read-only attribution for exact-context reconciliation on the active canvas.
// It never constructs WorkspaceStore (which has save timers): workspace.json
// is parsed directly, then each bound harness transcript is read and parsed.

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const { harnessFor } = await import('../src/main/harness.ts')
const { latencyStats } = await import('../src/shared/stats.ts')

const home = path.join(homedir(), '.cookrew')
const registry = JSON.parse(readFileSync(path.join(home, 'registry.json'), 'utf8'))
const workspace = JSON.parse(
  readFileSync(path.join(home, 'workspaces', registry.activeId, 'workspace.json'), 'utf8')
)

let total = 0
const bindings = []
for (const node of workspace.nodes.filter((candidate) => candidate.kind === 'terminal')) {
  const harness = harnessFor(node.command)
  if (!harness?.parseTurns) continue
  const file = harness.watchFile?.(node, {}) ?? null
  if (!file) continue
  try {
    const stat = statSync(file)
    bindings.push({ file, mtimeMs: stat.mtimeMs, size: stat.size })
    const started = performance.now()
    const lines = readFileSync(file, 'utf8').split('\n')
    const readAt = performance.now()
    const turns = harness.parseTurns(lines)
    const ended = performance.now()
    total += ended - started
    console.log(JSON.stringify({
      name: node.name,
      harness: harness.id,
      mb: Number((stat.size / 1024 / 1024).toFixed(2)),
      lines: lines.length,
      turns: turns.length,
      readMs: Number((readAt - started).toFixed(2)),
      parseMs: Number((ended - readAt).toFixed(2)),
      totalMs: Number((ended - started).toFixed(2))
    }))
  } catch {
    // A file can rotate between stat/read; the production reconciler has the
    // same best-effort contract and retries on its next tick.
  }
}
console.log(`TOTAL ${total.toFixed(2)}ms`)

// The optimized return path validates exactly these signatures before trusting
// the TurnTracker history it deliberately retained across the detach.
const signatureRuns = []
for (let run = 0; run < 50; run += 1) {
  const started = performance.now()
  for (const binding of bindings) {
    const stat = statSync(binding.file)
    if (stat.mtimeMs !== binding.mtimeMs || stat.size !== binding.size) {
      throw new Error(`transcript changed during probe: ${binding.file}`)
    }
  }
  signatureRuns.push(performance.now() - started)
}
const signature = latencyStats(signatureRuns)
console.log(
  `UNCHANGED SIGNATURE CHECK n=${signature?.count} p50=${signature?.p50.toFixed(2)}ms ` +
    `p95=${signature?.p95.toFixed(2)}ms max=${signature?.max.toFixed(2)}ms`
)
