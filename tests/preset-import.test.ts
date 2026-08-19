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
    if (plan.kind !== 'single') return
    expect(plan.node.kind).toBe('terminal')
    expect(plan.node.preset).toBe('Claude Code')
    expect(plan.node.cwd).toBe('/home/buyer/app')
  })

  it('lands idle with no session binding — a pasted preset never auto-runs', () => {
    const plan = planPresetImport(published(), { dirs: ['/home/buyer/app'], cutAt: 5 })
    if (plan.kind !== 'single') return
    expect(plan.node.claudeSessionId ?? null).toBeNull()
    expect(plan.node.pendingInject ?? null).toBeNull()
  })
})

describe('planPresetImport — a team goes through the existing copyTeam engine', () => {
  const team = (): TeamSnapshot =>
    published([terminal(), terminal({ id: 't2', name: 'Tinker' }), note('brief')])

  it('hands copyTeam a snapshot source for the WHOLE saved team', () => {
    const plan = planPresetImport(team(), { dirs: ['/home/buyer/app'], cutAt: 5 })
    expect(plan.kind).toBe('team')
    if (plan.kind !== 'team') return
    // fromSnapshot + empty nodeIds is copyTeam's "the whole saved team".
    expect(plan.source.fromSnapshot).toBe(true)
    expect(plan.spec.nodeIds).toEqual([])
    expect(plan.source.nodes).toHaveLength(3)
  })

  it('gives the engine the buyer dirs, already mapped', () => {
    const plan = planPresetImport(team(), { dirs: ['/home/buyer/app'], cutAt: 5 })
    if (plan.kind !== 'team') return
    expect(plan.source.dirs).toEqual(['/home/buyer/app'])
    expect(JSON.stringify(plan.source.nodes)).not.toContain('{{dir')
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
      pins: [{ version: 1, scrollLine: 0, cutAt: 1 }]
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
