import { beforeEach, describe, expect, it } from 'vitest'
import { remoteDraft, remotePlace, setRemoteDraft } from '../src/renderer/src/zoom/remote-machine-store'

/** Where the zoom view stands inside another machine, and the words kept for it (owner 2026-11-10, B). */

const SOLIS = { id: '0f8c7b1e-1234-4abc-9def-0123456789ab', name: 'Solis-Core', os: 'linux' }

describe('remotePlace', () => {
  beforeEach(() => remotePlace.leave())

  it('goes in a stop at a time, and out one stop at a time', () => {
    expect(remotePlace.get().machine).toBeNull()
    remotePlace.enter(SOLIS)
    remotePlace.workspace({ id: 'w-1', name: 'Box Lab' })
    remotePlace.agent({ id: 't-1', name: 'Herdr Env' })
    remotePlace.item({ id: 'b-1', title: 'Box', kind: 'browser' })
    expect(remotePlace.get()).toMatchObject({ machine: SOLIS, workspace: { id: 'w-1' }, agent: { id: 't-1' }, item: { id: 'b-1' } })
    expect(remotePlace.stepOut()).toBe(true)
    expect(remotePlace.get().item).toBeNull()
    expect(remotePlace.stepOut()).toBe(true)
    expect(remotePlace.get().agent).toBeNull()
    expect(remotePlace.stepOut()).toBe(true)
    expect(remotePlace.get().workspace).toBeNull()
    expect(remotePlace.stepOut()).toBe(true)
    expect(remotePlace.get().machine).toBeNull()
    // Outside every machine: nothing to step out of here, the zoom view's own steps take over.
    expect(remotePlace.stepOut()).toBe(false)
  })

  it('a crumb goes back to its depth; each change is a new state, and listeners hear it', () => {
    const heard: unknown[] = []
    const off = remotePlace.subscribe(() => heard.push(remotePlace.get()))
    remotePlace.enter(SOLIS)
    remotePlace.workspace({ id: 'w-1', name: 'Box Lab' })
    remotePlace.agent({ id: 't-1', name: 'Herdr Env' })
    const before = remotePlace.get()
    remotePlace.backTo(1)
    expect(remotePlace.get()).toMatchObject({ machine: SOLIS, workspace: null, agent: null })
    expect(before.agent).toEqual({ id: 't-1', name: 'Herdr Env' })
    remotePlace.backTo(0)
    expect(remotePlace.get().machine).toBeNull()
    off()
    expect(heard).toHaveLength(5)
  })

  it('a new workspace forgets the agent and item of the last one', () => {
    remotePlace.enter(SOLIS)
    remotePlace.workspace({ id: 'w-1', name: 'Box Lab' })
    remotePlace.agent({ id: 't-1', name: 'Herdr Env' })
    remotePlace.backTo(1)
    remotePlace.workspace({ id: 'w-2', name: 'Gauge' })
    expect(remotePlace.get()).toMatchObject({ workspace: { id: 'w-2' }, agent: null, item: null })
  })
})

describe('drafts: words typed for another machine stay, whatever happens to it', () => {
  it('per machine and per agent', () => {
    setRemoteDraft(SOLIS.id, 't-1', 'half a thought')
    expect(remoteDraft(SOLIS.id, 't-1')).toBe('half a thought')
    expect(remoteDraft(SOLIS.id, 't-2')).toBe('')
    expect(remoteDraft('other', 't-1')).toBe('')
    setRemoteDraft(SOLIS.id, 't-1', '')
    expect(remoteDraft(SOLIS.id, 't-1')).toBe('')
  })
})
