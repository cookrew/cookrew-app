import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FIRST_RUN_CHANNELS, firstRunHandlers, registerFirstRunIpc } from '../src/main/first-run-ipc'
import { FirstRunStore } from '../src/main/first-run-store'
import { UNKNOWN_FACTS } from '../src/shared/preflight'
import { WorkspaceStore } from '../src/main/store'

/**
 * THE STAGE LIVES ON DISK, BESIDE THE APP'S OWN STATE: a reinstall of the
 * renderer's storage, a second window, or a restart mid-run must not raise a
 * screen again. The first read decides, and writes down what it decided.
 */

const fileIn = (): string => path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-first-run-')), 'first-run.json')
const nothing = { hasContent: () => false, hasAccount: () => false }

describe('the saved stage', () => {
  it('opens a fresh Mac at the tool check and writes that down', () => {
    const file = fileIn()
    expect(new FirstRunStore(file, nothing).read()).toBe('preflight')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ stage: 'preflight' })
  })

  it('closes for good on the first read of a Mac that has anything on it', () => {
    const file = fileIn()
    expect(new FirstRunStore(file, { ...nothing, hasContent: () => true }).read()).toBe('closed')
    // Everything deleted later is still not a new person.
    expect(new FirstRunStore(file, nothing).read()).toBe('closed')
  })

  it('closes for an account', () => {
    expect(new FirstRunStore(fileIn(), { ...nothing, hasAccount: () => true }).read()).toBe('closed')
  })

  it('survives a restart at any stage, content made along the way included', () => {
    const file = fileIn()
    const first = new FirstRunStore(file, nothing)
    first.read()
    first.advance('task')
    expect(new FirstRunStore(file, { ...nothing, hasContent: () => true }).read()).toBe('task')
  })

  it('refuses to go back, and answers where it is', () => {
    const file = fileIn()
    const store = new FirstRunStore(file, nothing)
    store.read()
    expect(store.advance('phone')).toBe('phone')
    expect(store.advance('task')).toBe('phone')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ stage: 'phone' })
  })

  it('reads a damaged file as no file, so the facts decide again', () => {
    const file = fileIn()
    writeFileSync(file, '{ not json')
    expect(new FirstRunStore(file, { ...nothing, hasContent: () => true }).read()).toBe('closed')
    writeFileSync(file, JSON.stringify({ stage: 'door' }))
    expect(new FirstRunStore(file, nothing).read()).toBe('preflight')
  })

  it('keeps working in memory when the disk refuses, and never throws', () => {
    const blocked = path.join(fileIn(), 'not-a-dir', 'first-run.json')
    writeFileSync(path.dirname(path.dirname(blocked)), 'a file where the folder should be')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = new FirstRunStore(blocked, nothing)
    expect(store.read()).toBe('preflight')
    expect(store.advance('task')).toBe('task')
    expect(existsSync(blocked)).toBe(false)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('fails closed when the facts cannot be read: an existing person must never see this', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = new FirstRunStore(fileIn(), { ...nothing, hasContent: () => { throw new Error('unreadable') } })
    expect(store.read()).toBe('closed')
    error.mockRestore()
  })
})

describe('what is a new install', () => {
  const base = (): string => mkdtempSync(path.join(tmpdir(), 'cookrew-first-run-reg-'))

  it('is a store that had no registry when it started', () => {
    expect(new WorkspaceStore(base()).freshInstall).toBe(true)
  })

  it('is never the second launch, even with every card deleted', () => {
    const dir = base()
    new WorkspaceStore(dir)
    const again = new WorkspaceStore(dir)
    expect(again.freshInstall).toBe(false)
    expect(again.hasContent()).toBe(false)
  })

  it('is never an install from before workspaces', () => {
    const dir = base()
    writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ name: 'Old', dir: tmpdir(), nodes: [], connections: [] }))
    expect(new WorkspaceStore(dir).freshInstall).toBe(false)
  })
})

describe('what counts as content', () => {
  const made = (): WorkspaceStore => new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'cookrew-first-run-ws-')))
  const note = {
    kind: 'note' as const,
    id: 'n1',
    name: 'n',
    customName: null,
    content: '',
    locked: false,
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 }
  }

  it('is nothing on the seeded workspace', () => {
    expect(made().hasContent()).toBe(false)
  })

  it('is any card, in the workspace in focus', () => {
    const store = made()
    store.addNode(note)
    expect(store.hasContent()).toBe(true)
  })

  it('is a second workspace, even an empty one', () => {
    const store = made()
    store.createWorkspace('Second', store.focusedState.dir)
    expect(store.hasContent()).toBe(true)
  })
})

describe('the bridge', () => {
  it('registers exactly the channel table: tests/ipc-channels.test.ts reads it as the registration', () => {
    const registered: string[] = []
    registerFirstRunIpc({ handle: (channel: string) => void registered.push(channel) }, { store: new FirstRunStore(fileIn(), nothing), probe: async () => UNKNOWN_FACTS })
    expect(registered).toEqual([...FIRST_RUN_CHANNELS])
  })

  it('moves only to a stage it knows, and answers where the run stands', () => {
    const handlers = firstRunHandlers({ store: new FirstRunStore(fileIn(), nothing), probe: async () => UNKNOWN_FACTS })
    expect(handlers.read()).toBe('preflight')
    expect(handlers.advance('task')).toBe('task')
    expect(handlers.advance('door')).toBe('task')
    expect(handlers.advance(null)).toBe('task')
  })

  it('answers rows from the facts', async () => {
    const handlers = firstRunHandlers({ store: new FirstRunStore(fileIn(), nothing), probe: async () => UNKNOWN_FACTS })
    expect((await handlers.preflight()).map((r) => r.state)).toEqual(Array(6).fill('unknown'))
  })
})
