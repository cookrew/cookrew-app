import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RecoverableStore, RecoverableSnapshot } from '../src/main/recoverable'
import type { TerminalNodeData } from '../src/shared/model'

function node(id: string, over: Partial<TerminalNodeData> = {}): TerminalNodeData {
  return {
    kind: 'terminal', id, name: 'Fresco', preset: 'Claude Code',
    command: 'claude --permission-mode bypassPermissions', cwd: '/work/repo',
    orch: false, role: null, claudeSessionId: 'sess-1',
    position: { x: 10, y: 20 }, size: { width: 640, height: 420 }, ...over
  }
}

function snap(id: string, over: Partial<RecoverableSnapshot> = {}): RecoverableSnapshot {
  return { node: node(id), workspaceId: 'ws-a', workspaceName: 'Cookrew Dev', peers: ['p1', 'p2'], savedAt: 1, ...over }
}

function makeStore(): { store: RecoverableStore; file: string } {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-recov-')), 'recoverable.json')
  return { store: new RecoverableStore(file), file }
}

describe('RecoverableStore', () => {
  it('captures a snapshot and persists it across instances (durable)', () => {
    const { store, file } = makeStore()
    store.capture(snap('t1'))
    const reloaded = new RecoverableStore(file)
    const got = reloaded.get('t1')
    expect(got?.node.claudeSessionId).toBe('sess-1')
    expect(got?.node.position).toEqual({ x: 10, y: 20 })
    expect(got?.peers).toEqual(['p1', 'p2'])
    expect(got?.workspaceName).toBe('Cookrew Dev')
  })

  it('upserts by node id and removes on recover', () => {
    const { store } = makeStore()
    store.capture(snap('t1'))
    store.capture(snap('t1', { peers: ['p3'] }))
    expect(store.list()).toHaveLength(1)
    expect(store.get('t1')?.peers).toEqual(['p3'])
    store.remove('t1')
    expect(store.get('t1')).toBeUndefined()
  })

  it('preserves any harness session ref (codex/opencode too)', () => {
    const { store, file } = makeStore()
    store.capture(snap('cx', { node: node('cx', { preset: 'Codex', command: 'codex', claudeSessionId: null, codexSessionRef: '/x/rollout-uuid.jsonl' }) }))
    store.capture(snap('oc', { node: node('oc', { preset: 'OpenCode', command: 'opencode', claudeSessionId: null, opencodeSessionId: 'oc-1' }) }))
    const r = new RecoverableStore(file)
    expect(r.get('cx')?.node.codexSessionRef).toBe('/x/rollout-uuid.jsonl')
    expect(r.get('oc')?.node.opencodeSessionId).toBe('oc-1')
  })

  it('survives a corrupt file', () => {
    const { file } = makeStore()
    writeFileSync(file, '{not json', 'utf8')
    const store = new RecoverableStore(file)
    expect(store.list()).toEqual([])
    store.capture(snap('t1'))
    expect(store.get('t1')).toBeDefined()
  })
})

import { planRecovery, RecoveryContext } from '../src/main/recoverable'

describe('planRecovery (Conductor edge/boot rules)', () => {
  const base: RecoveryContext = {
    activeWorkspaceId: 'ws-a',
    workspaceExists: () => true,
    nodeExists: () => true,
    isOrch: () => false,
    currentOrchId: 'orch-x'
  }

  it('restores surviving peers and wires the current orch when none reaches one', () => {
    const plan = planRecovery(snap('t1', { peers: ['p1', 'p2'] }), base)
    expect(plan.peerEdges).toEqual(['p1', 'p2'])
    expect(plan.orchEdge).toBe('orch-x') // no surviving peer is an orch
    expect(plan.spawn).toBe(true)
  })

  it('does NOT duplicate an orch edge the snapshot already provides', () => {
    const plan = planRecovery(snap('t1', { peers: ['orch-p'] }), {
      ...base,
      isOrch: (id) => id === 'orch-p'
    })
    expect(plan.peerEdges).toEqual(['orch-p'])
    expect(plan.orchEdge).toBeNull() // a surviving peer already reaches an orch
  })

  it('drops peers that no longer exist', () => {
    const plan = planRecovery(snap('t1', { peers: ['p1', 'gone'] }), {
      ...base,
      nodeExists: (id) => id !== 'gone'
    })
    expect(plan.peerEdges).toEqual(['p1'])
  })

  it('inactive target workspace: recover WITHOUT booting the PTY', () => {
    const plan = planRecovery(snap('t1', { workspaceId: 'ws-b' }), base)
    expect(plan.targetWorkspaceId).toBe('ws-b')
    expect(plan.spawn).toBe(false) // deferred to workspace activation
  })

  it('vanished source workspace falls back to the active one (and boots)', () => {
    const plan = planRecovery(snap('t1', { workspaceId: 'ws-gone' }), {
      ...base,
      workspaceExists: (id) => id !== 'ws-gone'
    })
    expect(plan.targetWorkspaceId).toBe('ws-a')
    expect(plan.spawn).toBe(true)
  })

  it('caps retained snapshots at the newest 100 by savedAt (MEDIUM-4)', () => {
    const dir=mkdtempSync(path.join(tmpdir(),'recov-'))
    const store=new RecoverableStore(path.join(dir,'recoverable.json'))
    for (let i=1;i<=101;i++) {
      store.capture({ ...snap('t'+i), savedAt: i })
    }
    expect(store.get('t1')).toBeUndefined()
    expect(store.get('t2')).toBeDefined()
    expect(store.get('t101')).toBeDefined()
  })
})

