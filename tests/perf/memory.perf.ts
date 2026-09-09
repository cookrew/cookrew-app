import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventLog, type CookrewEvent } from '../../src/main/event-log'
import { WorkspaceStore } from '../../src/main/store'
import { clearNoteMarkdownCache, noteMarkdownCacheStats, renderNoteMarkdown } from '../../src/renderer/src/note-markdown'
import type { CanvasNode } from '../../src/shared/model'
import { MEMORY, STORAGE } from './budgets'
import { heapGrowth, removeRoot, tempRoot } from './perf-harness'

/**
 * Retained-heap gates. Each one drives a store through many cycles of the
 * work it does all day and asserts that, once garbage is collected, almost
 * nothing survived. A leak shows up here as a slope, and a slope is what the
 * owner's "内存占用和泄漏" complaint looks like from inside the process.
 *
 * These are main-process and shared modules — the parts of the app a test
 * can hold in its hands. The renderer's resting weight (layers, layout, the
 * xterm instances) is measured on the live machine by scripts/perf-eval.mjs,
 * not here.
 */

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) removeRoot(root)
  clearNoteMarkdownCache()
})

function root(prefix: string): string {
  const made = tempRoot(prefix)
  roots.push(made)
  return made
}

function event(i: number): CookrewEvent {
  return {
    type: i % 5 === 0 ? 'turn.completed' : 'terminal.created',
    entityId: `terminal-${i % 40}`,
    entityName: `Agent ${i % 40}`,
    workspaceId: 'perf-workspace',
    workspaceName: 'Perf Eval',
    actor: 'agent',
    timestamp: 1_800_000_000_000 + i,
    ...(i % 5 === 0 ? { durationMs: 1000 + (i % 900) } : {})
  }
}

/** Retained heap, in MB, that `run` adds once garbage is collected. */
function retainedBy(run: () => void): number {
  const gc = (globalThis as { gc?: () => void }).gc
  if (!gc) throw new Error('heap gates need --expose-gc: run through vitest.perf.config.ts (npm run test:perf)')
  gc()
  gc()
  const before = process.memoryUsage().heapUsed
  run()
  gc()
  gc()
  return Math.max(0, process.memoryUsage().heapUsed - before) / (1024 * 1024)
}

describe('event log — the rotated-file cache is bounded by the rotation policy', () => {
  it('holds the parsed rotated files of a live-shaped log, and nothing more on later queries', () => {
    const dir = root('mem-events-cache')
    const log = new EventLog(path.join(dir, 'events.jsonl'), { ...STORAGE.eventLog, flushMs: 60_000 })
    const target = STORAGE.eventLog.maxBytes * (STORAGE.eventLog.keepFiles + 1)
    let written = 0
    let i = 0
    while (written < target) {
      for (let k = 0; k < 500; k += 1, i += 1) log.append(event(i))
      log.flush()
      written = fs
        .readdirSync(dir)
        .map((f) => fs.statSync(path.join(dir, f)).size)
        .reduce((a, b) => a + b, 0)
    }
    const firstQuery = retainedBy(() => log.query({ type: 'turn.completed', limit: 200 }))
    const laterQueries = retainedBy(() => {
      for (let n = 0; n < 20; n += 1) log.query({ type: 'turn.completed', limit: 200 })
      log.count({ type: 'turn.' })
    })
    process.stdout.write(
      `perf heap event-log cache (live shape, ${i} events): first query retained=${firstQuery.toFixed(2)}MB, 20 more retained=${laterQueries.toFixed(2)}MB\n`
    )
    expect(firstQuery).toBeLessThan(MEMORY.eventLogRotatedCacheMb)
    expect(laterQueries).toBeLessThan(1)
  })
})

describe('event log — cycles retain nothing', () => {
  it('append, flush and query 300 times on a rotating log', async () => {
    const dir = root('mem-events')
    const log = new EventLog(path.join(dir, 'events.jsonl'), { maxBytes: 128 * 1024, keepFiles: 2, flushMs: 60_000 })
    let seen = 0
    const growth = await heapGrowth(300, (i) => {
      for (let k = 0; k < 50; k += 1) log.append(event(i * 50 + k))
      log.flush()
      seen += log.query({ type: 'turn.completed', limit: 10 }).length
    })
    expect(seen).toBeGreaterThan(0)
    expect(growth.retainedMb).toBeLessThan(MEMORY.eventLogCyclesMb)
  })
})

function browser(i: number): CanvasNode {
  return {
    kind: 'browser',
    id: `node-${i}`,
    name: `Page ${i}`,
    url: `https://example.com/${i}`,
    position: { x: (i % 6) * 420, y: Math.floor(i / 6) * 320 },
    size: { width: 400, height: 300 }
  } as CanvasNode
}

describe('workspace store — churn and switching retain nothing', () => {
  it('2000 add/remove cycles leave the heap, the listener count and the resident set where they were', async () => {
    const dir = root('mem-store')
    const store = new WorkspaceStore(dir)
    const listenersBefore = store.listenerCount('op')
    const growth = await heapGrowth(2000, (i) => {
      const node = store.addNode(browser(i))
      store.removeNode(node.id)
    })
    store.flush()
    expect(store.listenerCount('op')).toBe(listenersBefore)
    expect(store.workspaceState(store.focusedId).nodes).toHaveLength(0)
    expect(growth.retainedMb).toBeLessThan(MEMORY.storeChurnMb)
  })

  /** Touch every workspace once from home, so each one has been hydrated. */
  async function tour(store: WorkspaceStore, home: string, ids: readonly string[]) {
    return heapGrowth(ids.length, (i) => {
      const id = ids[i % ids.length]
      store.switchWorkspace(id)
      for (let k = 0; k < 20; k += 1) store.addNode(browser(k))
      store.flush()
      store.switchWorkspace(home)
    })
  }

  // Passed explicitly: the default follows COOKREW_MULTI_INSTANCE, which is
  // set inside a Cookrew terminal, and a shape test that changes its answer
  // with the shell it runs in is not a test.
  it('single-instance: switching through 40 workspaces evicts the one you left', async () => {
    const store = new WorkspaceStore(root('mem-switch'), { multiInstance: false })
    const home = store.focusedId
    const ids = Array.from({ length: 40 }, (_, i) => store.createWorkspace(`W${i}`, '/tmp').id)
    const growth = await tour(store, home, ids)
    // A parked workspace must not stay hydrated: this is the O(active) shape
    // PERF-N asks for, and what keeps a 40-workspace machine from paying for
    // 40 canvases at rest.
    expect(store.resident()).toEqual([home])
    expect(growth.retainedMb).toBeLessThan(MEMORY.storeChurnMb)
  })

  it('multi-instance: residency is O(touched) until released, and release drops it', async () => {
    const store = new WorkspaceStore(root('mem-multi'), { multiInstance: true })
    const home = store.focusedId
    const ids = Array.from({ length: 40 }, (_, i) => store.createWorkspace(`W${i}`, '/tmp').id)
    await tour(store, home, ids)
    // Every workspace the tour touched is still held — by design (marketplace
    // §11), and the reason the drain in index.ts must release parked ones.
    expect(store.resident().length).toBe(ids.length + 1)
    for (const id of ids) expect(store.releaseSession(id)).toBe(true)
    expect(store.releaseSession(home)).toBe(false)
    expect(store.resident()).toEqual([home])
  })
})

describe('note markdown — the render cache is bounded', () => {
  const body = (i: number): string => `# Note ${i}\n\n${'- item with **bold** and `code`\n'.repeat(2100)}`

  it('the renderer retains nothing once the cache is cleared — not even marked\'s last parse tree (control)', async () => {
    const growth = await heapGrowth(300, (i) => {
      renderNoteMarkdown(body(i))
      clearNoteMarkdownCache()
    })
    expect(growth.retainedMb).toBeLessThan(MEMORY.noteRenderNoCacheMb)
    // marked keeps the last parse's whole token tree alive through the custom
    // renderer (Parser assigns itself to renderer.parser): measured 46 MB
    // after one 1.3M-char parse, 224 MB after a 7.2M-char one. The module
    // releases it with an empty parse; this is the assertion that it still
    // does, at a size the count-of-64-KB-notes loop above cannot see.
    const large = `# Large\n\n${'- item with **bold** and `code`\n'.repeat(40_000)}`
    expect(large.length).toBeGreaterThan(1_000_000)
    const afterLarge = await heapGrowth(1, () => {
      renderNoteMarkdown(large)
      clearNoteMarkdownCache()
    })
    expect(afterLarge.retainedMb).toBeLessThan(MEMORY.noteRenderNoCacheMb)
  })

  it('rendering 300 distinct 64 KB notes retains only the cache bound', async () => {
    expect(body(0).length).toBeGreaterThan(60 * 1024)
    const base = noteMarkdownCacheStats()
    const growth = await heapGrowth(300, (i) => {
      renderNoteMarkdown(body(i))
    })
    expect(growth.retainedMb).toBeLessThan(MEMORY.noteRenderCacheMb)
    // STRUCTURE: the bound is in bytes and it held — and it is USED. Three
    // hundred distinct notes went in as parses, the running total never reads
    // above its budget, and a cache that evicted too eagerly (fewer than 20
    // of this shape, or under 80% of its budget) is as much a defect as one
    // that never evicts.
    const held = noteMarkdownCacheStats()
    process.stdout.write(`perf note cache: entries=${held.entries} bytes=${held.bytes} of ${held.maxBytes}\n`)
    expect(held.misses - base.misses).toBeGreaterThanOrEqual(300)
    expect(held.hits).toBe(base.hits)
    expect(held.oversizedParses).toBe(base.oversizedParses)
    expect(held.illFormedParses).toBe(base.illFormedParses)
    expect(held.bytes).toBeLessThanOrEqual(held.maxBytes)
    expect(held.bytes).toBeGreaterThan(held.maxBytes * 0.8)
    expect(held.entries).toBeGreaterThan(20)
    expect(held.entries).toBeLessThan(held.misses - base.misses)
    // And the bound is a window, not a leak: the most recent note answers
    // from the cache, while the first one rendered was evicted and renders
    // afresh, then answers from the cache again. Strings are primitives, so
    // toBe here is equality — the COUNTERS are what tell a hit from a parse.
    // Counters, not timing — two clocks racing on a CI runner is a coin toss.
    const recent = body(300)
    expect(renderNoteMarkdown(recent)).toBe(renderNoteMarkdown(recent))
    expect(noteMarkdownCacheStats()).toMatchObject({ hits: held.hits + 2, misses: held.misses })
    const first = renderNoteMarkdown(body(1))
    expect(noteMarkdownCacheStats()).toMatchObject({ hits: held.hits + 2, misses: held.misses + 1 })
    const again = renderNoteMarkdown(body(1))
    expect(again).toBe(first)
    expect(noteMarkdownCacheStats()).toMatchObject({ hits: held.hits + 3, misses: held.misses + 1 })
    const evicted = renderNoteMarkdown(body(2))
    expect(renderNoteMarkdown(body(2))).toBe(evicted)
    expect(evicted).not.toBe(first)
    expect(noteMarkdownCacheStats()).toMatchObject({ hits: held.hits + 4, misses: held.misses + 2, oversizedParses: base.oversizedParses })
  })

  it('the side caches are real, and the whole module stays under one budget plus two side caps', () => {
    // One note over the budget (2.2M chars of source, ~4.4M of HTML: 8.6 MB
    // accounted, over 8 MiB) and one ill-formed note, so both side caches
    // hold something and the bound they are asserted against is not vacuous.
    const oversized = `# Oversized\n\n${'- item with **bold** and `code`\n'.repeat(70_000)}`
    const illFormed = `${body(1)}\uD800`
    const before = noteMarkdownCacheStats()
    renderNoteMarkdown(oversized)
    renderNoteMarkdown(illFormed)
    const held = noteMarkdownCacheStats()
    process.stdout.write(`perf note side caches: oversized=${held.oversizedBytes} illFormed=${held.illFormedBytes} cap=${held.maxSideBytes}\n`)
    expect(held.oversizedParses).toBe(before.oversizedParses + 1)
    expect(held.illFormedParses).toBe(before.illFormedParses + 1)
    expect(held.oversizedBytes).toBeGreaterThan(held.maxBytes)
    expect(held.illFormedBytes).toBeGreaterThan(0)
    // The map is untouched by either: an oversized note evicts nothing.
    expect(held.entries).toBe(before.entries)
    expect(held.bytes).toBe(before.bytes)
    // Both answer from their cache on the next render.
    renderNoteMarkdown(oversized)
    renderNoteMarkdown(illFormed)
    expect(noteMarkdownCacheStats()).toMatchObject({ hits: held.hits + 2, oversizedParses: held.oversizedParses, illFormedParses: held.illFormedParses })
    // The module's bound: map ≤ budget, each side cache ≤ its cap, the sum ≤ budget + 2 caps (40 MiB accounted at the defaults).
    expect(held.maxSideBytes).toBe(2 * held.maxBytes)
    expect(held.bytes).toBeLessThanOrEqual(held.maxBytes)
    expect(held.oversizedBytes).toBeLessThanOrEqual(held.maxSideBytes)
    expect(held.illFormedBytes).toBeLessThanOrEqual(held.maxSideBytes)
    expect(held.bytes + held.oversizedBytes + held.illFormedBytes).toBeLessThanOrEqual(held.maxBytes + 2 * held.maxSideBytes)
  })
})
