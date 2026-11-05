import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FirstRunStore } from '../src/main/first-run-store'
import { FirstTasks, type HoldHooks } from '../src/main/first-task'
import { waitOfScreen } from '../src/shared/first-run'

/**
 * A FIRST TASK IS NEVER LOST (round 2, bugs 3 and 4). The stage moves only when
 * the agent took the words. A dead agent gives them back with a reason, and a
 * waiting one says so, in a record that survives a restart.
 */

const fileIn = (): string => path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-first-task-')), 'first-run.json')
const nothing = { hasContent: () => false, hasAccount: () => false }

function rig(file = fileIn()) {
  const store = new FirstRunStore(file, nothing)
  store.read()
  store.advance('task')
  const session = new EventEmitter()
  let hooks: HoldHooks | null = null
  let settle: { done: () => void; fail: (e: Error) => void } | null = null
  const inject = vi.fn((_s: unknown, _w: string, h: HoldHooks) => {
    hooks = h
    return new Promise<void>((done, fail) => {
      settle = { done, fail }
    })
  })
  const removeCard = vi.fn()
  const emit = vi.fn()
  const tasks = new FirstTasks({ store, inject, session: () => session as never, removeCard, emit })
  return { store, session, inject, removeCard, emit, tasks, file, hooks: () => hooks as unknown as HoldHooks, settle: () => settle as unknown as { done: () => void; fail: (e: Error) => void } }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('holding the words', () => {
  it('keeps them on disk from the moment they are sent', () => {
    const r = rig()
    r.tasks.hold('a1', 'write a readme', 'Claude Code')
    expect(JSON.parse(readFileSync(r.file, 'utf8')).task).toMatchObject({ state: 'holding', id: 'a1', words: 'write a readme', wait: 'starting' })
    expect(r.store.read()).toBe('task')
  })

  // The turn can still be refused after the words went in (Part C, C-3), so
  // delivery alone moves nothing: the screens step aside, the stage stays.
  it('marks them sent when the agent took them, with the stage where it was', async () => {
    const r = rig()
    r.tasks.hold('a1', 'write a readme', 'Claude Code')
    r.settle().done()
    await tick()
    expect(r.store.read()).toBe('task')
    expect(r.store.task()).toEqual({ state: 'sent', id: 'a1', words: 'write a readme', harness: 'Claude Code' })
    expect(r.removeCard).not.toHaveBeenCalled()
  })

  it('says what the agent is waiting on, once per change', () => {
    const r = rig()
    r.tasks.hold('a1', 'x', 'Claude Code')
    r.emit.mockClear()
    r.hooks().onWait('Choose the text style that looks best with your terminal')
    r.hooks().onWait('Choose the text style that looks best with your terminal')
    expect(r.store.task()).toMatchObject({ wait: 'choice' })
    expect(r.emit).toHaveBeenCalledTimes(1)
    r.hooks().onWait('Select login method:')
    expect(r.store.task()).toMatchObject({ wait: 'sign-in' })
  })
})

describe('an agent that dies', () => {
  it('gives the words back with a reason, leaves the stage, and clears its card', async () => {
    const r = rig()
    r.tasks.hold('a1', 'write a readme', 'Claude Code')
    r.session.emit('exit', 127)
    expect(r.hooks().gone()).toBe(true)
    r.settle().fail(new Error('gone'))
    await tick()
    expect(r.store.read()).toBe('task')
    expect(r.store.task()).toMatchObject({ state: 'returned', words: 'write a readme' })
    expect((r.store.task() as { why: string }).why).toMatch(/Claude Code stopped before it took your task/)
    expect(r.removeCard).toHaveBeenCalledWith('a1')
  })

  it('names a tool that was not there', async () => {
    const r = rig()
    r.tasks.hold('a1', 'x', 'Codex')
    r.hooks().onWait('sh: exec: codex: not found')
    r.settle().fail(new Error('gone'))
    await tick()
    expect((r.store.task() as { why: string }).why).toMatch(/Codex could not start/)
  })

  it('gives the words back at once when there is no session at all', () => {
    const store = new FirstRunStore(fileIn(), nothing)
    store.read()
    store.advance('task')
    const tasks = new FirstTasks({ store, inject: vi.fn(), session: () => null, removeCard: vi.fn(), emit: vi.fn() })
    tasks.hold('a1', 'x', 'Claude Code')
    expect(store.task()).toMatchObject({ state: 'returned', words: 'x' })
  })
})

describe('an agent that took the task', () => {
  const sent = async () => {
    const r = rig()
    r.tasks.hold('a1', 'write a readme', 'Claude Code')
    r.settle().done()
    await tick()
    return r
  }

  it('forgets the task once a good turn moves the stage on', async () => {
    const r = await sent()
    r.store.advance('second')
    expect(r.store.task()).toBeNull()
  })

  it('gives the words back if it dies mid-turn, the stage where it was', async () => {
    const r = await sent()
    r.session.emit('exit', 1)
    expect(r.store.read()).toBe('task')
    expect(r.store.task()).toMatchObject({ state: 'returned', words: 'write a readme' })
    expect(r.removeCard).toHaveBeenCalledWith('a1')
  })

  it('keeps the card when the person starts over from a refused turn: it may hold real work', async () => {
    const r = await sent()
    r.tasks.discard()
    expect(r.store.task()).toEqual({ state: 'returned', words: 'write a readme', why: null, id: 'a1' })
    expect(r.removeCard).not.toHaveBeenCalled()
  })

  it('does not read quitting as a death', async () => {
    const r = await sent()
    r.tasks.stop()
    r.session.emit('exit', 0)
    expect(r.store.task()).toMatchObject({ state: 'sent' })
  })

  it('picks the watch up again after a restart, or gives the words back', () => {
    const file = fileIn()
    const first = new FirstRunStore(file, nothing)
    first.read()
    first.advance('task')
    first.setTask({ state: 'sent', id: 'a1', words: 'x', harness: 'Pi' })
    const session = new EventEmitter()
    const store = new FirstRunStore(file, nothing)
    const inject = vi.fn()
    new FirstTasks({ store, inject, session: () => session as never, removeCard: vi.fn(), emit: vi.fn() }).resume()
    expect(inject).not.toHaveBeenCalled()
    expect(store.task()).toMatchObject({ state: 'sent' })
    session.emit('exit', 1)
    expect(store.task()).toMatchObject({ state: 'returned', words: 'x' })
    const gone = new FirstRunStore(file, nothing)
    gone.setTask({ state: 'sent', id: 'a1', words: 'y', harness: 'Pi' })
    new FirstTasks({ store: gone, inject, session: () => null, removeCard: vi.fn(), emit: vi.fn() }).resume()
    expect(gone.task()).toMatchObject({ state: 'returned', words: 'y' })
  })
})

describe('changing your mind', () => {
  it('gives the words back with no reason and closes the agent', async () => {
    const r = rig()
    r.tasks.hold('a1', 'x', 'Claude Code')
    r.tasks.discard()
    expect(r.store.task()).toEqual({ state: 'returned', words: 'x', why: null, id: 'a1' })
    expect(r.removeCard).toHaveBeenCalledWith('a1')
    r.settle().fail(new Error('gone'))
    await tick()
    expect(r.store.task()).toEqual({ state: 'returned', words: 'x', why: null, id: 'a1' })
  })

  it('a new send replaces a returned task', () => {
    const r = rig()
    r.tasks.hold('a1', 'old', 'Claude Code')
    r.tasks.discard()
    r.tasks.hold('a2', 'new', 'Claude Code')
    expect(r.store.task()).toMatchObject({ state: 'holding', id: 'a2', words: 'new' })
  })
})

describe('quitting mid-wait', () => {
  it('leaves the record for the next launch: a pane going down with the app is no dead agent', async () => {
    const r = rig()
    r.tasks.hold('a1', 'write a readme', 'Claude Code')
    r.tasks.stop()
    r.session.emit('exit', 0)
    r.settle().fail(new Error('gone'))
    await tick()
    expect(r.store.task()).toMatchObject({ state: 'holding', id: 'a1', words: 'write a readme' })
    expect(r.removeCard).not.toHaveBeenCalled()
  })
})

describe('a restart mid-wait', () => {
  it('holds on for the same agent', () => {
    const file = fileIn()
    const first = rig(file)
    first.tasks.hold('a1', 'write a readme', 'Claude Code')
    const store = new FirstRunStore(file, nothing)
    const inject = vi.fn(() => new Promise<void>(() => undefined))
    const tasks = new FirstTasks({ store, inject, session: () => new EventEmitter() as never, removeCard: vi.fn(), emit: vi.fn() })
    tasks.resume()
    tasks.resume()
    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject.mock.calls[0]?.[1 as never]).toBe('write a readme')
  })

  it('gives the words back when the agent did not survive', () => {
    const file = fileIn()
    rig(file).tasks.hold('a1', 'write a readme', 'Claude Code')
    const store = new FirstRunStore(file, nothing)
    new FirstTasks({ store, inject: vi.fn(), session: () => null, removeCard: vi.fn(), emit: vi.fn() }).resume()
    expect(store.task()).toMatchObject({ state: 'returned', words: 'write a readme' })
  })

  it('reads a damaged task as none', () => {
    const file = fileIn()
    writeFileSync(file, JSON.stringify({ stage: 'task', task: { state: 'holding', id: 3 } }))
    expect(new FirstRunStore(file, nothing).task()).toBeNull()
  })
})

describe('the dirs the check found', () => {
  it('survive a relaunch, so panes have them before any check runs', () => {
    const file = fileIn()
    const store = new FirstRunStore(file, nothing)
    store.read()
    store.rememberDirs(['/home/new/.nvm/bin'])
    expect(new FirstRunStore(file, nothing).dirs()).toEqual(['/home/new/.nvm/bin'])
  })
})

describe('what the screen is asking', () => {
  it('tells a sign-in from a choice, and the bypass consent from both', () => {
    expect(waitOfScreen('Select login method:')).toBe('sign-in')
    expect(waitOfScreen('Sign in with ChatGPT')).toBe('sign-in')
    expect(waitOfScreen('Choose the text style that looks best with your terminal')).toBe('choice')
    expect(waitOfScreen('WARNING: Claude Code running in Bypass Permissions mode')).toBe('consent')
  })
})
