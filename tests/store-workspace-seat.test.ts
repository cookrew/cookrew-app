import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceStore } from '../src/main/store'
import type { NoteNodeData, TerminalNodeData } from '../src/shared/model'

/**
 * A DEVICE'S SEAT (box user test 2, bug 10; owner ruling 11-04). Focus was one
 * value for every device, so a phone choosing a workspace moved the desktop.
 * A seat is what ONE request is looking at: everything the request reads and
 * writes lands in the seat's workspace, and the desktop's focus does not move.
 */

const store = (): WorkspaceStore =>
  new WorkspaceStore(path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-seat-')), 'data'), { multiInstance: true })

const terminal = (id: string): TerminalNodeData => ({
  kind: 'terminal', id, name: id, preset: 'Shell', command: 'zsh', cwd: '/tmp',
  orch: false, role: null, position: { x: 0, y: 0 }, size: { width: 640, height: 420 }
})

describe('a seat', () => {
  it('reads the seat\'s workspace, and only inside the request', async () => {
    const s = store()
    const desk = s.focusedId
    const other = s.createWorkspace('Other', '/tmp').id
    await s.inSeat(other, async () => {
      await Promise.resolve()
      expect(s.focusedId).toBe(other)
      expect(s.focusedState.name).toBe('Other')
      expect(s.list().activeId).toBe(other)
    })
    expect(s.focusedId).toBe(desk)
    expect(s.list().activeId).toBe(desk)
  })

  it('lands a write in the seat\'s workspace and leaves the desktop\'s canvas alone', async () => {
    const s = store()
    const desk = s.focusedId
    const other = s.createWorkspace('Other', '/tmp').id
    const change = vi.fn()
    s.on('change', change)
    await s.inSeat(other, async () => s.addNode(terminal('t1')))
    expect(s.workspaceState(other).nodes.map((n) => n.id)).toEqual(['t1'])
    expect(s.workspaceState(desk).nodes).toEqual([])
    expect(change).not.toHaveBeenCalled()
  })

  it('tells a tagged listener about the seat\'s write', async () => {
    const s = store()
    const other = s.createWorkspace('Other', '/tmp').id
    const tagged = vi.fn()
    s.on('workspace-change', tagged)
    await s.inSeat(other, async () => s.addNode(terminal('t1')))
    expect(tagged).toHaveBeenCalledTimes(1)
    expect(tagged.mock.calls[0][0].workspaceId).toBe(other)
  })

  it('never lets a listener hear the seat as focus: the desktop\'s push stays the desktop\'s', async () => {
    const s = store()
    const desk = s.focusedId
    const other = s.createWorkspace('Other', '/tmp').id
    const lists: string[] = []
    const seen: string[] = []
    s.on('workspaces', (list: { activeId: string }) => lists.push(list.activeId))
    s.on('change', () => seen.push(s.focusedState.name))
    await s.inSeat(other, async () => s.renameWorkspace(desk, 'Desk'))
    expect(lists).toEqual([desk])
    expect(seen).toEqual(['Desk'])
  })

  it('falls back to the desktop\'s focus when its workspace has gone', async () => {
    const s = store()
    const desk = s.focusedId
    const other = s.createWorkspace('Other', '/tmp').id
    s.removeWorkspace(other)
    await s.inSeat(other, async () => expect(s.focusedId).toBe(desk))
  })

  it('takes an entered seat for the rest of a request', async () => {
    const s = store()
    const other = s.createWorkspace('Other', '/tmp').id
    await new Promise<void>((resolve) => {
      setImmediate(async () => {
        s.enterSeat(other)
        await Promise.resolve()
        expect(s.focusedId).toBe(other)
        resolve()
      })
    })
  })
})

describe('the first seat of a boot', () => {
  it('is not inherited by work that was already waiting', async () => {
    const s = store()
    const other = s.createWorkspace('Other', '/tmp').id
    const desk = s.focusedId
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const waiting = gate.then(() => s.focusedId)
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        s.enterSeat(other)
        release()
        resolve()
      })
    })
    expect(await waiting).toBe(desk)
  })
})

describe('workspace name and icon', () => {
  it('renames, trimming the words', () => {
    const s = store()
    const id = s.createWorkspace('Alpha', '/tmp').id
    s.renameWorkspace(id, '  Beta  ')
    expect(s.list().workspaces.find((w) => w.id === id)?.name).toBe('Beta')
  })

  it('refuses a blank name and one another workspace holds, in a sentence', () => {
    const s = store()
    const id = s.createWorkspace('Alpha', '/tmp').id
    s.createWorkspace('Beta', '/tmp')
    expect(() => s.renameWorkspace(id, '   ')).toThrow('Give the workspace a name.')
    expect(() => s.renameWorkspace(id, 'beta')).toThrow('Another workspace is already called "Beta".')
  })

  it('takes a change of case on its own name', () => {
    const s = store()
    const id = s.createWorkspace('Alpha', '/tmp').id
    s.renameWorkspace(id, 'ALPHA')
    expect(s.list().workspaces.find((w) => w.id === id)?.name).toBe('ALPHA')
  })

  it('sets an icon, and it survives a reload', () => {
    const base = path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-icon-')), 'data')
    const s = new WorkspaceStore(base, { multiInstance: true })
    const id = s.createWorkspace('Alpha', '/tmp').id
    s.setWorkspaceIcon(id, '🚀')
    expect(new WorkspaceStore(base, { multiInstance: true }).list().workspaces.find((w) => w.id === id)?.icon).toBe('🚀')
  })

  it('refuses an icon that is not one short mark', () => {
    const s = store()
    const id = s.createWorkspace('Alpha', '/tmp').id
    expect(() => s.setWorkspaceIcon(id, '')).toThrow('Pick one icon.')
    expect(() => s.setWorkspaceIcon(id, 'a whole sentence')).toThrow('Pick one icon.')
  })
})

describe('a note named by the old rule', () => {
  it('keeps that name until its first line really changes, so an agent can still reach it', () => {
    const s = store()
    s.addNode({ kind: 'note', id: 'n', name: 'hello-world', content: '# Hello World', position: { x: 0, y: 0 }, size: { width: 300, height: 200 } } as NoteNodeData)
    expect(s.writeNote('n', '# Hello World\nmore words')?.name).toBe('hello-world')
    expect(s.writeNote('n', '# Goodbye')?.name).toBe('Goodbye')
  })
})

describe('deleting a note (bug 12)', () => {
  const note = (id: string): NoteNodeData => ({
    kind: 'note', id, name: 'plan', content: 'secret words', position: { x: 0, y: 0 }, size: { width: 300, height: 200 }
  } as NoteNodeData)
  const fileOf = (s: WorkspaceStore, id: string): string =>
    path.join(s.baseDirForTests, 'workspaces', s.focusedId, 'notes', `${id}.md`)
  const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

  it('removes the .md, so the words are really gone', async () => {
    const s = store()
    s.addNode(note('n1'))
    await settled()
    expect(readFileSync(fileOf(s, 'n1'), 'utf8')).toBe('secret words')
    s.removeNode('n1')
    await settled()
    expect(existsSync(fileOf(s, 'n1'))).toBe(false)
  })

  it('removes it even with a write still in flight', async () => {
    const s = store()
    s.addNode(note('n2'))
    s.writeNote('n2', 'newer words')
    s.removeNode('n2')
    await settled()
    expect(existsSync(fileOf(s, 'n2'))).toBe(false)
  })

  it('removes the file of a note in a workspace nobody is looking at', async () => {
    const s = store()
    const other = s.createWorkspace('Other', '/tmp').id
    s.addNodeToWorkspace(other, note('n3'))
    await settled()
    const file = path.join(s.baseDirForTests, 'workspaces', other, 'notes', 'n3.md')
    expect(existsSync(file)).toBe(true)
    await s.inSeat(other, async () => s.removeNode('n3'))
    await settled()
    expect(existsSync(file)).toBe(false)
  })
})
