import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { PresetStore } from '../src/main/preset-store'
import { buildManifest, signManifest } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
import { planPresetImport } from '../src/main/preset-import'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

const terminal = (over: Record<string, unknown> = {}): CanvasNode =>
  ({
    kind: 'terminal',
    id: 't1',
    name: 'Forge',
    preset: 'Claude Code',
    command: 'npm test',
    cwd: '/w',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 1, height: 1 },
    ...over
  }) as CanvasNode

function publish(nodes: CanvasNode[] = [terminal()]) {
  const snapshot: TeamSnapshot = { name: 'crew', savedAt: 1, dir: '/w', nodes, connections: [], turns: {} }
  const { privateKey } = generateKeyPairSync('ed25519')
  const built = buildManifest({ scrub: scrubForPublish(snapshot), version: 1, author: { handle: 'a' } })
  if (!built.ok) throw new Error('build refused')
  return { manifest: signManifest(built.manifest, privateKey), teamBytes: built.teamBytes }
}

let base = ''
let store: PresetStore
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'cookrew-gate-'))
  store = new PresetStore(base)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

/**
 * N4. The gate decision belongs to the process that owns the store, not to the
 * chip's click handler. The renderer declining to place a locked preset is
 * presentation; the IPC channel is reachable without it, so the check the main
 * handler performs is the one that counts. This asserts the predicate that
 * handler uses, on real installed state.
 */
describe('N4 — entitlement is decided where the store is, not in the renderer', () => {
  const entitledOf = (id: string): boolean | undefined =>
    store.list().find((p) => p.id === id)?.entitled

  it('reports a gated preset as not entitled, which is what place refuses on', () => {
    const p = publish()
    store.install(p, { entitled: false })
    expect(entitledOf(p.manifest.id)).toBe(false)
  })

  it('reports an owned preset as entitled, so placement proceeds', () => {
    const p = publish()
    store.install(p)
    expect(entitledOf(p.manifest.id)).toBe(true)
  })

  it('an unknown id is not entitled either — absent is not permission', () => {
    expect(entitledOf('sha256:' + 'a'.repeat(64))).toBeUndefined()
  })

  it('a gated preset still READS, so the sheet can describe what is locked', () => {
    // Refusing to place is not refusing to look: the buyer has to see what
    // they would be buying.
    const p = publish()
    store.install(p, { entitled: false })
    expect(store.read(p.manifest.id)).not.toBeNull()
  })
})

/**
 * N2. A team lands in ONE workspace patch. The plan is what the handler feeds
 * to appendTeamToWorkspace, so what matters here is that it hands over the
 * whole team at once — nodes and their cables together — rather than a
 * sequence the canvas can be observed part-way through.
 */
describe('N2 — a team plan is one batch, not a sequence', () => {
  it('carries every node and its cables in a single plan', () => {
    const snapshot: TeamSnapshot = {
      name: 'crew',
      savedAt: 1,
      dir: '/w',
      nodes: [terminal(), terminal({ id: 't2' }), terminal({ id: 't3' }), terminal({ id: 't4' })],
      connections: [
        { id: 'c1', a: 't1', b: 't2' },
        { id: 'c2', a: 't2', b: 't3' },
        { id: 'c3', a: 't3', b: 't4' }
      ],
      turns: {}
    }
    const plan = planPresetImport(snapshot, { dirs: ['/home/buyer'], cutAt: 1 })
    expect(plan.kind).toBe('team')
    expect(plan.nodes).toHaveLength(4)
    expect(plan.connections).toHaveLength(3)
    // Cables reference only nodes in the same batch, which is the precondition
    // appendTeamToWorkspace filters on — nothing is left to a later call.
    const ids = new Set(plan.nodes.map((n) => n.id))
    expect(plan.connections.every((c) => ids.has(c.a) && ids.has(c.b))).toBe(true)
  })
})
