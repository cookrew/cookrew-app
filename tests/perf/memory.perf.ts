import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventLog, type CookrewEvent } from '../../src/main/event-log'
import { WorkspaceStore } from '../../src/main/store'
import { clearNoteMarkdownCache, renderNoteMarkdown } from '../../src/renderer/src/note-markdown'
import type { CanvasNode } from '../../src/shared/model'
import { MEMORY } from './budgets'
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

  it('the renderer itself retains nothing (control)', async () => {
    const growth = await heapGrowth(300, (i) => {
      renderNoteMarkdown(body(i))
      clearNoteMarkdownCache()
    })
    expect(growth.retainedMb).toBeLessThan(MEMORY.noteRenderNoCacheMb)
  })

  it('rendering 300 distinct 64 KB notes retains only the cache bound', async () => {
    expect(body(0).length).toBeGreaterThan(60 * 1024)
    const growth = await heapGrowth(300, (i) => {
      renderNoteMarkdown(body(i))
    })
    expect(growth.retainedMb).toBeLessThan(MEMORY.noteRenderCacheMb)
    // And the bound is a window, not a leak: the most recent note answers
    // from the cache (the SAME string object both times), while the first one
    // rendered was evicted and renders afresh (an equal but distinct string).
    // Identity, not timing — two clocks racing on a CI runner is a coin toss.
    const recent = body(300)
    expect(renderNoteMarkdown(recent)).toBe(renderNoteMarkdown(recent))
    const first = renderNoteMarkdown(body(1))
    const again = renderNoteMarkdown(body(1))
    expect(again).toBe(first)
    const evicted = renderNoteMarkdown(body(2))
    expect(renderNoteMarkdown(body(2))).toBe(evicted)
    expect(evicted).not.toBe(first)
  })
})
