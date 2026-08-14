// Isolated team-paste latency probe. Uses the real WorkspaceStore + copyTeam
// against temp directories, while counting synchronous workspace JSON I/O.
//
// Run before and after an optimization with:
//   node_modules/.bin/vite-node scratchpad/team-paste-latency-probe.mjs both

// The source is N browser cards connected in a chain and the target is an
// inactive workspace. That is the expensive production case: every legacy
// per-node/per-cable patch reads and rewrites an increasingly large JSON file.

import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const requested = process.argv[2] ?? 'both'
const modes =
  requested === 'before' || requested === 'legacy'
    ? ['legacy']
    : requested === 'after' || requested === 'batched'
      ? ['batched']
      : ['legacy', 'batched']
const samples = Number(process.env.COOKREW_PASTE_PROBE_SAMPLES ?? 12)
const sizes = [10, 30]

const realReadFileSync = fs.readFileSync
const realWriteFileSync = fs.writeFileSync
let measuring = false
let reads = 0
let writes = 0
let bytes = 0

function isWorkspaceJson(file) {
  return typeof file === 'string' && file.endsWith(`${path.sep}workspace.json`)
}

fs.readFileSync = function countedRead(file, ...args) {
  if (measuring && isWorkspaceJson(file)) reads += 1
  return realReadFileSync.call(this, file, ...args)
}
fs.writeFileSync = function countedWrite(file, data, ...args) {
  if (measuring && isWorkspaceJson(file)) {
    writes += 1
    bytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
  }
  return realWriteFileSync.call(this, file, data, ...args)
}
syncBuiltinESMExports()

const [{ WorkspaceStore }, { TeamStore, copyTeam }] = await Promise.all([
  import('../src/main/store.ts'),
  import('../src/main/teams.ts')
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

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, index)]
}

async function one(n, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cookrew-paste-probe-${n}-`))
  const store = new WorkspaceStore(root)
  const nodes = Array.from({ length: n }, (_, i) => store.addNode(browser(i)))
  for (let i = 1; i < nodes.length; i += 1) store.connect(nodes[i - 1].id, nodes[i].id)
  const target = store.createWorkspace('Target', '/tmp')
  store.flush()

  const events = []
  store.on('op', (event) => {
    if (measuring) events.push(event.type)
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

  if (mode === 'legacy') {
    // Reproduce the pre-batch copyTeam loop using the still-public ordinary
    // mutation APIs. No historical checkout or second worktree is needed.
    store.appendTeamToWorkspace = (workspaceId, incoming, connections) => {
      const added = incoming.map((node) => store.addNodeToWorkspace(workspaceId, node))
      for (const connection of connections) store.connectAcross(connection.a, connection.b)
      return added
    }
  }

  reads = 0
  writes = 0
  bytes = 0
  measuring = true
  const started = performance.now()
  const result = await copyTeam(deps, {
    nodeIds: nodes.map((node) => node.id),
    intoWorkspaceId: target.id
  })
  // Mirrors src/main/index.ts teamPaste(), which owns the user-visible event.
  store.recordEvent(
    'team.copied',
    result.workspaceId,
    result.workspaceName,
    `${result.copiedNodes} nodes`
  )
  const elapsed = performance.now() - started
  measuring = false

  const state = store.workspaceState(target.id)
  if (state.nodes.length !== n || state.connections.length !== n - 1) {
    throw new Error(`bad paste result: ${state.nodes.length} nodes, ${state.connections.length} cables`)
  }
  fs.rmSync(root, { recursive: true, force: true })
  return { elapsed, reads, writes, bytes, events: events.length }
}

console.log(`team-paste probe: samples=${samples}; inactive target; chain edges=n-1`)
for (const mode of modes) {
  for (const n of sizes) {
    // First run pays module/JIT warm-up but is not included in the distribution.
    await one(n, mode)
    const runs = []
    for (let i = 0; i < samples; i += 1) runs.push(await one(n, mode))
    const times = runs.map((run) => run.elapsed)
    const representative = runs[0]
    console.log(
      JSON.stringify({
        mode,
        n,
        medianMs: Number(percentile(times, 50).toFixed(2)),
        p95Ms: Number(percentile(times, 95).toFixed(2)),
        minMs: Number(Math.min(...times).toFixed(2)),
        maxMs: Number(Math.max(...times).toFixed(2)),
        workspaceReads: representative.reads,
        workspaceWrites: representative.writes,
        workspaceWriteKiB: Number((representative.bytes / 1024).toFixed(1)),
        synchronousOpEvents: representative.events
      })
    )
  }
}
