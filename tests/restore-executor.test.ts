import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CanvasNode, RestorePoint, TerminalNodeData } from '../src/shared/model'
import { createRestoreHandlers, registerRestoreIpc, RestoreExecutorDeps, RestoreHandlers } from '../src/main/restore'
import { claudeProjectDir } from '../src/main/claude-fork'

const U1 = '1e54c8a8-4e59-49e7-979c-8b9dccb361c3'
const U2 = '2ab34c8a-1111-4e49-879c-8b9dccb36abc'
const U3 = '3cd45d9b-2222-4f5a-9a0d-9c0eedd472bcd'

function makeNode(overrides: Partial<TerminalNodeData> = {}): TerminalNodeData {
  return {
    kind: 'terminal',
    id: 't1',
    name: 'Test Agent',
    preset: 'claude',
    command: 'claude --permission-mode bypassPermissions',
    cwd: '/tmp/cookrew-restore-test',
    orch: false,
    role: null,
    claudeSessionId: 'aa000000-0000-4000-8000-000000000001',
    position: { x: 0, y: 0 },
    size: { width: 300, height: 200 },
    ...overrides
  }
}

function promptLine(uuid: string, text: string, sessionId: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    sessionId,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: text }
  })
}

function replyLine(uuid: string, sessionId: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    sessionId,
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }
  })
}

function sessionLines(sessionId: string): string[] {
  return [
    JSON.stringify({ type: 'mode', sessionId }),
    promptLine(U1, 'prompt 1', sessionId),
    replyLine('a1', sessionId),
    promptLine(U2, 'prompt 2', sessionId),
    replyLine('a2', sessionId),
    promptLine(U3, 'prompt 3', sessionId),
    replyLine('a3', sessionId)
  ]
}

function writeSession(cwd: string, sessionId: string, lines: string[], projectsDir: string): void {
  const dir = claudeProjectDir(cwd, projectsDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
}

function makeDeps(
  getNode: () => TerminalNodeData,
  opts: {
    projectsDir: string
    checkpointRefs?: { index: number; id: string; sessionId?: string }[]
  }
): { deps: RestoreExecutorDeps; calls: { spawn: unknown[]; updates: Partial<CanvasNode>[] } } {
  const calls = { spawn: [] as unknown[], updates: [] as Partial<CanvasNode>[] }
  const deps: RestoreExecutorDeps = {
    store: {
      nodeAcrossWorkspaces: () => ({ node: getNode(), workspaceId: 'ws1' }),
      updateNodeUnsafe: (_id, patch) => {
        calls.updates.push(patch)
        return { ...getNode(), ...patch } as TerminalNodeData
      }
    },
    ptys: {
      killAndWait: vi.fn().mockResolvedValue(undefined)
    },
    traces: {
      checkpointRefs: vi.fn().mockResolvedValue(opts.checkpointRefs ?? [])
    },
    spawnTracked: (n) => {
      calls.spawn.push(n)
    },
    projectsDir: opts.projectsDir
  }
  return { deps, calls }
}

describe('registerRestoreIpc (M10: restore IPC block lives beside the executor)', () => {
  it('registers both channels and delegates in argument order', async () => {
    const registered = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const handlers: RestoreHandlers = {
      restoreCheckpoint: vi.fn().mockResolvedValue({ ok: true }),
      undoRestore: vi.fn().mockResolvedValue({ ok: true, undone: true })
    } as unknown as RestoreHandlers
    registerRestoreIpc((channel, listener) => {
      registered.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
    }, handlers)

    expect([...registered.keys()].sort()).toEqual([
      'agent:restore-checkpoint',
      'agent:undo-restore'
    ])
    await registered.get('agent:restore-checkpoint')!(null, 't1', 3)
    expect(handlers.restoreCheckpoint).toHaveBeenCalledWith('t1', 3, undefined)
    // A targeted rewind carries the segment the index is counted in.
    await registered.get('agent:restore-checkpoint')!(null, 't1', 2, 'aa000000-0000-4000-8000-000000000006')
    expect(handlers.restoreCheckpoint).toHaveBeenCalledWith(
      't1',
      2,
      'aa000000-0000-4000-8000-000000000006'
    )
    await registered.get('agent:undo-restore')!(null, 't1')
    expect(handlers.undoRestore).toHaveBeenCalledWith('t1')
  })
})

describe('createRestoreHandlers', () => {
  describe('restoreCheckpoint', () => {
    it('truncates the session at the checkpoint and rebinds the node', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      const node = makeNode({ cwd, claudeSessionId: 'aa000000-0000-4000-8000-000000000001' })
      writeSession(cwd, 'aa000000-0000-4000-8000-000000000001', sessionLines('aa000000-0000-4000-8000-000000000001'), tmp)
      const { deps, calls } = makeDeps(() => node, {
        projectsDir: tmp,
        checkpointRefs: [
          { index: 1, id: U1 },
          { index: 2, id: U2 },
          { index: 3, id: U3 }
        ]
      })

      const result = await createRestoreHandlers(deps).restoreCheckpoint('t1', 2)

      expect(result.ok).toBe(true)
      expect(result.checkpointIndex).toBe(2)
      expect(result.previousSessionId).toBe('aa000000-0000-4000-8000-000000000001')
      expect(result.sessionId).toBeDefined()
      expect(result.sessionId).not.toBe('aa000000-0000-4000-8000-000000000001')

      // Original file intact.
      expect(existsSync(path.join(claudeProjectDir(cwd, tmp), 'aa000000-0000-4000-8000-000000000001.jsonl'))).toBe(true)
      // New truncated file exists.
      const newFile = path.join(claudeProjectDir(cwd, tmp), `${result.sessionId}.jsonl`)
      expect(existsSync(newFile)).toBe(true)
      const newLines = readFileSync(newFile, 'utf8').split('\n').filter(Boolean)
      expect(newLines.length).toBeLessThan(sessionLines('aa000000-0000-4000-8000-000000000001').length)
      // Every kept record restamped with the new session id.
      for (const line of newLines) {
        const record = JSON.parse(line)
        if (typeof record.sessionId === 'string') {
          expect(record.sessionId).toBe(result.sessionId)
        }
      }

      // Node rebound and undo point pushed.
      expect(calls.updates).toHaveLength(1)
      expect(calls.updates[0]).toMatchObject({
        claudeSessionId: result.sessionId,
        restoreStack: [{ sessionId: 'aa000000-0000-4000-8000-000000000001', rewoundToIndex: 2 }]
      })
      expect(calls.spawn).toHaveLength(1)
      expect((calls.spawn[0] as TerminalNodeData).claudeSessionId).toBe(result.sessionId)
    })

    it('refuses a non-Claude terminal', async () => {
      const node = makeNode({ command: 'codex', claudeSessionId: undefined })
      const { deps } = makeDeps(() => node, { projectsDir: mkdtempSync(path.join(tmpdir(), 'restore-')) })

      const result = await createRestoreHandlers(deps).restoreCheckpoint('t1', 1)

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/plain shell|isn't supported for codex/i)
    })

    it('refuses when there is no bound session id', async () => {
      const node = makeNode({ claudeSessionId: undefined })
      const { deps } = makeDeps(() => node, { projectsDir: mkdtempSync(path.join(tmpdir(), 'restore-')) })

      const result = await createRestoreHandlers(deps).restoreCheckpoint('t1', 1)

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/No bound Claude session file/i)
    })

    it('M1: refuses a non-UUID bound session id (tampered store) — no file read, no kill', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const node = makeNode({ cwd: path.join(tmp, 'project'), claudeSessionId: '../../etc/evil' })
      const { deps, calls } = makeDeps(() => node, {
        projectsDir: tmp,
        checkpointRefs: [{ index: 1, id: U1 }]
      })

      const result = await createRestoreHandlers(deps).restoreCheckpoint('t1', 1)

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/malformed/i)
      expect(deps.ptys.killAndWait).not.toHaveBeenCalled()
      expect(calls.updates).toHaveLength(0)
      expect(calls.spawn).toHaveLength(0)
    })

    it('M1: refuses a non-UUID checkpoint session id from the refs', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      const node = makeNode({ cwd })
      writeSession(cwd, node.claudeSessionId!, sessionLines(node.claudeSessionId!), tmp)
      const { deps } = makeDeps(() => node, {
        projectsDir: tmp,
        checkpointRefs: [{ index: 1, id: U1, sessionId: '../../etc/evil' }]
      })

      const result = await createRestoreHandlers(deps).restoreCheckpoint('t1', 1)

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/malformed/i)
      expect(deps.ptys.killAndWait).not.toHaveBeenCalled()
    })

    it('refuses an unknown checkpoint index', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const node = makeNode({ cwd: path.join(tmp, 'project'), claudeSessionId: 'aa000000-0000-4000-8000-000000000001' })
      writeSession(node.cwd, 'aa000000-0000-4000-8000-000000000001', sessionLines('aa000000-0000-4000-8000-000000000001'), tmp)
      const { deps } = makeDeps(() => node, {
        projectsDir: tmp,
        checkpointRefs: [{ index: 1, id: U1 }]
      })

      const result = await createRestoreHandlers(deps).restoreCheckpoint('t1', 99)

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/No checkpoint 99/i)
    })

    it('refuses when the source session file is missing', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const node = makeNode({ cwd: path.join(tmp, 'project'), claudeSessionId: 'aa000000-0000-4000-8000-000000000001' })
      const { deps } = makeDeps(() => node, {
        projectsDir: tmp,
        checkpointRefs: [{ index: 1, id: U1 }]
      })

      const result = await createRestoreHandlers(deps).restoreCheckpoint('t1', 1)

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/session file no longer exists/i)
    })

    it('refuses a checkpoint whose id is not a real uuid', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const node = makeNode({ cwd: path.join(tmp, 'project'), claudeSessionId: 'aa000000-0000-4000-8000-000000000001' })
      writeSession(node.cwd, 'aa000000-0000-4000-8000-000000000001', sessionLines('aa000000-0000-4000-8000-000000000001'), tmp)
      const { deps } = makeDeps(() => node, {
        projectsDir: tmp,
        checkpointRefs: [{ index: 1, id: 'not-a-uuid' }]
      })

      const result = await createRestoreHandlers(deps).restoreCheckpoint('t1', 1)

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/no exact message identity/i)
    })

    it('pushes multiple restore points and caps the undo stack', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      let node = makeNode({ cwd, claudeSessionId: 'aa000000-0000-4000-8000-000000000001' })
      writeSession(cwd, 'aa000000-0000-4000-8000-000000000001', sessionLines('aa000000-0000-4000-8000-000000000001'), tmp)
      const { deps, calls } = makeDeps(() => node, {
        projectsDir: tmp,
        checkpointRefs: [
          { index: 1, id: U1 },
          { index: 2, id: U2 },
          { index: 3, id: U3 }
        ]
      })
      // Simulate a growing stack across repeated restores.
      let stack: { sessionId: string; at: number; rewoundToIndex: number }[] = []
      deps.store.updateNodeUnsafe = (_id, patch) => {
        stack = ((patch as Partial<TerminalNodeData>).restoreStack as typeof stack) ?? stack
        calls.updates.push(patch)
        node = { ...node, ...patch } as TerminalNodeData
        return node
      }
      deps.traces.checkpointRefs = vi.fn().mockResolvedValue([
        { index: 1, id: U1 },
        { index: 2, id: U2 },
        { index: 3, id: U3 }
      ])

      const ids: string[] = []
      for (let i = 0; i < 12; i++) {
        const r = await createRestoreHandlers(deps).restoreCheckpoint('t1', 1)
        expect(r.ok).toBe(true)
        ids.push(r.sessionId!)
        // Update the mock source file for the next restore so it doesn't fail on missing file.
        writeSession(cwd, r.sessionId!, sessionLines(r.sessionId!), tmp)
      }

      // Stack should be capped at 10 and contain the 10 most recent previous sessions.
      expect(stack.length).toBe(10)
      expect(stack[0].sessionId).toBe(ids[ids.length - 2])
      expect(stack[9].sessionId).toBe(ids[ids.length - 11])
      expect(new Set(stack.map((s) => s.sessionId)).size).toBe(10)
    })
  })

  describe('undoRestore', () => {
    it('rebinds to the previous session and pops the undo stack', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      const previousId = 'bb000000-0000-4000-8000-000000000001'
      const currentId = 'aa000000-0000-4000-8000-000000000002'
      writeSession(cwd, previousId, sessionLines(previousId), tmp)
      const node = makeNode({
        cwd,
        claudeSessionId: currentId,
        restoreStack: [{ sessionId: previousId, at: Date.now(), rewoundToIndex: 2 }]
      })
      const { deps, calls } = makeDeps(() => node, { projectsDir: tmp })

      const result = await createRestoreHandlers(deps).undoRestore('t1')

      expect(result.ok).toBe(true)
      expect(result.undone).toBe(true)
      expect(result.sessionId).toBe(previousId)
      expect(result.previousSessionId).toBe(currentId)
      expect(result.checkpointIndex).toBe(2)

      expect(calls.updates).toHaveLength(1)
      expect(calls.updates[0]).toMatchObject({
        claudeSessionId: previousId,
        restoreStack: []
      })
      expect(calls.spawn).toHaveLength(1)
      expect((calls.spawn[0] as TerminalNodeData).claudeSessionId).toBe(previousId)
    })

    it('refuses when the undo stack is empty', async () => {
      const node = makeNode({ restoreStack: [] })
      const { deps } = makeDeps(() => node, { projectsDir: mkdtempSync(path.join(tmpdir(), 'restore-')) })

      const result = await createRestoreHandlers(deps).undoRestore('t1')

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/Nothing to undo/i)
    })

    it('M9: undoes a LEGACY pre-rename stack entry (fromIndex only)', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      const previousId = 'bb000000-0000-4000-8000-000000000001'
      writeSession(cwd, previousId, sessionLines(previousId), tmp)
      const node = makeNode({
        cwd,
        // Persisted before the M9 rename: fromIndex, no rewoundToIndex.
        // `as RestorePoint`: this literal deliberately lacks rewoundToIndex,
        // which is exactly what a pre-M9 persisted stack looks like on disk.
        restoreStack: [{ sessionId: previousId, at: Date.now(), fromIndex: 2 } as RestorePoint]
      })
      const { deps } = makeDeps(() => node, { projectsDir: tmp })

      const result = await createRestoreHandlers(deps).undoRestore('t1')

      expect(result.ok).toBe(true)
      expect(result.checkpointIndex).toBe(2)
      expect(result.sessionId).toBe(previousId)
    })

    it('M1: refuses a non-UUID undo-stack session id (tampered store) — no file read, no kill', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const node = makeNode({
        cwd: path.join(tmp, 'project'),
        restoreStack: [{ sessionId: '../../etc/evil', at: Date.now(), fromIndex: 2 } as RestorePoint]
      })
      const { deps, calls } = makeDeps(() => node, { projectsDir: tmp })

      const result = await createRestoreHandlers(deps).undoRestore('t1')

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/malformed/i)
      expect(deps.ptys.killAndWait).not.toHaveBeenCalled()
      expect(calls.updates).toHaveLength(0)
      expect(calls.spawn).toHaveLength(0)
    })

    it('refuses when the previous session file is missing', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      const node = makeNode({
        cwd,
        claudeSessionId: 'aa000000-0000-4000-8000-000000000002',
        restoreStack: [{ sessionId: 'aa000000-0000-4000-8000-000000000003', at: Date.now(), rewoundToIndex: 2 }]
      })
      const { deps } = makeDeps(() => node, { projectsDir: tmp })

      const result = await createRestoreHandlers(deps).undoRestore('t1')

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/previous session file no longer exists/i)
    })

    it('preserves older undo points after undoing the newest', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      writeSession(cwd, 'aa000000-0000-4000-8000-000000000004', sessionLines('aa000000-0000-4000-8000-000000000004'), tmp)
      writeSession(cwd, 'aa000000-0000-4000-8000-000000000005', sessionLines('aa000000-0000-4000-8000-000000000005'), tmp)
      const node = makeNode({
        cwd,
        claudeSessionId: 'aa000000-0000-4000-8000-000000000002',
        restoreStack: [
          { sessionId: 'aa000000-0000-4000-8000-000000000005', at: Date.now(), rewoundToIndex: 3 },
          { sessionId: 'aa000000-0000-4000-8000-000000000004', at: Date.now() - 1000, rewoundToIndex: 2 }
        ]
      })
      const { deps, calls } = makeDeps(() => node, { projectsDir: tmp })

      const result = await createRestoreHandlers(deps).undoRestore('t1')

      expect(result.ok).toBe(true)
      expect(result.sessionId).toBe('aa000000-0000-4000-8000-000000000005')
      expect(calls.updates[0]).toMatchObject({
        claudeSessionId: 'aa000000-0000-4000-8000-000000000005',
        restoreStack: [{ sessionId: 'aa000000-0000-4000-8000-000000000004', rewoundToIndex: 2 }]
      })
    })
  })

  describe('busy-agent refusal (never kill a writing CLI)', () => {
    it('restore refuses while the agent is thinking — no kill, no rebind, no spawn', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      const node = makeNode({ cwd, claudeSessionId: 'aa000000-0000-4000-8000-000000000001' })
      writeSession(cwd, 'aa000000-0000-4000-8000-000000000001', sessionLines('aa000000-0000-4000-8000-000000000001'), tmp)
      const { deps, calls } = makeDeps(() => node, {
        projectsDir: tmp,
        checkpointRefs: [{ index: 1, id: U1 }]
      })
      deps.phaseOf = () => 'thinking'

      const result = await createRestoreHandlers(deps).restoreCheckpoint('t1', 1)

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/thinking/)
      expect(deps.ptys.killAndWait).not.toHaveBeenCalled()
      expect(calls.updates).toHaveLength(0)
      expect(calls.spawn).toHaveLength(0)
    })

    it('undo refuses while the agent is waiting on a prompt', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      writeSession(cwd, 'aa000000-0000-4000-8000-000000000004', sessionLines('aa000000-0000-4000-8000-000000000004'), tmp)
      const node = makeNode({
        cwd,
        claudeSessionId: 'aa000000-0000-4000-8000-000000000002',
        restoreStack: [{ sessionId: 'aa000000-0000-4000-8000-000000000004', at: Date.now(), rewoundToIndex: 2 }]
      })
      const { deps, calls } = makeDeps(() => node, { projectsDir: tmp })
      deps.phaseOf = () => 'waiting'

      const result = await createRestoreHandlers(deps).undoRestore('t1')

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/waiting/)
      expect(deps.ptys.killAndWait).not.toHaveBeenCalled()
      expect(calls.updates).toHaveLength(0)
    })

    it('a replied/idle agent restores normally (guard does not over-fire)', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      const node = makeNode({ cwd, claudeSessionId: 'aa000000-0000-4000-8000-000000000001' })
      writeSession(cwd, 'aa000000-0000-4000-8000-000000000001', sessionLines('aa000000-0000-4000-8000-000000000001'), tmp)
      const { deps } = makeDeps(() => node, {
        projectsDir: tmp,
        checkpointRefs: [{ index: 1, id: U1 }]
      })
      deps.phaseOf = () => 'replied'

      const result = await createRestoreHandlers(deps).restoreCheckpoint('t1', 1)

      expect(result.ok).toBe(true)
    })

    it('restore refuses while a dispatch is armed — attached phase cannot see it (Sol r4 P1)', async () => {
      // A detached/background agent mid-dispatch reads as phase null: the
      // old guard passed, and restore killed the CLI and forked the session
      // file out from under a live commercial reservation.
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      const node = makeNode({ cwd, claudeSessionId: 'aa000000-0000-4000-8000-000000000001' })
      writeSession(cwd, 'aa000000-0000-4000-8000-000000000001', sessionLines('aa000000-0000-4000-8000-000000000001'), tmp)
      const { deps, calls } = makeDeps(() => node, {
        projectsDir: tmp,
        checkpointRefs: [{ index: 1, id: U1 }]
      })
      deps.phaseOf = () => null // detached: the tracker cannot see the agent
      deps.hasArmedDispatch = (id) => id === 't1'

      const result = await createRestoreHandlers(deps).restoreCheckpoint('t1', 1)

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/dispatch in flight/i)
      expect(deps.ptys.killAndWait).not.toHaveBeenCalled()
      expect(calls.updates).toHaveLength(0)
    })

    it('undo refuses while a dispatch is armed', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      writeSession(cwd, 'aa000000-0000-4000-8000-000000000004', sessionLines('aa000000-0000-4000-8000-000000000004'), tmp)
      const node = makeNode({
        cwd,
        claudeSessionId: 'aa000000-0000-4000-8000-000000000002',
        restoreStack: [{ sessionId: 'aa000000-0000-4000-8000-000000000004', at: Date.now(), rewoundToIndex: 2 }]
      })
      const { deps, calls } = makeDeps(() => node, { projectsDir: tmp })
      deps.hasArmedDispatch = () => true

      const result = await createRestoreHandlers(deps).undoRestore('t1')

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/dispatch in flight/i)
      expect(deps.ptys.killAndWait).not.toHaveBeenCalled()
      expect(calls.updates).toHaveLength(0)
    })

    it('restore refuses on an OPEN TURN fact — detached human work counts too', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      const node = makeNode({ cwd, claudeSessionId: 'aa000000-0000-4000-8000-000000000001' })
      writeSession(cwd, 'aa000000-0000-4000-8000-000000000001', sessionLines('aa000000-0000-4000-8000-000000000001'), tmp)
      const { deps } = makeDeps(() => node, {
        projectsDir: tmp,
        checkpointRefs: [{ index: 1, id: U1 }]
      })
      deps.hasOpenWork = (id) => id === 't1'

      const result = await createRestoreHandlers(deps).restoreCheckpoint('t1', 1)

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/open turn in flight/i)
      expect(deps.ptys.killAndWait).not.toHaveBeenCalled()
    })

    it('a dispatch arming DURING checkpoint resolution is caught at the pre-kill guard', async () => {
      // Both guard points consult the dispatch facts: quiet at entry, armed
      // by the time the multi-MB checkpoint read resolved — the TOCTOU
      // re-check must refuse before the kill.
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      const node = makeNode({ cwd, claudeSessionId: 'aa000000-0000-4000-8000-000000000001' })
      writeSession(cwd, 'aa000000-0000-4000-8000-000000000001', sessionLines('aa000000-0000-4000-8000-000000000001'), tmp)
      const { deps, calls } = makeDeps(() => node, {
        projectsDir: tmp,
        checkpointRefs: [{ index: 1, id: U1 }]
      })
      let armed = false
      deps.hasArmedDispatch = () => armed
      const originalRefs = deps.traces.checkpointRefs
      deps.traces.checkpointRefs = async (id: string) => {
        const refs = await originalRefs(id)
        armed = true // the dispatch lands while the read was in flight
        return refs
      }

      const result = await createRestoreHandlers(deps).restoreCheckpoint('t1', 1)

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/dispatch in flight/i)
      expect(deps.ptys.killAndWait).not.toHaveBeenCalled()
      expect(calls.updates).toHaveLength(0)
      // No orphaned truncated session copy was left behind either.
      expect(readdirSync(claudeProjectDir(cwd, tmp)).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1)
    })

    it('quiet agents with no dispatch facts wired restore exactly as before', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      const node = makeNode({ cwd, claudeSessionId: 'aa000000-0000-4000-8000-000000000001' })
      writeSession(cwd, 'aa000000-0000-4000-8000-000000000001', sessionLines('aa000000-0000-4000-8000-000000000001'), tmp)
      const { deps } = makeDeps(() => node, {
        projectsDir: tmp,
        checkpointRefs: [{ index: 1, id: U1 }]
      })
      deps.hasArmedDispatch = () => false
      deps.hasOpenWork = () => false

      const result = await createRestoreHandlers(deps).restoreCheckpoint('t1', 1)
      expect(result.ok).toBe(true)
    })

    it('H1: refuses when the agent goes busy DURING checkpoint resolution (TOCTOU re-check)', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      const node = makeNode({ cwd, claudeSessionId: 'aa000000-0000-4000-8000-000000000001' })
      writeSession(cwd, 'aa000000-0000-4000-8000-000000000001', sessionLines('aa000000-0000-4000-8000-000000000001'), tmp)
      const { deps, calls } = makeDeps(() => node, {
        projectsDir: tmp,
        checkpointRefs: [{ index: 1, id: U1 }]
      })
      // Idle at entry, thinking by the time checkpointRefs resolved.
      let phase = 'idle'
      deps.phaseOf = () => phase
      const originalRefs = deps.traces.checkpointRefs
      deps.traces.checkpointRefs = async (id: string) => {
        const refs = await originalRefs(id)
        phase = 'thinking'
        return refs
      }

      const result = await createRestoreHandlers(deps).restoreCheckpoint('t1', 1)

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/thinking/)
      // The kill never landed and no orphaned session copy was left behind.
      expect(deps.ptys.killAndWait).not.toHaveBeenCalled()
      expect(calls.updates).toHaveLength(0)
      expect(calls.spawn).toHaveLength(0)
    })
  })

  describe('failure paths (H2 — never leave a dead terminal or an orphaned copy)', () => {
    it('kill failure (e.g. timeout) unlinks the truncated copy and does not rebind', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      const node = makeNode({ cwd, claudeSessionId: 'aa000000-0000-4000-8000-000000000001' })
      writeSession(cwd, 'aa000000-0000-4000-8000-000000000001', sessionLines('aa000000-0000-4000-8000-000000000001'), tmp)
      const { deps, calls } = makeDeps(() => node, {
        projectsDir: tmp,
        checkpointRefs: [{ index: 1, id: U1 }]
      })
      deps.ptys.killAndWait = vi.fn().mockRejectedValue(new Error('tmux session survived the deadline'))
      const projectDir = claudeProjectDir(cwd, tmp)
      const before = new Set(readdirSync(projectDir))

      const result = await createRestoreHandlers(deps).restoreCheckpoint('t1', 1)

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/failed before rebind/i)
      expect(calls.updates).toHaveLength(0)
      expect(calls.spawn).toHaveLength(0)
      // No orphaned session copy remains.
      expect(readdirSync(projectDir).filter((f) => !before.has(f))).toHaveLength(0)
    })

    it('rebind failure AFTER a successful kill respawns the original binding and unlinks the copy', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      const node = makeNode({ cwd, claudeSessionId: 'aa000000-0000-4000-8000-000000000001' })
      writeSession(cwd, 'aa000000-0000-4000-8000-000000000001', sessionLines('aa000000-0000-4000-8000-000000000001'), tmp)
      const { deps, calls } = makeDeps(() => node, {
        projectsDir: tmp,
        checkpointRefs: [{ index: 1, id: U1 }]
      })
      // Node removed from another workspace mid-restore.
      deps.store.updateNodeUnsafe = () => undefined
      const projectDir = claudeProjectDir(cwd, tmp)
      const before = new Set(readdirSync(projectDir))

      const result = await createRestoreHandlers(deps).restoreCheckpoint('t1', 1)

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/Failed to rebind/i)
      // Rollback: exactly one respawn, with the ORIGINAL session binding.
      expect(calls.spawn).toHaveLength(1)
      expect((calls.spawn[0] as TerminalNodeData).claudeSessionId).toBe('aa000000-0000-4000-8000-000000000001')
      expect(readdirSync(projectDir).filter((f) => !before.has(f))).toHaveLength(0)
    })

    it('undo kill failure reports honestly without touching the node', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      writeSession(cwd, 'aa000000-0000-4000-8000-000000000004', sessionLines('aa000000-0000-4000-8000-000000000004'), tmp)
      const node = makeNode({
        cwd,
        claudeSessionId: 'aa000000-0000-4000-8000-000000000002',
        restoreStack: [{ sessionId: 'aa000000-0000-4000-8000-000000000004', at: Date.now(), rewoundToIndex: 2 }]
      })
      const { deps, calls } = makeDeps(() => node, { projectsDir: tmp })
      deps.ptys.killAndWait = vi.fn().mockRejectedValue(new Error('tmux session survived the deadline'))

      const result = await createRestoreHandlers(deps).undoRestore('t1')

      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/failed before rebind/i)
      expect(calls.updates).toHaveLength(0)
      expect(calls.spawn).toHaveLength(0)
    })
  })

  describe('per-terminal serialization (H3)', () => {
    it('a second restore on the same terminal waits for the first to finish', async () => {
      const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
      const cwd = path.join(tmp, 'project')
      let node = makeNode({ cwd, claudeSessionId: 'aa000000-0000-4000-8000-000000000001' })
      writeSession(cwd, 'aa000000-0000-4000-8000-000000000001', sessionLines('aa000000-0000-4000-8000-000000000001'), tmp)
      const { deps, calls } = makeDeps(() => node, {
        projectsDir: tmp,
        checkpointRefs: [{ index: 1, id: U1 }]
      })
      deps.store.updateNodeUnsafe = (_id, patch) => {
        calls.updates.push(patch)
        node = { ...node, ...patch } as TerminalNodeData
        return node
      }
      // First restore blocks inside checkpointRefs until released.
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let refsCalls = 0
      deps.traces.checkpointRefs = vi.fn().mockImplementation(async () => {
        refsCalls += 1
        if (refsCalls === 1) await gate
        return [{ index: 1, id: U1 }]
      })

      const handlers = createRestoreHandlers(deps)
      const first = handlers.restoreCheckpoint('t1', 1)
      const second = handlers.restoreCheckpoint('t1', 1)
      // Give the microtask queue a turn: the second restore must NOT have
      // started (its checkpointRefs would have run).
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(refsCalls).toBe(1)

      release()
      const [r1] = await Promise.all([first, second])
      expect(r1.ok).toBe(true)
      // Both ran strictly sequentially: one kill per restore, never nested.
      expect(refsCalls).toBe(2)
      expect(deps.ptys.killAndWait).toHaveBeenCalledTimes(2)
    })
  })
})

describe('cross-clear restore (checkpoint in an OLD lineage file)', () => {
  it('cuts the file the ref names, not the current binding — and grows the lineage', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'restore-'))
    const cwd = path.join(tmp, 'project')
    // aa000000-0000-4000-8000-000000000006 ran before a /clear; aa000000-0000-4000-8000-000000000007 is the current binding.
    writeSession(cwd, 'aa000000-0000-4000-8000-000000000006', sessionLines('aa000000-0000-4000-8000-000000000006'), tmp)
    writeSession(cwd, 'aa000000-0000-4000-8000-000000000007', sessionLines('aa000000-0000-4000-8000-000000000007'), tmp)
    const node = makeNode({ cwd, claudeSessionId: 'aa000000-0000-4000-8000-000000000007', sessionLineage: ['aa000000-0000-4000-8000-000000000006'] })
    const { deps, calls } = makeDeps(() => node, {
      projectsDir: tmp,
      // Union rail: old segment (3 cps) + new segment; target = old cp 2.
      checkpointRefs: [
        { index: 1, id: U1, sessionId: 'aa000000-0000-4000-8000-000000000006' },
        { index: 2, id: U2, sessionId: 'aa000000-0000-4000-8000-000000000006' },
        { index: 3, id: U3, sessionId: 'aa000000-0000-4000-8000-000000000006' }
      ]
    })

    const result = await createRestoreHandlers(deps).restoreCheckpoint('t1', 2)

    expect(result.ok).toBe(true)
    // The truncated copy came from the OLD file: its kept lines carry the new
    // id but originate from aa000000-0000-4000-8000-000000000006's prompts (U2 cutoff).
    const newFile = path.join(claudeProjectDir(cwd, tmp), `${result.sessionId}.jsonl`)
    expect(existsSync(newFile)).toBe(true)
    const kept = readFileSync(newFile, 'utf8')
    expect(kept).toContain('prompt 2')
    expect(kept).not.toContain('prompt 3')
    // Lineage grew by the transition aa000000-0000-4000-8000-000000000007 -> restored-id (aa000000-0000-4000-8000-000000000006 was already there).
    expect(calls.updates[0]).toMatchObject({
      claudeSessionId: result.sessionId,
      sessionLineage: ['aa000000-0000-4000-8000-000000000006', 'aa000000-0000-4000-8000-000000000007']
    })
    // Both originals untouched.
    expect(existsSync(path.join(claudeProjectDir(cwd, tmp), 'aa000000-0000-4000-8000-000000000006.jsonl'))).toBe(true)
    expect(existsSync(path.join(claudeProjectDir(cwd, tmp), 'aa000000-0000-4000-8000-000000000007.jsonl'))).toBe(true)
  })
})
