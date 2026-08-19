import { describe, expect, it } from 'vitest'
import { applyWorkdirs, planPresetImport } from '../src/main/preset-import'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

const terminal = (over: Record<string, unknown> = {}): CanvasNode =>
  ({
    kind: 'terminal',
    id: 't1',
    name: 'Forge',
    preset: 'Claude Code',
    command: 'npm test',
    cwd: '{{dir0}}',
    orch: false,
    role: 'Developer',
    position: { x: 0, y: 0 },
    size: { width: 10, height: 10 },
    ...over
  }) as CanvasNode

const note = (content: string): CanvasNode =>
  ({
    kind: 'note',
    id: 'n1',
    name: 'n',
    customName: null,
    content,
    locked: false,
    position: { x: 0, y: 0 },
    size: { width: 10, height: 10 }
  }) as CanvasNode

const published = (nodes: CanvasNode[] = [terminal()]): TeamSnapshot => ({
  name: 'crew',
  savedAt: 1_700_000_000_000,
  dir: '{{dir0}}',
  dirs: ['{{dir0}}', '{{dir1}}'],
  nodes,
  connections: [],
  turns: {}
})

describe('applyWorkdirs — the installer maps placeholders to the buyer', () => {
  it('replaces every placeholder by index, primary first', () => {
    const out = applyWorkdirs(published(), ['/home/buyer/app', '/home/buyer/side'])
    expect(out.dir).toBe('/home/buyer/app')
    expect(out.dirs).toEqual(['/home/buyer/app', '/home/buyer/side'])
    expect((out.nodes[0] as { cwd: string }).cwd).toBe('/home/buyer/app')
  })

  it('falls back to the primary dir when the buyer supplies fewer', () => {
    const out = applyWorkdirs(published([terminal({ cwd: '{{dir1}}' })]), ['/home/buyer/app'])
    expect((out.nodes[0] as { cwd: string }).cwd).toBe('/home/buyer/app')
  })

  it('rewrites placeholders EMBEDDED in commands and notes too', () => {
    const out = applyWorkdirs(
      published([terminal({ command: 'cd {{dir0}} && npm test' }), note('see {{dir0}}/README.md')]),
      ['/home/buyer/app']
    )
    expect(JSON.stringify(out)).not.toContain('{{dir')
    expect((out.nodes[0] as { command: string }).command).toBe('cd /home/buyer/app && npm test')
  })

  it('refuses with no target dir rather than landing a preset on a placeholder', () => {
    expect(() => applyWorkdirs(published(), [])).toThrow(/workdir/i)
  })

  it('never mutates the published snapshot', () => {
    const snap = published()
    const before = JSON.stringify(snap)
    applyWorkdirs(snap, ['/home/buyer/app'])
    expect(JSON.stringify(snap)).toBe(before)
  })
})

describe('planPresetImport — single agent is a NORMAL terminal, no new node kind', () => {
  it('plans a plain terminal for a one-agent preset', () => {
    const plan = planPresetImport(published(), { dirs: ['/home/buyer/app'], cutAt: 5 })
    expect(plan.kind).toBe('single')
    expect(plan.nodes).toHaveLength(1)
    const node = plan.nodes[0] as Extract<CanvasNode, { kind: 'terminal' }>
    expect(node.kind).toBe('terminal')
    expect(node.preset).toBe('Claude Code')
    expect(node.cwd).toBe('/home/buyer/app')
    // H4: command survives — placement used to forward only name/preset.
    expect(node.command).toBe('npm test')
  })

  it('lands idle with no session binding — a pasted preset never auto-runs', () => {
    const plan = planPresetImport(published(), { dirs: ['/home/buyer/app'], cutAt: 5 })
    const node = plan.nodes[0] as Extract<CanvasNode, { kind: 'terminal' }>
    expect(node.claudeSessionId ?? null).toBeNull()
    expect(node.pendingInject ?? null).toBeNull()
  })
})

describe('planPresetImport — a team goes through the existing copyTeam engine', () => {
  const team = (): TeamSnapshot =>
    published([terminal(), terminal({ id: 't2', name: 'Tinker' }), note('brief')])

  it('C3: plans CONCRETE nodes, not a copyTeam spec that throws', () => {
    // copyTeam is workspace-to-workspace and ignores a caller snapshot; the
    // old plan threw on its first guard every time, hidden by an `as never`.
    const plan = planPresetImport(team(), { dirs: ['/home/buyer/app'], cutAt: 5 })
    expect(plan.kind).toBe('team')
    expect(plan.nodes).toHaveLength(3)
    expect(JSON.stringify(plan.nodes)).not.toContain('{{dir')
  })

  it('gives every placed node a FRESH id and remaps the cables onto them', () => {
    let n = 0
    const src = team()
    src.connections = [{ id: 'c1', a: 't1', b: 't2' }]
    const plan = planPresetImport(src, {
      dirs: ['/home/buyer/app'],
      cutAt: 5,
      newId: () => `new-${++n}`
    })
    expect(plan.nodes.map((x) => x.id)).toEqual(['new-1', 'new-2', 'new-3'])
    expect(plan.connections).toEqual([{ id: 'new-4', a: 'new-1', b: 'new-2' }])
  })

  it('anchors the layout at the click, preserving relative geometry', () => {
    const src = team()
    // Every node, so the selection's top-left is unambiguous — the note sitting
    // at 0,0 is what made an earlier expectation here wrong.
    src.nodes[0].position = { x: 100, y: 100 }
    src.nodes[1].position = { x: 140, y: 180 }
    src.nodes[2].position = { x: 100, y: 260 }
    const plan = planPresetImport(src, {
      dirs: ['/home/buyer/app'],
      cutAt: 5,
      position: { x: 1000, y: 2000 }
    })
    expect(plan.nodes[0].position).toEqual({ x: 1000, y: 2000 })
    expect(plan.nodes[1].position).toEqual({ x: 1040, y: 2080 })
  })

  it('drops a cable naming a node the preset does not ship', () => {
    const src = team()
    src.connections = [{ id: 'c1', a: 't1', b: 'ghost' }]
    expect(planPresetImport(src, { dirs: ['/home/buyer/app'], cutAt: 5 }).connections).toEqual([])
  })
})

describe('planPresetImport — the import IS a version (§10)', () => {
  it('cuts v1 for a fresh install', () => {
    const plan = planPresetImport(published(), { dirs: ['/home/buyer/app'], cutAt: 5 })
    expect(plan.pin.version).toBe(1)
    expect(plan.pin.cutAt).toBe(5)
  })

  it('cuts the next version when the buyer already holds earlier ones', () => {
    const plan = planPresetImport(published(), {
      dirs: ['/home/buyer/app'],
      cutAt: 5,
      pins: [{ version: 1, atIndex: 0, scrollLine: 0, cutAt: 1 }]
    })
    expect(plan.pin.version).toBe(2)
  })

  it('records the manifest the version came from', () => {
    const plan = planPresetImport(published(), {
      dirs: ['/home/buyer/app'],
      cutAt: 5,
      manifestId: 'sha256:abc'
    })
    expect(plan.pin.manifestId).toBe('sha256:abc')
  })

  it('never mutates the published snapshot — the original stays immutable', () => {
    const snap = published()
    const before = JSON.stringify(snap)
    planPresetImport(snap, { dirs: ['/home/buyer/app'], cutAt: 5 })
    expect(JSON.stringify(snap)).toBe(before)
  })
})
