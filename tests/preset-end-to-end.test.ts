import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { PresetStore } from '../src/main/preset-store'
import { buildManifest, signManifest } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
import { verifyPreset } from '../src/main/preset-install'
import { planPresetImport } from '../src/main/preset-import'
import { presetChips, chipAction } from '../src/shared/preset-chip'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

const terminal = (over: Record<string, unknown> = {}): CanvasNode =>
  ({
    kind: 'terminal',
    id: 't1',
    name: 'Forge',
    preset: 'Claude Code',
    command: 'npm test',
    cwd: '/authors/machine',
    orch: false,
    role: 'Developer',
    position: { x: 0, y: 0 },
    size: { width: 1, height: 1 },
    ...over
  }) as CanvasNode

function publishAndInstall(store: PresetStore, nodes: CanvasNode[], name: string): string {
  const snapshot: TeamSnapshot = {
    name,
    savedAt: 1,
    dir: '/authors/machine',
    nodes,
    connections: [],
    turns: {}
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const built = buildManifest({ scrub: scrubForPublish(snapshot), version: 1, author: { handle: 'drej' } })
  if (!built.ok) throw new Error('build refused')
  const manifest = signManifest(built.manifest, privateKey)
  // The install path a buyer takes: verify what was downloaded, then persist.
  const verified = verifyPreset({ manifest, teamBytes: built.teamBytes, publicKey })
  if (!verified.ok) throw new Error(`verify failed: ${verified.reason}`)
  store.install({ manifest, teamBytes: built.teamBytes })
  return manifest.id
}

let base = ''
let store: PresetStore
beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'cookrew-e2e-'))
  store = new PresetStore(base)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

/**
 * The whole client half in one pass: publish → verify → persist → chip → arm →
 * place. Each step consumes the previous one's real output, so a contract that
 * drifts between two slices fails here rather than on someone's canvas.
 */
describe('publish → install → chip → place', () => {
  it('lands a single-agent preset as a plain terminal in the BUYER dir', () => {
    const id = publishAndInstall(store, [terminal()], 'Deep Research')

    const chips = presetChips(store.list())
    expect(chips).toHaveLength(1)
    expect(chips[0].kind).toBe('single')
    expect(chipAction(chips[0])).toBe('place')

    // What the preset:place handler does with the armed id.
    const stored = store.read(id)
    expect(stored).not.toBeNull()
    const snapshot = JSON.parse(stored!.teamBytes.toString('utf8')) as TeamSnapshot
    const plan = planPresetImport(snapshot, { dirs: ['/home/buyer/app'], cutAt: 1, manifestId: id })

    expect(plan.kind).toBe('single')
    if (plan.kind !== 'single') return
    expect(plan.node.preset).toBe('Claude Code')
    // The author's absolute path never reaches the buyer's canvas.
    expect(plan.node.cwd).toBe('/home/buyer/app')
    expect(JSON.stringify(plan.node)).not.toContain('/authors/machine')
  })

  it('lands a team preset as a copyTeam snapshot source', () => {
    const id = publishAndInstall(
      store,
      [terminal(), terminal({ id: 't2', name: 'Tinker', preset: 'Codex' })],
      'Ship Crew'
    )
    const chips = presetChips(store.list())
    expect(chips[0].kind).toBe('team')
    expect(chips[0].sprites).toEqual(['Claude Code', 'Codex'])

    const snapshot = JSON.parse(store.read(id)!.teamBytes.toString('utf8')) as TeamSnapshot
    const plan = planPresetImport(snapshot, { dirs: ['/home/buyer/app'], cutAt: 1, manifestId: id })
    expect(plan.kind).toBe('team')
    if (plan.kind !== 'team') return
    expect(plan.source.fromSnapshot).toBe(true)
    expect(plan.spec.nodeIds).toEqual([])
    expect(plan.source.dirs).toEqual(['/home/buyer/app'])
  })

  it('A2: uninstalling removes the chip and leaves an already-placed agent alone', () => {
    const id = publishAndInstall(store, [terminal()], 'Deep Research')
    const snapshot = JSON.parse(store.read(id)!.teamBytes.toString('utf8')) as TeamSnapshot
    const plan = planPresetImport(snapshot, { dirs: ['/home/buyer/app'], cutAt: 1, manifestId: id })
    if (plan.kind !== 'single') throw new Error('expected single')
    // The node as it now lives on the canvas — a plain terminal, holding no
    // reference back to the preset it came from.
    const placed = plan.node
    const placedBefore = JSON.stringify(placed)

    store.uninstall(id)

    expect(presetChips(store.list())).toEqual([])
    expect(store.read(id)).toBeNull()
    // Nothing about the placed agent changed, and nothing in it points at the
    // store that just lost the preset — which is WHY uninstall cannot break it.
    expect(JSON.stringify(placed)).toBe(placedBefore)
    expect(JSON.stringify(placed)).not.toContain(id)
    expect(placed.kind).toBe('terminal')
  })

  it('refuses to place from a store entry whose blob was tampered with', () => {
    const id = publishAndInstall(store, [terminal()], 'Deep Research')
    const dir = path.join(base, 'presets', id.replace(':', '-'))
    rmSync(path.join(dir, 'team.json'))
    // read() is what the place handler calls; null means it never plans.
    expect(store.read(id)).toBeNull()
    expect(presetChips(store.list())).toEqual([])
  })
})
