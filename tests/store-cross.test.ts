import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../src/main/store'
import type { TerminalNodeData } from '../src/shared/model'

function terminal(name: string, cwd = '/work/alpha'): TerminalNodeData {
  return {
    kind: 'terminal',
    id: `id-${name.toLowerCase().replace(/\s+/g, '-')}-${Math.floor(Math.random() * 1e9)}`,
    name,
    preset: 'Claude Code',
    command: 'claude',
    cwd,
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 }
  }
}

/** Fresh store in a temp data dir, with the orch in the seeded workspace. */
function makeStore(): { store: WorkspaceStore; orch: TerminalNodeData } {
  const base = mkdtempSync(path.join(tmpdir(), 'cookrew-store-'))
  const store = new WorkspaceStore(base)
  const orch = store.addNode({ ...terminal('Conductor'), orch: true }) as TerminalNodeData
  return { store, orch }
}

describe('WorkspaceStore cross-workspace identity', () => {
  it('finds nodes in inactive workspaces and names their workspace', () => {
    const { store } = makeStore()
    const beta = store.createWorkspace('Beta', '/work/beta')
    const coder = store.addNodeToWorkspace(beta.id, terminal('Coder', '/work/beta'))

    expect(store.node(coder.id)).toBeUndefined() // active-scoped lookup misses
    const hit = store.nodeAcrossWorkspaces(coder.id)
    expect(hit?.node.name).toBe('Coder')
    expect(hit?.workspaceId).toBe(beta.id)
    expect(store.workspaceOf(coder.id)?.name).toBe('Beta')
  })

  it('still resolves active-workspace nodes (active state wins, in memory)', () => {
    const { store, orch } = makeStore()
    const hit = store.nodeAcrossWorkspaces(orch.id)
    expect(hit?.node.id).toBe(orch.id)
    expect(hit?.workspaceId).toBe(store.activeId)
  })

  it('unique-names nodes within the target workspace on cross-workspace add', () => {
    const { store } = makeStore()
    const beta = store.createWorkspace('Beta', '/work/beta')
    store.addNodeToWorkspace(beta.id, terminal('Coder', '/work/beta'))
    const second = store.addNodeToWorkspace(beta.id, terminal('Coder', '/work/beta'))
    expect(second.name).not.toBe('Coder')
  })
})

describe('WorkspaceStore mirrored cross-workspace edges', () => {
  it('writes the same connection into both endpoint workspaces', () => {
    const { store, orch } = makeStore()
    const alpha = store.activeId
    const beta = store.createWorkspace('Beta', '/work/beta')
    const coder = store.addNodeToWorkspace(beta.id, terminal('Coder', '/work/beta'))

    const conn = store.connectAcross(orch.id, coder.id)
    // Active (alpha) side holds the edge…
    expect(store.state.connections.some((c) => c.id === conn.id)).toBe(true)
    // …and the beta file holds the SAME edge (visible once beta is active).
    store.switchWorkspace(beta.id)
    expect(store.state.connections.some((c) => c.id === conn.id)).toBe(true)
    store.switchWorkspace(alpha)
  })

  it('is idempotent — reconnecting returns the existing edge, no duplicates', () => {
    const { store, orch } = makeStore()
    const beta = store.createWorkspace('Beta', '/work/beta')
    const coder = store.addNodeToWorkspace(beta.id, terminal('Coder', '/work/beta'))

    const first = store.connectAcross(orch.id, coder.id)
    const second = store.connectAcross(orch.id, coder.id)
    expect(second.id).toBe(first.id)
    expect(store.state.connections.filter((c) => c.a === orch.id || c.b === orch.id)).toHaveLength(1)
  })

  it('resolves foreign endpoints from either side via connectedToAcross', () => {
    const { store, orch } = makeStore()
    const beta = store.createWorkspace('Beta', '/work/beta')
    const coder = store.addNodeToWorkspace(beta.id, terminal('Coder', '/work/beta'))
    store.connectAcross(orch.id, coder.id)

    const fromOrch = store.connectedToAcross(orch.id)
    expect(fromOrch.map((h) => h.node.name)).toContain('Coder')
    expect(fromOrch.find((h) => h.node.id === coder.id)?.workspaceId).toBe(beta.id)

    // Switch to beta: the orch now lives in an INACTIVE workspace but must
    // still resolve — this is the orphaned-orch bug.
    store.switchWorkspace(beta.id)
    const fromCoder = store.connectedToAcross(coder.id)
    expect(fromCoder.map((h) => h.node.name)).toContain('Conductor')
  })

  it('filters mirror edges left dangling by a deletion in the other workspace', () => {
    const { store, orch } = makeStore()
    const beta = store.createWorkspace('Beta', '/work/beta')
    const coder = store.addNodeToWorkspace(beta.id, terminal('Coder', '/work/beta'))
    store.connectAcross(orch.id, coder.id)

    store.removeNodeAcross(coder.id)
    expect(store.nodeAcrossWorkspaces(coder.id)).toBeUndefined()
    expect(store.connectedToAcross(orch.id).map((h) => h.node.id)).not.toContain(coder.id)
  })
})
