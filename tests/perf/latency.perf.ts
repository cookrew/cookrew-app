import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EventLog, type CookrewEvent } from '../../src/main/event-log'
import { WorkspaceStore } from '../../src/main/store'
import { TeamStore, copyTeam } from '../../src/main/teams'
import type { CanvasNode } from '../../src/shared/model'
import { LATENCY, STORAGE } from './budgets'
import { expectEvery, expectTail, measure, removeRoot, tempRoot, timed } from './perf-harness'

/**
 * Tail-latency gates for main-process operations. No live app: every run
 * uses isolated temp directories, so this is safe on CI and on a machine
 * where Cookrew is running.
 *
 * Each gate pairs a p95/p98 budget with a structural assertion — the count
 * of reads, writes or events the operation performed — because the wall
 * clock alone cannot tell a fast machine from a fixed algorithm.
 */

// ---------------------------------------------------------------------------
// Counting the filesystem. The store imports named bindings from node:fs, so
// the counters are installed on the default export and the ESM bindings are
// re-synced — the same technique scratchpad/perf-eval-gate.mjs proved.
// ---------------------------------------------------------------------------

const real = {
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  appendFileSync: fs.appendFileSync
}
const counters = { on: false, workspaceReads: 0, workspaceWrites: 0, appends: 0 }

const isWorkspaceJson = (file: unknown): boolean =>
  typeof file === 'string' && file.endsWith(`${path.sep}workspace.json`)

beforeAll(() => {
  fs.readFileSync = function countedRead(this: unknown, file: Parameters<typeof fs.readFileSync>[0], ...rest: unknown[]) {
    if (counters.on && isWorkspaceJson(file)) counters.workspaceReads += 1
    return (real.readFileSync as (...a: unknown[]) => Buffer | string).call(this, file, ...rest)
  } as typeof fs.readFileSync
  fs.writeFileSync = function countedWrite(this: unknown, file: Parameters<typeof fs.writeFileSync>[0], ...rest: unknown[]) {
    if (counters.on && isWorkspaceJson(file)) counters.workspaceWrites += 1
    return (real.writeFileSync as (...a: unknown[]) => void).call(this, file, ...rest)
  } as typeof fs.writeFileSync
  fs.appendFileSync = function countedAppend(this: unknown, ...args: unknown[]) {
    if (counters.on) counters.appends += 1
    return (real.appendFileSync as (...a: unknown[]) => void).call(this, ...args)
  } as typeof fs.appendFileSync
  syncBuiltinESMExports()
})

afterAll(() => {
  fs.readFileSync = real.readFileSync
  fs.writeFileSync = real.writeFileSync
  fs.appendFileSync = real.appendFileSync
  syncBuiltinESMExports()
})

const resetCounters = (): void => {
  counters.workspaceReads = 0
  counters.workspaceWrites = 0
  counters.appends = 0
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function browser(i: number): CanvasNode {
  return {
    kind: 'browser',
    id: `source-${i}`,
    name: `Page ${i}`,
    url: `https://example.com/${i}`,
    position: { x: (i % 6) * 420, y: Math.floor(i / 6) * 320 },
    size: { width: 400, height: 300 }
  } as CanvasNode
}

function event(i: number, type = 'terminal.created', durationMs?: number): CookrewEvent {
  return {
    type,
    entityId: `terminal-${i % 40}`,
    entityName: `Agent ${i % 40}`,
    workspaceId: 'perf-workspace',
    workspaceName: 'Perf Eval',
    actor: 'user',
    timestamp: 1_800_000_000_000 + i,
    ...(durationMs === undefined ? {} : { durationMs })
  }
}

const gitStub = {
  gitInfo: async () => ({ isRepo: false, root: null, branch: null, dirty: false, ahead: 0, behind: 0 }),
  addWorktree: async () => ({ ok: false as const, error: 'disabled' })
}

interface PasteShape {
  nodes: number
  cables: number
  reads: number
  writes: number
  events: number
}

async function pasteOnce(n: number) {
  const root = tempRoot(`paste-${n}`)
  try {
    const store = new WorkspaceStore(root)
    const nodes = Array.from({ length: n }, (_, i) => store.addNode(browser(i)))
    for (let i = 1; i < nodes.length; i += 1) store.connect(nodes[i - 1].id, nodes[i].id)
    const target = store.createWorkspace('Target', '/tmp')
    store.flush()

    const ops: string[] = []
    store.on('op', (observed: { type: string }) => {
      if (counters.on) ops.push(observed.type)
    })
    const deps = {
      store,
      turns: { history: () => [] },
      roles: { get: () => undefined },
      teams: new TeamStore(path.join(root, 'teams')),
      ptys: { get: () => undefined },
      switchWorkspace: () => undefined,
      git: gitStub,
      worktreeRoot: path.join(root, 'worktrees')
    } as unknown as Parameters<typeof copyTeam>[0]

    resetCounters()
    counters.on = true
    const started = performance.now()
    const result = await copyTeam(deps, { nodeIds: nodes.map((node) => node.id), intoWorkspaceId: target.id })
    store.recordEvent('team.copied', result.workspaceId, result.workspaceName, `${n} nodes`)
    const elapsed = performance.now() - started
    counters.on = false

    const pasted = store.workspaceState(target.id)
    const structural: PasteShape = {
      nodes: pasted.nodes.length,
      cables: pasted.connections.length,
      reads: counters.workspaceReads,
      writes: counters.workspaceWrites,
      events: ops.length
    }
    return { elapsed, structural }
  } finally {
    counters.on = false
    removeRoot(root)
  }
}

describe('team paste — batched, two reads, one write', () => {
  for (const n of [10, 30] as const) {
    it(`n=${n} holds its tail and its shape`, async () => {
      const measured = await measure(`team paste n=${n}`, () => pasteOnce(n))
      expectTail(measured, n === 10 ? LATENCY.teamPaste10 : LATENCY.teamPaste30)
      expectEvery(measured, 'reads', 2)
      expectEvery(measured, 'writes', 1)
      expectEvery(measured, 'events', 1)
      expectEvery(measured, 'nodes', n)
      expectEvery(measured, 'cables', n - 1)
    })
  }
})

describe('event log — a burst is one write', () => {
  it('30 appends touch the disk exactly once, on flush', async () => {
    const root = tempRoot('events')
    try {
      const measured = await measure('event-log burst n=30', () => {
        const file = path.join(root, `${Math.random().toString(36).slice(2)}.jsonl`)
        const log = new EventLog(file, { flushMs: 60_000 })
        resetCounters()
        counters.on = true
        const started = performance.now()
        for (let i = 0; i < 30; i += 1) log.append(event(i))
        const beforeFlush = counters.appends
        log.flush()
        const elapsed = performance.now() - started
        counters.on = false
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n').length
        return { elapsed, structural: { beforeFlush, total: counters.appends, lines } }
      })
      expectTail(measured, LATENCY.eventBurst30)
      expectEvery(measured, 'beforeFlush', 0)
      expectEvery(measured, 'total', 1)
      expectEvery(measured, 'lines', 30)
    } finally {
      removeRoot(root)
    }
  })
})

describe('event log — query over a live-shaped log', () => {
  let root: string
  let log: EventLog

  beforeAll(() => {
    root = tempRoot('live-log')
    log = new EventLog(path.join(root, 'events.jsonl'), { ...STORAGE.eventLog, flushMs: 60_000 })
    // Fill past the rotation cap enough times that every kept file is full:
    // the live machine carries events.jsonl plus three 4 MB rotations.
    const target = STORAGE.eventLog.maxBytes * (STORAGE.eventLog.keepFiles + 1)
    let written = 0
    let i = 0
    while (written < target) {
      for (let k = 0; k < 500; k += 1, i += 1) {
        const timed = i % 20 === 0
        log.append(event(i, timed ? 'turn.completed' : 'terminal.created', timed ? 1000 + (i % 700) : undefined))
      }
      log.flush()
      written = fs
        .readdirSync(root)
        .map((f) => fs.statSync(path.join(root, f)).size)
        .reduce((a, b) => a + b, 0)
    }
  })

  afterAll(() => removeRoot(root))

  it('answers a filtered, limited query within budget and spans every rotated file', async () => {
    const files = fs.readdirSync(root).filter((f) => f.endsWith('.jsonl')).length
    expect(files).toBe(STORAGE.eventLog.keepFiles + 1)
    const measured = await measure('event-log query type+limit (live shape)', () =>
      timed(() => {
        const rows = log.query({ type: 'turn.completed', limit: 200 })
        return { rows: rows.length, allTimed: rows.every((r) => typeof r.durationMs === 'number') }
      })
    )
    expectTail(measured, LATENCY.eventQueryLiveShape)
    expectEvery(measured, 'rows', 200)
    expectEvery(measured, 'allTimed', true)
  })
})

describe('workspace state — serialising the heaviest live canvas', () => {
  it('120 nodes with 4 KB notes serialise within budget', async () => {
    const root = tempRoot('serialize')
    try {
      const store = new WorkspaceStore(root)
      const filler = 'lorem ipsum dolor sit amet '.repeat(150)
      for (let i = 0; i < 120; i += 1) {
        const node: CanvasNode =
          i % 3 === 0
            ? ({
                kind: 'note',
                id: `note-${i}`,
                name: `Note ${i}`,
                customName: null,
                content: `# Note ${i}\n\n${filler}`,
                locked: false,
                position: { x: (i % 10) * 420, y: Math.floor(i / 10) * 320 },
                size: { width: 300, height: 200 }
              } as CanvasNode)
            : i % 3 === 1
              ? ({
                  kind: 'terminal',
                  id: `term-${i}`,
                  name: `Agent ${i}`,
                  preset: 'Claude Code',
                  command: 'claude',
                  cwd: '/work/repo',
                  orch: false,
                  role: null,
                  position: { x: (i % 10) * 420, y: Math.floor(i / 10) * 320 },
                  size: { width: 400, height: 300 }
                } as CanvasNode)
              : browser(i)
        store.addNode(node)
      }
      const id = store.focusedId
      const measured = await measure('workspace state serialize n=120', () =>
        timed(() => {
          const json = JSON.stringify(store.workspaceState(id))
          return { bytesKb: Math.round(json.length / 1024 / 100) * 100, nodes: store.workspaceState(id).nodes.length }
        })
      )
      expectTail(measured, LATENCY.workspaceStateSerialize120)
      expectEvery(measured, 'nodes', 120)
      // The shape of the live payload: hundreds of KB, not tens and not MBs.
      expect(measured.structurals[0].bytesKb).toBeGreaterThanOrEqual(100)
      expect(measured.structurals[0].bytesKb).toBeLessThan(2000)
      // addNode mirrors each note to disk asynchronously; wait for every
      // mirror to land before the directory under them goes, or the late
      // writes log ENOENT into the run. Polled, not slept — a fixed pause is
      // a guess about the runner.
      const notesDir = store.notesDirOf(id)
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const landed = fs.existsSync(notesDir) ? fs.readdirSync(notesDir).length : 0
        if (landed >= 40) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(fs.readdirSync(notesDir).length).toBe(40)
    } finally {
      removeRoot(root)
    }
  })
})
